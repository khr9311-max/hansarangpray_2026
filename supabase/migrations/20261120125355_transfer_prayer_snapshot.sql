-- Copy a complete Sheets snapshot while the former Supabase store is frozen.

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_trigger
    where tgname = 'prayer_sheets_read_only' and tgrelid = 'public.match_control'::regclass
  ) then
    create trigger prayer_sheets_read_only
      before insert or update or delete or truncate on public.prayer_checkins
      for each statement execute function public.reject_legacy_prayer_writes();
  end if;
end;
$$;

create function public.prayer_export()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'participants', coalesce((select jsonb_agg(p) from public.participants p), '[]'::jsonb),
    'match_rounds', coalesce((select jsonb_agg(r) from public.match_rounds r), '[]'::jsonb),
    'match_groups', coalesce((select jsonb_agg(g) from public.match_groups g), '[]'::jsonb),
    'match_members', coalesce((select jsonb_agg(m) from public.match_members m), '[]'::jsonb),
    'match_control', coalesce((select jsonb_agg(c) from public.match_control c), '[]'::jsonb),
    'participant_submissions', coalesce((select jsonb_agg(s) from public.participant_submissions s), '[]'::jsonb),
    'prayer_checkins', coalesce((select jsonb_agg(w) from public.prayer_checkins w), '[]'::jsonb)
  );
$$;

create function public.prayer_import(p_state jsonb, p_expected_revision bigint, p_allow_replace boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_control public.match_control;
  next_control public.match_control;
  table_name text;
  table_names constant text[] := array[
    'participants', 'match_rounds', 'match_groups', 'match_members',
    'match_control', 'participant_submissions', 'prayer_checkins'
  ];
  row_counts jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_state) is distinct from 'object' then
    raise exception 'Invalid snapshot' using errcode = '22023';
  end if;
  foreach table_name in array table_names loop
    if jsonb_typeof(p_state -> table_name) is distinct from 'array' then
      raise exception 'Missing snapshot table %', table_name using errcode = '22023';
    end if;
    row_counts := row_counts || jsonb_build_object(table_name, jsonb_array_length(p_state -> table_name));
  end loop;
  if jsonb_array_length(p_state -> 'match_control') <> 1 then
    raise exception 'Snapshot must include one event control row' using errcode = '22023';
  end if;
  select * into next_control from jsonb_populate_recordset(null::public.match_control, p_state -> 'match_control');
  if next_control.id is distinct from true or next_control.revision is null or next_control.revision < 0 then
    raise exception 'Invalid snapshot event control row' using errcode = '22023';
  end if;

  select * into current_control from public.match_control where id for update;
  if not found or current_control.revision is distinct from p_expected_revision then
    raise exception 'Target event revision changed' using errcode = '40001';
  end if;
  if (
    select count(*)
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    where c.relnamespace = 'public'::regnamespace and c.relname = any(table_names)
      and t.tgname = 'prayer_sheets_read_only'
      and t.tgfoid = 'public.reject_legacy_prayer_writes()'::regprocedure
      and t.tgenabled = 'O'
  ) <> cardinality(table_names) then
    raise exception 'Target must be frozen before importing' using errcode = '55000';
  end if;
  if p_allow_replace is not true and (
    current_control.revision <> 0 or current_control.draw_started_at is not null
    or exists (select 1 from public.participants)
    or exists (select 1 from public.match_rounds)
  ) then
    raise exception 'Replacing a populated target requires confirmation' using errcode = '55000';
  end if;

  -- Only the table owner can temporarily disable these triggers. The table
  -- locks and catalog changes are held until commit, so other transactions
  -- cannot write while the import runs. A failure rolls back the trigger DDL
  -- along with the data changes.
  foreach table_name in array table_names loop
    execute format('alter table public.%I disable trigger prayer_sheets_read_only', table_name);
  end loop;

  -- Dependent groups, members, request IDs, and check-ins cascade from parents.
  delete from public.match_rounds;
  delete from public.participants;
  insert into public.participants (id, name, team, prayer_request, created_at, edit_version)
    select id, name, team, prayer_request, created_at, edit_version
    from jsonb_populate_recordset(null::public.participants, p_state -> 'participants');
  insert into public.match_rounds (id, mode, target_size, is_active, created_at)
    select id, mode, target_size, is_active, created_at
    from jsonb_populate_recordset(null::public.match_rounds, p_state -> 'match_rounds');
  insert into public.match_groups (id, round_id, group_number)
    select id, round_id, group_number
    from jsonb_populate_recordset(null::public.match_groups, p_state -> 'match_groups');
  insert into public.match_members (group_id, participant_id, seq)
    select group_id, participant_id, seq
    from jsonb_populate_recordset(null::public.match_members, p_state -> 'match_members');
  insert into public.participant_submissions (request_id, participant_id)
    select request_id, participant_id
    from jsonb_populate_recordset(null::public.participant_submissions, p_state -> 'participant_submissions');
  insert into public.prayer_checkins (participant_id, week_1, week_2, week_3, week_4)
    select participant_id, week_1, week_2, week_3, week_4
    from jsonb_populate_recordset(null::public.prayer_checkins, p_state -> 'prayer_checkins');
  if exists (
    select 1 from public.match_members m join public.match_groups g on m.group_id = g.id
    group by g.round_id, m.participant_id having count(*) > 1
  ) then
    raise exception 'Snapshot assigns a participant twice in the same round' using errcode = '22023';
  end if;
  update public.match_control
    set revision = next_control.revision, draw_started_at = next_control.draw_started_at where id;
  foreach table_name in array table_names loop
    execute format('alter table public.%I enable trigger prayer_sheets_read_only', table_name);
  end loop;
  return row_counts;
end;
$$;

revoke all on function public.prayer_export(), public.prayer_import(jsonb, bigint, boolean) from public, anon, authenticated;
grant execute on function public.prayer_export(), public.prayer_import(jsonb, bigint, boolean) to service_role;
