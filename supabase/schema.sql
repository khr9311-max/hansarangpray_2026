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
