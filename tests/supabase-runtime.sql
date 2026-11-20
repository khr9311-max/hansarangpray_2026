-- Run against an isolated database with the current runtime and writes enabled.
-- The fixtures exercise the same RPC as the web app and roll back on success.
begin;
set local role service_role;

do $$
declare
  first_request uuid := gen_random_uuid();
  second_request uuid := gen_random_uuid();
  late_request uuid := gen_random_uuid();
  first_person uuid;
  second_person uuid;
  late_person uuid;
  original_round uuid;
  next_round uuid;
  empty_round uuid;
  event_version bigint;
  draw_at timestamptz;
  snapshot jsonb;
  first_submission jsonb;
  second_submission jsonb;
  late_submission jsonb;
  assignments jsonb;
  result jsonb;
  pending_person uuid;
  archive_history jsonb;
  delete_archive jsonb;
  reset_archive jsonb;
  archive_count integer;
begin
  if has_function_privilege('anon', 'public.prayer_storage(text,jsonb)', 'execute')
    or has_function_privilege('authenticated', 'public.prayer_snapshot()', 'execute')
    or has_table_privilege('anon', 'public.participants', 'select')
    or has_table_privilege('authenticated', 'public.prayer_checkins', 'select')
    or has_schema_privilege('anon', 'prayer_private', 'usage')
    or has_schema_privilege('authenticated', 'prayer_private', 'usage')
    or has_table_privilege('anon', 'prayer_private.archives', 'select')
    or has_function_privilege('authenticated', 'prayer_private.archive_entry(uuid)', 'execute')
    or has_function_privilege('anon', 'prayer_private.round_entry(uuid)', 'execute')
    or has_function_privilege('authenticated', 'prayer_private.round_entry(uuid)', 'execute')
    or has_table_privilege('service_role', 'prayer_private.archives', 'delete') then
    raise exception 'Participant data must be server-only';
  end if;

  select revision into event_version from public.match_control where id;
  perform public.prayer_storage('command', jsonb_build_object(
    'revision', event_version, 'operation', 'reset', 'payload', jsonb_build_object('confirm', '삭제')));
  archive_count := jsonb_array_length(public.prayer_storage('archive_history'));
  event_version := (public.prayer_storage('revision')->>'revision')::bigint;
  first_submission := jsonb_build_object('requestId', first_request, 'name', '검증 1', 'team', '팀 1', 'prayer', '검증');
  second_submission := jsonb_build_object('requestId', second_request, 'name', '검증 2', 'team', '팀 2', 'prayer', '검증');
  late_submission := jsonb_build_object('requestId', late_request, 'name', '추가 검증', 'team', '팀 1', 'prayer', '검증');

  begin
    perform public.prayer_storage('submit_batch', jsonb_build_object('submissions', jsonb_build_array(
      first_submission, second_submission - 'prayer')));
    raise exception 'Invalid batch saved';
  exception when invalid_parameter_value then null;
  end;
  if (public.prayer_storage('revision')->>'revision')::bigint <> event_version
    or exists (select 1 from public.participants) then
    raise exception 'Failed batch was not atomic';
  end if;

  result := public.prayer_storage('submit_batch', jsonb_build_object('submissions', jsonb_build_array(
    first_submission, second_submission, jsonb_build_object('requestId', first_request))));
  first_person := (result->0->>'participantId')::uuid;
  second_person := (result->1->>'participantId')::uuid;
  if first_person is null or second_person is null or first_person = second_person
    or (result->2->>'participantId')::uuid is distinct from first_person
    or public.prayer_storage('submit', first_submission) is distinct from to_jsonb(first_person)
    or (public.prayer_storage('revision')->>'revision')::bigint <> event_version + 2 then
    raise exception 'Receipts or revision did not preserve idempotency';
  end if;

  event_version := (public.prayer_storage('revision')->>'revision')::bigint;
  assignments := jsonb_build_array(jsonb_build_object('participant_id', second_person, 'group_number', 1),
    jsonb_build_object('participant_id', first_person, 'group_number', 1));
  perform public.prayer_storage('command', jsonb_build_object(
    'revision', event_version, 'operation', 'publish', 'payload', jsonb_build_object(
      'target', 2, 'mode', 'team', 'assignments', assignments, 'draw', true)));
  snapshot := public.prayer_storage('snapshot');
  original_round := (snapshot->'round'->>'id')::uuid;
  draw_at := (snapshot->>'drawStartedAt')::timestamptz;
  if draw_at is null or draw_at < clock_timestamp() + interval '7 seconds'
    or (snapshot #>> '{round,groups,0,members,0,id}')::uuid is distinct from second_person
    or (snapshot #>> '{round,groups,0,members,1,id}')::uuid is distinct from first_person then
    raise exception 'Publish did not preserve member order and a shared future draw time';
  end if;
  event_version := (public.prayer_storage('revision')->>'revision')::bigint;
  begin
    perform public.prayer_storage('command', jsonb_build_object('revision', event_version, 'operation', 'draw'));
    raise exception 'Overlapping draw accepted';
  exception when serialization_failure then null;
  end;

  perform public.prayer_storage('check_prayer', jsonb_build_object(
    'id', first_person, 'roundId', original_round, 'week', 3, 'checked', false));
  if (public.prayer_storage('revision')->>'revision')::bigint <> event_version
    or exists (select 1 from public.prayer_checkins) then
    raise exception 'No-op prayer check changed the event';
  end if;
  perform public.prayer_storage('check_prayer', jsonb_build_object(
    'id', first_person, 'roundId', original_round, 'week', 3, 'checked', true));
  if public.prayer_storage('participant', jsonb_build_object('id', first_person))->'prayerChecks'
    is distinct from '[false,false,true,false]'::jsonb then
    raise exception 'The prayer check did not appear on the participant';
  end if;

  late_person := (public.prayer_storage('submit', late_submission) #>> '{}')::uuid;
  if jsonb_array_length(public.prayer_storage('snapshot') #> '{round,groups,0,members}') <> 2 then
    raise exception 'Late signup should remain pending';
  end if;
  begin
    perform public.prayer_storage('check_prayer', jsonb_build_object(
      'id', late_person, 'roundId', original_round, 'week', 1, 'checked', true));
    raise exception 'Unassigned participant recorded a check';
  exception when no_data_found then null;
  end;
  event_version := (public.prayer_storage('revision')->>'revision')::bigint;
  if public.prayer_storage('append', jsonb_build_object('revision', event_version)) is distinct from '1'::jsonb then
    raise exception 'Explicit append failed';
  end if;
  if public.prayer_storage('append', jsonb_build_object('revision', event_version + 1)) is distinct from '0'::jsonb then
    raise exception 'Repeated append modified the event';
  end if;
  assignments := jsonb_build_array(
    jsonb_build_object('participant_id', second_person, 'group_number', 2),
    jsonb_build_object('participant_id', first_person, 'group_number', 1),
    jsonb_build_object('participant_id', late_person, 'group_number', 1));

  -- Move the shared clock past the reveal without a real-time wait.
  update public.match_control set draw_started_at = clock_timestamp() - interval '1 minute' where id;
  event_version := (public.prayer_storage('revision')->>'revision')::bigint;
  perform public.prayer_storage('command', jsonb_build_object('revision', event_version, 'operation', 'publish',
    'payload', jsonb_build_object('target', 2, 'mode', 'random', 'assignments', assignments, 'confirm', '재편성')));
  snapshot := public.prayer_storage('snapshot');
  next_round := (snapshot->'round'->>'id')::uuid;
  if next_round is null or next_round = original_round or jsonb_array_length(public.prayer_storage('history')) <> 2 then
    raise exception 'Round history was lost during rematching';
  end if;

  -- An inactive round can be inspected without activating it or altering the current revision.
  insert into public.match_groups(round_id, group_number) values (original_round, 99);
  insert into public.match_rounds(mode, target_size) values ('team', 2) returning id into empty_round;
  insert into public.match_groups(round_id, group_number) values (empty_round, 1);
  result := public.prayer_storage('round_entry', jsonb_build_object('id', original_round));
  if not (result @> jsonb_build_object('id', original_round, 'mode', 'team', 'targetSize', 2, 'isActive', false))
    or result->>'createdAt' is null
    or jsonb_array_length(result->'groups') is distinct from 1
    or result #>> '{groups,0,groupNumber}' is distinct from '1'
    or (result #>> '{groups,0,members,0,id}')::uuid is distinct from second_person
    or not (result #> '{groups,0,members,1}' @> jsonb_build_object(
      'id', first_person, 'name', '검증 1', 'team', '팀 1', 'prayer_request', '검증',
      'prayerChecks', '[false,false,true,false]'::jsonb))
    or (result #>> '{groups,0,members,2,id}')::uuid is distinct from late_person
    or public.prayer_storage('round_entry', jsonb_build_object('id', empty_round)) is distinct from 'null'::jsonb
    or public.prayer_storage('round_entry', jsonb_build_object('id', gen_random_uuid())) is distinct from 'null'::jsonb
    or public.prayer_storage('snapshot') is distinct from snapshot then
    raise exception 'Historical round details lost member data, included an empty group, or modified the live event';
  end if;
  delete from public.match_rounds where id = empty_round;
  delete from public.match_groups where round_id = original_round and group_number = 99;

  begin
    perform public.prayer_storage('check_prayer', jsonb_build_object(
      'id', first_person, 'roundId', original_round, 'week', 4, 'checked', true));
    raise exception 'Previous round accepted a check';
  exception when serialization_failure then null;
  end;
  begin
    perform public.prayer_storage('command', jsonb_build_object('revision', event_version, 'operation', 'unpublish'));
    raise exception 'Stale command accepted';
  exception when serialization_failure then null;
  end;

  event_version := (public.prayer_storage('revision')->>'revision')::bigint;
  perform public.prayer_storage('command', jsonb_build_object('revision', event_version, 'operation', 'restore',
    'payload', jsonb_build_object('roundId', original_round)));
  snapshot := public.prayer_storage('snapshot');
  if (snapshot #>> '{round,id}')::uuid is distinct from original_round
    or jsonb_array_length(snapshot #> '{round,groups,0,members}') <> 3
    or snapshot #> '{round,groups,0,members,1,prayerChecks}' is distinct from '[false,false,true,false]'::jsonb
    or (snapshot->>'drawStartedAt')::timestamptz < clock_timestamp() + interval '7 seconds' then
    raise exception 'Restore lost saved members, time or prayer checks';
  end if;

  result := public.prayer_storage('edit', jsonb_build_object(
    'id', first_person, 'version', 0, 'name', '검증 수정', 'team', '팀 1', 'prayer', '검증'));
  if result is distinct from '1'::jsonb then raise exception 'Edit version did not increment'; end if;
  event_version := (public.prayer_storage('revision')->>'revision')::bigint;
  perform public.prayer_storage('command', jsonb_build_object('revision', event_version, 'operation', 'archive_delete',
    'payload', jsonb_build_object('id', first_person)));
  if exists (select 1 from public.prayer_checkins where participant_id = first_person)
    or exists (select 1 from public.participant_submissions where request_id = first_request)
    or exists (select 1 from public.match_members where participant_id = first_person)
    or public.prayer_storage('participant', jsonb_build_object('id', first_person)) is not null then
    raise exception 'Participant delete left dependent rows';
  end if;

  archive_history := public.prayer_storage('archive_history');
  if jsonb_array_length(archive_history) <> archive_count + 1
    or not (archive_history->0 @> '{"kind":"delete","participantCount":1}'::jsonb)
    or archive_history->0 ?| array['participants', 'rounds']
    or archive_history #>> '{0,archivedAt}' is null then
    raise exception 'A summary did not list the hidden participant without personal details';
  end if;
  delete_archive := public.prayer_storage('archive_entry', jsonb_build_object('id', archive_history #>> '{0,id}'));
  if jsonb_typeof(delete_archive) is distinct from 'object'
    or not (delete_archive->'participants' @> jsonb_build_array(jsonb_build_object(
      'id', first_person, 'name', '검증 수정', 'team', '팀 1', 'prayer_request', '검증',
      'prayerChecks', '[false,false,true,false]'::jsonb)))
    or jsonb_array_length(delete_archive->'rounds') <> 2
    or not (delete_archive->'rounds' @> jsonb_build_array(jsonb_build_object(
      'id', original_round, 'isActive', true, 'assignments', jsonb_build_array(
        jsonb_build_object('participantId', first_person, 'groupNumber', 1)))))
    or delete_archive->'rounds' @> jsonb_build_array(jsonb_build_object('assignments',
      jsonb_build_array(jsonb_build_object('participantId', second_person)))) then
    raise exception 'The individual archive did not retain the former participant and their groups';
  end if;

  pending_person := (public.prayer_storage('submit', jsonb_build_object(
    'requestId', gen_random_uuid(), 'name', '배정 전 검증', 'team', '팀 1', 'prayer', '대기 중 검증')) #>> '{}')::uuid;
  event_version := (public.prayer_storage('revision')->>'revision')::bigint;
  snapshot := public.prayer_storage('snapshot') - 'serverTime';
  begin
    perform public.prayer_storage('command', jsonb_build_object('revision', event_version, 'operation', 'archive_reset',
      'payload', jsonb_build_object('confirm', ' 삭제 ')));
    raise exception 'Reset accepted inexact confirmation';
  exception when invalid_parameter_value then null;
  end;
  if public.prayer_storage('snapshot') - 'serverTime' is distinct from snapshot
    or public.prayer_storage('archive_history') is distinct from archive_history then
    raise exception 'Invalid confirmation changed live or archived records';
  end if;

  perform public.prayer_storage('command', jsonb_build_object('revision', event_version, 'operation', 'archive_reset',
    'payload', jsonb_build_object('confirm', '삭제')));
  snapshot := public.prayer_storage('snapshot');
  if not (snapshot @> '{"participants":[],"round":null,"drawStartedAt":null}'::jsonb)
    or snapshot ? 'archives'
    or public.prayer_storage('history') is distinct from '[]'::jsonb
    or public.prayer_storage('participant', jsonb_build_object('id', second_person)) is not null then
    raise exception 'Reset left hidden data in the live views';
  end if;

  archive_history := public.prayer_storage('archive_history');
  reset_archive := public.prayer_storage('archive_entry', jsonb_build_object('id', archive_history #>> '{0,id}'));
  if jsonb_array_length(archive_history) <> archive_count + 2
    or not (archive_history->0 @> '{"kind":"reset","participantCount":3}'::jsonb)
    or jsonb_typeof(reset_archive) is distinct from 'object'
    or not (reset_archive->'participants' @> jsonb_build_array(jsonb_build_object(
      'id', pending_person, 'name', '배정 전 검증', 'team', '팀 1', 'prayer_request', '대기 중 검증')))
    or reset_archive->'rounds' @> jsonb_build_array(jsonb_build_object(
      'assignments', jsonb_build_array(jsonb_build_object('participantId', pending_person))))
    or not (reset_archive->'rounds' @> jsonb_build_array(
      jsonb_build_object('id', original_round, 'isActive', true, 'assignments', jsonb_build_array(
        jsonb_build_object('participantId', second_person, 'groupNumber', 1))),
      jsonb_build_object('id', next_round, 'isActive', false, 'assignments', jsonb_build_array(
        jsonb_build_object('participantId', second_person, 'groupNumber', 2))))) then
    raise exception 'Reset archive lost a pending participant or a prior round assignment';
  end if;
  if public.prayer_storage('archive_entry', jsonb_build_object('id', gen_random_uuid())) is distinct from 'null'::jsonb then
    raise exception 'Unknown archive ID did not return null';
  end if;

  begin
    perform public.prayer_storage('command', jsonb_build_object('revision', event_version, 'operation', 'archive_reset',
      'payload', jsonb_build_object('confirm', '삭제')));
    raise exception 'Stale reset accepted';
  exception when serialization_failure then null;
  end;
  event_version := (public.prayer_storage('revision')->>'revision')::bigint;
  perform public.prayer_storage('command', jsonb_build_object('revision', event_version, 'operation', 'archive_reset',
    'payload', jsonb_build_object('confirm', '삭제')));
  if public.prayer_storage('archive_history') is distinct from archive_history then
    raise exception 'A stale or empty reset created a duplicate archive';
  end if;

  perform public.prayer_storage('submit', jsonb_build_object(
    'requestId', gen_random_uuid(), 'name', '새 행사 검증', 'team', '팀 2', 'prayer', '새 행사 기도'));
  event_version := (public.prayer_storage('revision')->>'revision')::bigint;
  perform public.prayer_command(event_version, 'reset', '{"confirm":"삭제"}'::jsonb);
  result := public.prayer_storage('archive_history');
  if jsonb_array_length(result) <> archive_count + 3
    or not (result->0 @> '{"kind":"reset","participantCount":1}'::jsonb)
    or public.prayer_storage('archive_entry', jsonb_build_object('id', delete_archive->>'id')) is distinct from delete_archive
    or public.prayer_storage('archive_entry', jsonb_build_object('id', reset_archive->>'id')) is distinct from reset_archive then
    raise exception 'A later legacy reset did not save the new event or changed past archives';
  end if;
end;
$$;

rollback;
