-- ============================================================
--  사랑의교회 청년부 한반도이웃사랑선교국 2026 짝기도 매칭 · Supabase 스키마
--  Supabase 대시보드 > SQL Editor 에 붙여넣고 실행하세요.
-- ============================================================

-- 1. 참가자 -------------------------------------------------
create table if not exists public.participants (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  team            text not null,
  prayer_request  text not null,
  created_at      timestamptz not null default now()
);

create index if not exists participants_created_at_idx
  on public.participants (created_at);

-- 2. 매칭 회차 ----------------------------------------------
--    매칭을 실행할 때마다 새 회차가 쌓이고, 가장 최근 확정 회차만
--    is_active = true 를 유지합니다. (/display 는 이 회차를 봅니다)
create table if not exists public.match_rounds (
  id           uuid primary key default gen_random_uuid(),
  mode         text not null,              -- 'team' | 'random'
  target_size  smallint not null,          -- 2~10
  is_active    boolean not null default false,
  created_at   timestamptz not null default now()
);

create unique index if not exists match_rounds_single_active_idx
  on public.match_rounds (is_active) where is_active;

-- 3. 조 ------------------------------------------------------
create table if not exists public.match_groups (
  id            uuid primary key default gen_random_uuid(),
  round_id      uuid not null references public.match_rounds(id) on delete cascade,
  group_number  int not null,
  unique (round_id, group_number)
);

-- 4. 조원 ----------------------------------------------------
create table if not exists public.match_members (
  group_id        uuid not null references public.match_groups(id) on delete cascade,
  participant_id  uuid not null references public.participants(id) on delete cascade,
  seq             smallint not null default 0,
  primary key (group_id, participant_id)
);

-- ============================================================
--  RLS: 익명 사용자는 "제출"과 "조회"만 가능.
--  매칭 실행/삭제는 서버 액션이 service_role 키로 수행하며
--  service_role 은 RLS 를 우회합니다.
-- ============================================================
alter table public.participants  enable row level security;
alter table public.match_rounds  enable row level security;
alter table public.match_groups  enable row level security;
alter table public.match_members enable row level security;

drop policy if exists "anon can insert participants" on public.participants;
create policy "anon can insert participants"
  on public.participants for insert to anon, authenticated with check (true);

drop policy if exists "anon can read participants" on public.participants;
create policy "anon can read participants"
  on public.participants for select to anon, authenticated using (true);

drop policy if exists "anon can read rounds" on public.match_rounds;
create policy "anon can read rounds"
  on public.match_rounds for select to anon, authenticated using (true);

drop policy if exists "anon can read groups" on public.match_groups;
create policy "anon can read groups"
  on public.match_groups for select to anon, authenticated using (true);

drop policy if exists "anon can read members" on public.match_members;
create policy "anon can read members"
  on public.match_members for select to anon, authenticated using (true);

-- ============================================================
--  Realtime: /display 와 /admin 이 변경을 즉시 받도록 발행
-- ============================================================
alter publication supabase_realtime add table public.participants;
alter publication supabase_realtime add table public.match_rounds;
alter publication supabase_realtime add table public.match_groups;
alter publication supabase_realtime add table public.match_members;


-- Add only unmatched participants; keep existing groups and members untouched.
create or replace function public.append_prayer_members(p_round_id uuid, p_assignments jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pending uuid[];
  v_requested uuid[];
  v_count integer;
begin
  -- Short transaction: serialize assignment and keep the checked roster stable.
  lock table public.participants in share mode;
  lock table public.match_rounds, public.match_groups, public.match_members in share row exclusive mode;

  if not exists (select 1 from public.match_rounds where id = p_round_id and is_active) then
    raise exception 'Active round changed' using errcode = '40001';
  end if;

  if jsonb_typeof(p_assignments) is distinct from 'array' then
    raise exception 'Assignments must be an array' using errcode = '22023';
  end if;

  select coalesce(array_agg(p.id order by p.id), '{}'::uuid[]) into v_pending
  from public.participants p
  where not exists (
    select 1 from public.match_members m
    join public.match_groups g on g.id = m.group_id
    where g.round_id = p_round_id and m.participant_id = p.id
  );

  select coalesce(array_agg(a.participant_id order by a.participant_id), '{}'::uuid[]) into v_requested
  from jsonb_to_recordset(p_assignments) as a(participant_id uuid, group_number integer);

  -- Includes duplicate checks and prevents saving a stale roster after another draw/signup.
  if v_pending is distinct from v_requested then
    raise exception 'Pending participants changed' using errcode = '40001';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_assignments) as a(participant_id uuid, group_number integer)
    where a.group_number is null or a.group_number < 1
  ) then
    raise exception 'Invalid group number' using errcode = '22023';
  end if;

  insert into public.match_groups (round_id, group_number)
  select distinct p_round_id, a.group_number
  from jsonb_to_recordset(p_assignments) as a(participant_id uuid, group_number integer)
  on conflict (round_id, group_number) do nothing;

  insert into public.match_members (group_id, participant_id, seq)
  select g.id, a.participant_id,
    (coalesce((select max(m.seq) from public.match_members m where m.group_id = g.id), -1)
      + row_number() over (partition by g.id order by a.participant_id))::smallint
  from jsonb_to_recordset(p_assignments) as a(participant_id uuid, group_number integer)
  join public.match_groups g on g.round_id = p_round_id and g.group_number = a.group_number;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.append_prayer_members(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.append_prayer_members(uuid, jsonb) to service_role;


-- Synchronized event operations and participant editing.
-- Every application mutation takes the same row lock before reading or writing.
create table public.match_control (
  id boolean primary key default true check (id),
  revision bigint not null default 0,
  draw_started_at timestamptz
);
insert into public.match_control(id, draw_started_at)
values (true, case when exists(select 1 from public.match_rounds where is_active) then now() - interval '1 day' end);
alter table public.match_control enable row level security;
create policy "read event control" on public.match_control for select to anon, authenticated using (true);
grant select on public.match_control to anon, authenticated;
grant all on public.match_control to service_role;
alter publication supabase_realtime add table public.match_control;
alter table public.participants add column edit_version bigint not null default 0;

create function public.prayer_add_pending() returns integer
language plpgsql security invoker set search_path = '' as $$
declare r public.match_rounds; p public.participants; gid uuid; added integer := 0;
begin
  perform 1 from public.match_control where id for update;
  select * into r from public.match_rounds where is_active;
  if r.id is null then return 0; end if;
  for p in select * from public.participants candidate where not exists (
    select 1 from public.match_members m join public.match_groups g on g.id=m.group_id
    where g.round_id=r.id and m.participant_id=candidate.id
  ) order by candidate.created_at,candidate.id loop
    select g.id into gid from public.match_groups g
    left join public.match_members m on m.group_id=g.id
    left join public.participants existing on existing.id=m.participant_id
    where g.round_id=r.id group by g.id
    order by count(m.participant_id),
      case when r.mode='team' then count(*) filter (where existing.team=p.team) else 0 end,
      random() limit 1;
    if gid is null then raise exception 'Active round has no groups'; end if;
    insert into public.match_members(group_id,participant_id,seq)
    select gid,p.id,coalesce(max(seq),-1)+1 from public.match_members where group_id=gid;
    added := added+1;
  end loop;
  return added;
end $$;

create function public.prayer_register(p_name text,p_team text,p_prayer text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare pid uuid;
begin
  perform 1 from public.match_control where id for update;
  if length(trim(p_name)) not between 1 and 20 or length(trim(p_prayer)) not between 1 and 500 or length(trim(p_team))=0 then
    raise exception 'Invalid participant';
  end if;
  insert into public.participants(name,team,prayer_request) values(p_name,p_team,p_prayer) returning id into pid;
  perform public.prayer_add_pending();
  update public.match_control set revision=revision+1 where id;
  return pid;
end $$;

create function public.prayer_edit(p_id uuid,p_version bigint,p_name text,p_team text,p_prayer text) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare v bigint;
begin
  perform 1 from public.match_control where id for update;
  if length(trim(p_name)) not between 1 and 20 or length(trim(p_prayer)) not between 1 and 500 or length(trim(p_team))=0 then
    raise exception 'Invalid participant';
  end if;
  update public.participants set name=p_name,team=p_team,prayer_request=p_prayer,edit_version=edit_version+1
  where id=p_id and edit_version=p_version returning edit_version into v;
  if v is null then raise exception 'Participant changed' using errcode='40001'; end if;
  update public.match_control set revision=revision+1 where id;
  return v;
end $$;

create function public.prayer_command(p_revision bigint,p_operation text,p_payload jsonb default '{}'::jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare v bigint; rid uuid; a jsonb; gid uuid; roster uuid[]; requested uuid[];
begin
  select revision into v from public.match_control where id for update;
  if p_revision is distinct from v then raise exception 'Event changed' using errcode='40001'; end if;
  if p_operation='publish' then
    if exists(select 1 from public.match_rounds where is_active) and coalesce(p_payload->>'confirm','') <> '재편성' then
      raise exception 'Existing groups require explicit replacement';
    end if;
    if (p_payload->>'target')::int not between 2 and 10 or p_payload->>'mode' not in ('team','random') then raise exception 'Invalid settings'; end if;
    select array_agg(id order by id) into roster from public.participants;
    select array_agg((x->>'participant_id')::uuid order by (x->>'participant_id')::uuid) into requested
    from jsonb_array_elements(p_payload->'assignments') x;
    if roster is null or roster is distinct from requested then raise exception 'Roster changed' using errcode='40001'; end if;
    if exists(select 1 from jsonb_array_elements(p_payload->'assignments') x where coalesce((x->>'group_number')::int,0)<1) then raise exception 'Invalid group'; end if;
    insert into public.match_rounds(mode,target_size,is_active) values(p_payload->>'mode',(p_payload->>'target')::smallint,false) returning id into rid;
    for a in select distinct x->'group_number' from jsonb_array_elements(p_payload->'assignments') x loop
      insert into public.match_groups(round_id,group_number) values(rid,a::int) returning id into gid;
      insert into public.match_members(group_id,participant_id,seq)
      select gid,(x->>'participant_id')::uuid,(row_number() over ())-1
      from jsonb_array_elements(p_payload->'assignments') x where x->'group_number'=a;
    end loop;
    update public.match_rounds set is_active=false where is_active;
    update public.match_rounds set is_active=true where id=rid;
    update public.match_control set draw_started_at=null where id;
  elsif p_operation='draw' then
    if not exists(select 1 from public.match_rounds where is_active) then raise exception 'No active round'; end if;
    perform public.prayer_add_pending();
    update public.match_control set draw_started_at=clock_timestamp() where id;
  elsif p_operation='unpublish' then
    update public.match_rounds set is_active=false where is_active;
    update public.match_control set draw_started_at=null where id;
  elsif p_operation='delete' then
    delete from public.participants where id=(p_payload->>'id')::uuid;
  elsif p_operation='reset' and p_payload->>'confirm'='삭제' then
    delete from public.match_rounds;
    delete from public.participants;
    update public.match_control set draw_started_at=null where id;
  else raise exception 'Invalid operation';
  end if;
  update public.match_control set revision=revision+1 where id;
end $$;

-- A single SQL statement gives all consumers the same MVCC snapshot.
create function public.prayer_snapshot() returns jsonb
language sql stable security invoker set search_path = '' as $$
select jsonb_build_object(
  'revision',c.revision,'drawStartedAt',c.draw_started_at,'serverTime',now(),
  'participants',coalesce((select jsonb_agg(p order by p.created_at desc,p.id) from public.participants p),'[]'::jsonb),
  'round',(select jsonb_build_object('id',r.id,'mode',r.mode,'targetSize',r.target_size,'createdAt',r.created_at,
    'groups',coalesce((select jsonb_agg(jsonb_build_object('groupNumber',g.group_number,
      'members',coalesce((select jsonb_agg(p order by m.seq) from public.match_members m join public.participants p on p.id=m.participant_id where m.group_id=g.id),'[]'::jsonb)) order by g.group_number)
      from public.match_groups g where g.round_id=r.id),'[]'::jsonb)) from public.match_rounds r where r.is_active)
) from public.match_control c where c.id;
$$;

-- Old application instances must refresh instead of using the former new-group algorithm.
create or replace function public.append_prayer_members(p_round_id uuid,p_assignments jsonb) returns integer
language plpgsql security invoker set search_path = '' as $$
begin raise exception 'Please refresh the application' using errcode='0A000'; end $$;

revoke all on function public.prayer_add_pending(),public.prayer_register(text,text,text),public.prayer_edit(uuid,bigint,text,text,text),public.prayer_command(bigint,text,jsonb),public.prayer_snapshot() from public,anon,authenticated;
grant execute on function public.prayer_add_pending(),public.prayer_register(text,text,text),public.prayer_edit(uuid,bigint,text,text,text),public.prayer_command(bigint,text,jsonb) to service_role;
grant execute on function public.prayer_snapshot() to anon,authenticated,service_role;
