-- Registrations wait for an explicit append. Draw only reveals saved groups.
-- Prevent direct inserts from bypassing the shared transaction/revision protocol.
drop policy if exists "anon can insert participants" on public.participants;
revoke insert on public.participants from anon, authenticated;

create function public.prayer_append(p_revision bigint) returns integer
language plpgsql security invoker set search_path = '' as $$
declare v bigint; added integer;
begin
  select revision into v from public.match_control where id for update;
  if p_revision is distinct from v then raise exception 'Event changed' using errcode='40001'; end if;
  if not exists(select 1 from public.match_rounds where is_active) then
    raise exception 'Create groups first' using errcode='P0002';
  end if;
  added := public.prayer_add_pending();
  if added > 0 then update public.match_control set revision=revision+1 where id; end if;
  return added;
end $$;
revoke all on function public.prayer_append(bigint) from public, anon, authenticated;
grant execute on function public.prayer_append(bigint) to service_role;

-- A retry of the same browser request returns the original record. Keep request
-- keys private: a public idempotency key must never grant participant ownership.
create table public.participant_submissions (
  request_id uuid primary key,
  participant_id uuid not null references public.participants(id) on delete cascade
);
alter table public.participant_submissions enable row level security;
revoke all on public.participant_submissions from public, anon, authenticated;
grant all on public.participant_submissions to service_role;
create index participant_submissions_participant_idx on public.participant_submissions(participant_id);

create function public.prayer_submit(p_request_id uuid,p_name text,p_team text,p_prayer text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare pid uuid;
begin
  if p_request_id is null then raise exception 'Missing submission request'; end if;
  perform 1 from public.match_control where id for update;
  select participant_id into pid from public.participant_submissions where request_id=p_request_id;
  if pid is not null then return pid; end if;
  pid := public.prayer_register(p_name,p_team,p_prayer);
  insert into public.participant_submissions(request_id,participant_id) values(p_request_id,pid);
  return pid;
end $$;
revoke all on function public.prayer_submit(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.prayer_submit(uuid,text,text,text) to service_role;

create or replace function public.prayer_register(p_name text,p_team text,p_prayer text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare pid uuid;
begin
  perform 1 from public.match_control where id for update;
  if length(trim(p_name)) not between 1 and 20 or length(trim(p_prayer)) not between 1 and 500 or length(trim(p_team))=0 then
    raise exception 'Invalid participant';
  end if;
  insert into public.participants(name,team,prayer_request) values(p_name,p_team,p_prayer) returning id into pid;
  update public.match_control set revision=revision+1 where id;
  return pid;
end $$;

create or replace function public.prayer_command(p_revision bigint,p_operation text,p_payload jsonb default '{}'::jsonb) returns void
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
