-- Archive before clearing the live event. Archived records have no foreign
-- keys to live rows, so cascades cannot remove past participants or groups.
create schema prayer_private;
revoke all on schema prayer_private from public, anon, authenticated;
grant usage on schema prayer_private to service_role;

create table prayer_private.archives (
  id uuid primary key default gen_random_uuid(),
  archived_at timestamptz not null default clock_timestamp(),
  kind text not null check (kind in ('reset', 'delete')),
  participants jsonb not null,
  rounds jsonb not null check (jsonb_typeof(rounds) = 'array'),
  participant_count integer generated always as (jsonb_array_length(participants)) stored,
  check (participant_count > 0)
);

alter table prayer_private.archives enable row level security;
revoke all on table prayer_private.archives from public, anon, authenticated, service_role;
grant select, insert on table prayer_private.archives to service_role;

-- The caller holds the event lock and clears the live rows in the same transaction.
create function prayer_private.archive_records(p_kind text, p_person_id uuid default null)
returns void language sql security invoker set search_path = '' as $$
  with roster as (
    select jsonb_agg(public.prayer_person_json(p, c) order by p.created_at desc, p.id) as participants
    from public.participants p
    left join public.prayer_checkins c on c.participant_id = p.id
    where p_kind = 'reset' or p.id = p_person_id
  ),
  assignments as (
    select g.round_id, jsonb_agg(jsonb_build_object('participantId', m.participant_id, 'groupNumber', g.group_number)
      order by g.group_number, m.seq, m.participant_id) as entries
    from public.match_groups g
    join public.match_members m on m.group_id = g.id
    where p_kind = 'reset' or m.participant_id = p_person_id
    group by g.round_id
  ),
  recorded_rounds as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'mode', r.mode, 'targetSize', r.target_size,
      'createdAt', r.created_at, 'isActive', r.is_active,
      'assignments', coalesce(a.entries, '[]'::jsonb)
    ) order by r.created_at desc, r.id), '[]'::jsonb) as rounds
    from public.match_rounds r
    left join assignments a on a.round_id = r.id
    where p_kind = 'reset' or a.round_id is not null
  )
  insert into prayer_private.archives (kind, participants, rounds)
  select p_kind, roster.participants, recorded_rounds.rounds
  from roster cross join recorded_rounds
  where roster.participants is not null;
$$;

create function prayer_private.archive_history()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'archivedAt', a.archived_at, 'kind', a.kind, 'participantCount', a.participant_count
  ) order by a.archived_at desc, a.id desc), '[]'::jsonb)
  from prayer_private.archives a;
$$;

create function prayer_private.archive_entry(p_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce((select jsonb_build_object(
    'id', a.id, 'archivedAt', a.archived_at, 'kind', a.kind, 'participantCount', a.participant_count,
    'participants', a.participants, 'rounds', a.rounds
  ) from prayer_private.archives a where a.id = p_id), 'null'::jsonb);
$$;

-- Return a saved round's existing membership with the participants' current details.
create function prayer_private.round_entry(p_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with group_members as (
    select g.group_number, jsonb_agg(public.prayer_person_json(p, c) order by m.seq, m.participant_id) as members
    from public.match_groups g
    join public.match_members m on m.group_id = g.id
    join public.participants p on p.id = m.participant_id
    left join public.prayer_checkins c on c.participant_id = p.id
    where g.round_id = p_id
    group by g.group_number
  ), round_groups as (
    select jsonb_agg(jsonb_build_object('groupNumber', group_number, 'members', members)
      order by group_number) as groups
    from group_members
  )
  select coalesce((select jsonb_build_object(
    'id', r.id, 'createdAt', r.created_at, 'mode', r.mode, 'targetSize', r.target_size,
    'isActive', r.is_active, 'groups', g.groups
  ) from public.match_rounds r cross join round_groups g
  where r.id = p_id and g.groups is not null), 'null'::jsonb);
$$;

revoke all on function prayer_private.archive_records(text, uuid), prayer_private.archive_history(),
  prayer_private.archive_entry(uuid), prayer_private.round_entry(uuid) from public, anon, authenticated;
grant execute on function prayer_private.archive_records(text, uuid), prayer_private.archive_history(),
  prayer_private.archive_entry(uuid), prayer_private.round_entry(uuid) to service_role;

-- Replace the runtime mutations without changing the live read contracts.
create or replace function public.prayer_runtime_command(p_control public.match_control, p_action text, p_body jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  selected_round_id uuid;
  person_id uuid;
  roster uuid[];
  requested uuid[];
  target_size integer;
  draw_at timestamptz := p_control.draw_started_at;
begin
  if p_action in ('publish', 'restore', 'draw') and draw_at + interval '3.2 seconds' > clock_timestamp() then
    raise exception 'Draw is already running' using errcode = '40001';
  end if;

  case p_action
    when 'publish' then
      if exists (select 1 from public.match_rounds r where r.is_active)
        and (p_body->>'confirm') is distinct from '재편성' then
        raise exception 'Existing groups require explicit replacement' using errcode = '22023';
      end if;
      if jsonb_typeof(p_body->'assignments') is distinct from 'array'
        or jsonb_typeof(p_body->'target') is distinct from 'number'
        or (p_body->>'target') !~ '^[0-9]+$'
        or coalesce(p_body->>'mode', '') not in ('team', 'random')
        or (p_body ? 'draw' and jsonb_typeof(p_body->'draw') is distinct from 'boolean') then
        raise exception 'Invalid matching settings' using errcode = '22023';
      end if;
      target_size := (p_body->>'target')::integer;
      if target_size not between 2 and 10 then
        raise exception 'Invalid target size' using errcode = '22023';
      end if;
      select array_agg(id order by id) into roster from public.participants;
      select array_agg(a.participant_id order by a.participant_id) into requested
      from jsonb_to_recordset(p_body->'assignments') as a(participant_id uuid);
      if roster is null or roster is distinct from requested then
        raise exception 'Roster changed' using errcode = '40001';
      end if;
      if exists (select 1 from jsonb_array_elements(p_body->'assignments') as a(entry)
        where jsonb_typeof(a.entry->'group_number') is distinct from 'number'
          or (a.entry->>'group_number') !~ '^[1-9][0-9]*$') then
        raise exception 'Invalid group number' using errcode = '22023';
      end if;

      update public.match_rounds set is_active = false where is_active;
      insert into public.match_rounds (mode, target_size, is_active)
      values (p_body->>'mode', target_size, true) returning id into selected_round_id;
      insert into public.match_groups (round_id, group_number)
      select distinct selected_round_id, (a.entry->>'group_number')::integer
      from jsonb_array_elements(p_body->'assignments') as a(entry);
      insert into public.match_members (group_id, participant_id, seq)
      select g.id, (a.entry->>'participant_id')::uuid,
        row_number() over (partition by g.id order by a.pos) - 1
      from jsonb_array_elements(p_body->'assignments') with ordinality as a(entry, pos)
      join public.match_groups g on g.round_id = selected_round_id
        and g.group_number = (a.entry->>'group_number')::integer;
      draw_at := case when p_body->'draw' = 'true'::jsonb then clock_timestamp() + interval '8 seconds' end;

    when 'restore' then
      selected_round_id := (p_body->>'roundId')::uuid;
      if not exists (select 1 from public.match_groups g join public.match_members m on m.group_id = g.id
        where g.round_id = selected_round_id) then
        raise exception 'No round to restore' using errcode = 'P0002';
      end if;
      update public.match_rounds set is_active = false where is_active;
      update public.match_rounds set is_active = true where id = selected_round_id;
      draw_at := clock_timestamp() + interval '8 seconds';

    when 'draw' then
      if not exists (select 1 from public.match_rounds r where r.is_active) then
        raise exception 'No active round' using errcode = 'P0002';
      end if;
      draw_at := clock_timestamp() + interval '8 seconds';

    when 'unpublish' then
      update public.match_rounds set is_active = false where is_active;
      draw_at := null;

    when 'delete', 'archive_delete' then
      person_id := (p_body->>'id')::uuid;
      if person_id is null then raise exception 'Missing participant ID' using errcode = '22023'; end if;
      perform prayer_private.archive_records('delete', person_id);
      delete from public.participants where id = person_id;

    when 'reset', 'archive_reset' then
      if (p_body->>'confirm') is distinct from '삭제' then
        raise exception 'Reset confirmation required' using errcode = '22023';
      end if;
      perform prayer_private.archive_records('reset');
      delete from public.match_rounds where id is not null;
      delete from public.participants where id is not null;
      draw_at := null;

    else
      raise exception 'Invalid event command' using errcode = '22023';
  end case;

  update public.match_control set revision = revision + 1, draw_started_at = draw_at where id;
end;
$$;

create or replace function public.prayer_storage(p_operation text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  control public.match_control;
  person_id uuid;
  active_round_id uuid;
  requested_round_id uuid;
  week integer;
  checked boolean;
  checkins public.prayer_checkins;
  old_checked boolean;
  submission jsonb;
  receipts jsonb := '[]'::jsonb;
begin
  -- Reads are ordinary MVCC SELECTs and never take the shared mutation lock.
  case p_operation
    when 'snapshot' then return public.prayer_runtime_snapshot();
    when 'revision' then
      return (select jsonb_build_object('revision', c.revision, 'drawStartedAt', c.draw_started_at, 'serverTime', now())
        from public.match_control c where c.id);
    when 'history' then return public.prayer_runtime_history();
    when 'round_entry' then return prayer_private.round_entry((p_payload->>'id')::uuid);
    when 'archive_history' then return prayer_private.archive_history();
    when 'archive_entry' then return prayer_private.archive_entry((p_payload->>'id')::uuid);
    when 'participant' then
      person_id := (p_payload->>'id')::uuid;
      return (select public.prayer_person_json(p, c) from public.participants p
        left join public.prayer_checkins c on c.participant_id = p.id where p.id = person_id);
    else null;
  end case;

  select c.* into strict control from public.match_control c where c.id for update;
  case p_operation
    when 'submit' then return to_jsonb(public.prayer_runtime_submit(p_payload));
    when 'submit_batch' then
      if jsonb_typeof(p_payload->'submissions') is distinct from 'array' then
        raise exception 'Submission batch must be an array' using errcode = '22023';
      end if;
      if jsonb_array_length(p_payload->'submissions') not between 1 and 50 then
        raise exception 'Invalid submission batch size' using errcode = '22023';
      end if;
      for submission in select value from jsonb_array_elements(p_payload->'submissions') loop
        receipts := receipts || jsonb_build_array(jsonb_build_object(
          'requestId', submission->>'requestId', 'participantId', public.prayer_runtime_submit(submission)));
      end loop;
      return receipts;

    when 'edit' then
      perform public.prayer_validate_person(p_payload);
      return to_jsonb(public.prayer_edit((p_payload->>'id')::uuid, (p_payload->>'version')::bigint,
        p_payload->>'name', p_payload->>'team', p_payload->>'prayer'));

    when 'check_prayer' then
      person_id := (p_payload->>'id')::uuid;
      requested_round_id := (p_payload->>'roundId')::uuid;
      if person_id is null or requested_round_id is null or jsonb_typeof(p_payload->'week') is distinct from 'number'
        or (p_payload->>'week') !~ '^[1-4]$' or jsonb_typeof(p_payload->'checked') is distinct from 'boolean' then
        raise exception 'Invalid prayer check' using errcode = '22023';
      end if;
      week := (p_payload->>'week')::integer;
      checked := (p_payload->>'checked')::boolean;
      select id into active_round_id from public.match_rounds r where r.is_active;
      if active_round_id is distinct from requested_round_id then
        raise exception 'Active round changed' using errcode = '40001';
      end if;
      if not exists (select 1 from public.match_groups g join public.match_members m on m.group_id = g.id
        where g.round_id = active_round_id and m.participant_id = person_id) then
        raise exception 'Participant is not in this round' using errcode = 'P0002';
      end if;
      select c.* into checkins from public.prayer_checkins c where c.participant_id = person_id;
      old_checked := case week when 1 then checkins.week_1 when 2 then checkins.week_2
        when 3 then checkins.week_3 when 4 then checkins.week_4 end;
      if coalesce(old_checked, false) = checked then return to_jsonb(checked); end if;
      insert into public.prayer_checkins (participant_id, week_1, week_2, week_3, week_4)
      values (person_id,
        case when week = 1 then checked else coalesce(checkins.week_1, false) end,
        case when week = 2 then checked else coalesce(checkins.week_2, false) end,
        case when week = 3 then checked else coalesce(checkins.week_3, false) end,
        case when week = 4 then checked else coalesce(checkins.week_4, false) end)
      on conflict (participant_id) do update set week_1 = excluded.week_1, week_2 = excluded.week_2,
        week_3 = excluded.week_3, week_4 = excluded.week_4;
      update public.match_control set revision = revision + 1 where id;
      return to_jsonb(checked);

    when 'append', 'command' then
      if (p_payload->>'revision')::bigint is distinct from control.revision then
        raise exception 'Event changed' using errcode = '40001';
      end if;
      if p_operation = 'command' then
        perform public.prayer_runtime_command(control, p_payload->>'operation', coalesce(p_payload->'payload', '{}'::jsonb));
        return 'null'::jsonb;
      end if;
      if not exists (select 1 from public.match_rounds r join public.match_groups g on g.round_id = r.id where r.is_active) then
        raise exception 'No active groups' using errcode = 'P0002';
      end if;
      return to_jsonb(public.prayer_append(control.revision));

    else
      raise exception 'Invalid storage operation' using errcode = '22023';
  end case;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'Invalid storage input' using errcode = '22023';
end;
$$;

-- Older server callers still go through this RPC. Route their delete/reset
-- through the same archiving behavior while holding the existing row lock.
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
  elsif p_operation in ('delete', 'archive_delete', 'reset', 'archive_reset') then
    perform public.prayer_runtime_command((select c from public.match_control c where c.id), p_operation, p_payload);
    return;
  else raise exception 'Invalid operation';
  end if;
  update public.match_control set revision=revision+1 where id;
end $$;
