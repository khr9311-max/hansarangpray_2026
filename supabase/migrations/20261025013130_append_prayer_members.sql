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
