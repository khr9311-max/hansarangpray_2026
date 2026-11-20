-- Bring the current application behavior to the original Postgres schema.
-- The Vercel server calls the runtime RPC with the service role. The existing
-- cutover triggers stay enabled until the final import has been verified.

create table public.prayer_checkins (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  week_1 boolean not null default false,
  week_2 boolean not null default false,
  week_3 boolean not null default false,
  week_4 boolean not null default false
);

alter table public.prayer_checkins enable row level security;
revoke all on public.participants, public.match_rounds, public.match_groups,
  public.match_members, public.match_control, public.participant_submissions,
  public.prayer_checkins from public, anon, authenticated;
grant select, insert, update, delete on public.participants, public.match_rounds,
  public.match_groups, public.match_members, public.match_control,
  public.participant_submissions, public.prayer_checkins to service_role;

drop policy if exists "anon can insert participants" on public.participants;
drop policy if exists "anon can read participants" on public.participants;
drop policy if exists "anon can read rounds" on public.match_rounds;
drop policy if exists "anon can read groups" on public.match_groups;
drop policy if exists "anon can read members" on public.match_members;
drop policy if exists "read event control" on public.match_control;
revoke all on function public.prayer_snapshot() from public, anon, authenticated;

create index if not exists match_members_participant_idx
  on public.match_members(participant_id);

create function public.prayer_person_json(p public.participants, c public.prayer_checkins)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select to_jsonb(p) || jsonb_build_object('prayerChecks', jsonb_build_array(
    coalesce(c.week_1, false), coalesce(c.week_2, false),
    coalesce(c.week_3, false), coalesce(c.week_4, false)
  ));
$$;

create function public.prayer_runtime_snapshot()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with people as materialized (
    select p.id, p.created_at, public.prayer_person_json(p, c) as person
    from public.participants p left join public.prayer_checkins c on c.participant_id = p.id
  )
  select jsonb_build_object(
    'revision', control.revision, 'drawStartedAt', control.draw_started_at, 'serverTime', now(),
    'participants', coalesce((select jsonb_agg(person order by created_at desc, id) from people), '[]'::jsonb),
    'round', (select jsonb_build_object(
      'id', r.id, 'mode', r.mode, 'targetSize', r.target_size, 'createdAt', r.created_at,
      'groups', coalesce((select jsonb_agg(jsonb_build_object(
        'groupNumber', g.group_number,
        'members', coalesce((select jsonb_agg(p.person order by m.seq, m.participant_id)
          from public.match_members m join people p on p.id = m.participant_id
          where m.group_id = g.id), '[]'::jsonb)
      ) order by g.group_number) from public.match_groups g where g.round_id = r.id), '[]'::jsonb)
    ) from public.match_rounds r where r.is_active)
  ) from public.match_control control where control.id;
$$;

create function public.prayer_runtime_history()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', h.id, 'mode', h.mode, 'targetSize', h.target_size, 'createdAt', h.created_at,
    'groupCount', h.group_count, 'memberCount', h.member_count, 'isActive', h.is_active
  ) order by h.created_at desc, h.id), '[]'::jsonb)
  from (
    select r.*, count(distinct g.id) as group_count, count(*) as member_count
    from public.match_rounds r
    join public.match_groups g on g.round_id = r.id
    join public.match_members m on m.group_id = g.id
    group by r.id
  ) h;
$$;

create function public.prayer_validate_person(p_payload jsonb)
returns void language plpgsql immutable security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_payload->'name') is distinct from 'string'
    or jsonb_typeof(p_payload->'team') is distinct from 'string'
    or jsonb_typeof(p_payload->'prayer') is distinct from 'string'
    or (p_payload->>'name') !~ '[^[:space:]]' or length(p_payload->>'name') > 20
    or (p_payload->>'team') !~ '[^[:space:]]' or length(p_payload->>'team') > 200
    or (p_payload->>'prayer') !~ '[^[:space:]]' or length(p_payload->>'prayer') > 500 then
    raise exception 'Invalid participant' using errcode = '22023';
  end if;
end;
$$;

-- The caller holds the match_control row lock. Return existing receipts before
-- validating a new record so uncertain transport retries remain idempotent.
create function public.prayer_runtime_submit(p_payload jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  submission_key uuid := (p_payload->>'requestId')::uuid;
  existing_participant_id uuid;
begin
  if submission_key is null then
    raise exception 'Missing submission request' using errcode = '22023';
  end if;
  select s.participant_id into existing_participant_id
  from public.participant_submissions s where s.request_id = submission_key;
  if existing_participant_id is not null then return existing_participant_id; end if;
  perform public.prayer_validate_person(p_payload);
  return public.prayer_submit(submission_key, p_payload->>'name', p_payload->>'team', p_payload->>'prayer');
end;
$$;

-- The caller has checked the revision while holding the match_control lock.
create function public.prayer_runtime_command(p_control public.match_control, p_action text, p_body jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  selected_round_id uuid;
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

    when 'delete' then
      if p_body->>'id' is null then raise exception 'Missing participant ID' using errcode = '22023'; end if;
      delete from public.participants where id = (p_body->>'id')::uuid;

    when 'reset' then
      if (p_body->>'confirm') is distinct from '삭제' then
        raise exception 'Reset confirmation required' using errcode = '22023';
      end if;
      delete from public.match_rounds;
      delete from public.participants;
      draw_at := null;

    else
      raise exception 'Invalid event command' using errcode = '22023';
  end case;

  update public.match_control set revision = revision + 1, draw_started_at = draw_at where id;
end;
$$;

create function public.prayer_storage(p_operation text, p_payload jsonb default '{}'::jsonb)
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

revoke all on function public.prayer_person_json(public.participants, public.prayer_checkins),
  public.prayer_runtime_snapshot(), public.prayer_runtime_history(), public.prayer_validate_person(jsonb),
  public.prayer_runtime_submit(jsonb), public.prayer_runtime_command(public.match_control, text, jsonb),
  public.prayer_storage(text, jsonb) from public, anon, authenticated;
grant execute on function public.prayer_person_json(public.participants, public.prayer_checkins),
  public.prayer_runtime_snapshot(), public.prayer_runtime_history(), public.prayer_validate_person(jsonb),
  public.prayer_runtime_submit(jsonb), public.prayer_runtime_command(public.match_control, text, jsonb),
  public.prayer_storage(text, jsonb) to service_role;
