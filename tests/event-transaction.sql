-- Integration regression: fixtures are isolated in one transaction and rolled back.
begin;
set local role service_role;
do $$
declare
  v bigint; stale_v bigint; pid uuid; rid uuid; original_round uuid;
  gcount integer; added integer; target integer; i integer; op text;
  draw_time timestamptz; payload jsonb; before_members jsonb; after_members jsonb;
  before_snapshot jsonb; before_roster uuid[]; failed boolean;
begin
  -- Use the same lock ordering as application mutations.
  perform 1 from public.match_control where id for update;
  delete from public.match_rounds;
  delete from public.participants;
  update public.match_control set draw_started_at=null where id;

  -- Independent fixture: six participants, two original groups.
  for i in 1..6 loop
    perform public.prayer_register('검증' || i, '검증팀' || (i % 3), '검증용 기도');
  end loop;
  select revision into v from public.match_control where id;
  select jsonb_build_object('target',3,'mode','team','confirm','재편성',
    'assignments',jsonb_agg(jsonb_build_object('participant_id',p.id,'group_number',1+(p.rn-1)/3)))
    into payload from (select id,row_number() over(order by id) rn from public.participants) p;
  perform public.prayer_command(v,'publish',payload);
  select id into rid from public.match_rounds where is_active;
  original_round:=rid;
  select count(*) into gcount from public.match_groups where round_id=rid;
  if gcount<>2 then raise exception 'Fixture should have two groups'; end if;
  select jsonb_agg(to_jsonb(m) order by m.participant_id) into before_members
    from public.match_members m join public.match_groups g on g.id=m.group_id where g.round_id=rid;
  if jsonb_array_length(before_members)<>6 then raise exception 'Initial roster incomplete'; end if;
  if (public.prayer_snapshot()->>'drawStartedAt') is not null then raise exception 'Publish started a reveal'; end if;
  select revision into v from public.match_control where id;
  perform public.prayer_command(v,'draw');
  select draw_started_at into draw_time from public.match_control where id;
  if draw_time is null then raise exception 'Draw timestamp not shared'; end if;

  -- Registration leaves late participants pending without disturbing the result.
  for i in 1..20 loop
    pid:=public.prayer_register('추가검증' || i,'검증팀' || (i % 3),'추가 기도');
  end loop;
  if (select count(*) from public.match_members m join public.match_groups g on g.id=m.group_id
      where g.round_id=rid)<>6 then raise exception 'Registration assigned pending participants'; end if;
  if (select draw_started_at from public.match_control where id) is distinct from draw_time then
    raise exception 'Registration changed reveal timestamp'; end if;

  -- Draw only reveals; it must not silently assign pending people.
  select revision into v from public.match_control where id;
  perform public.prayer_command(v,'draw');
  select draw_started_at into draw_time from public.match_control where id;
  if (select count(*) from public.match_members m join public.match_groups g on g.id=m.group_id
      where g.round_id=rid)<>6 then raise exception 'Draw assigned pending participants'; end if;

  -- Append all twenty once, retaining group IDs and original member order.
  select revision into stale_v from public.match_control where id;
  added:=public.prayer_append(stale_v);
  if added<>20 then raise exception 'Append expected 20, got %',added; end if;
  select revision into v from public.match_control where id;
  if v<>stale_v+1 then raise exception 'Append revision should increment exactly once'; end if;
  if (select id from public.match_rounds where is_active) is distinct from original_round then
    raise exception 'Append replaced active round'; end if;
  if (select count(*) from public.match_groups where round_id=rid)<>gcount then
    raise exception 'Append created or removed groups'; end if;
  select jsonb_agg(to_jsonb(m) order by m.participant_id) into after_members
    from public.match_members m join public.match_groups g on g.id=m.group_id
    where g.round_id=rid and m.participant_id in
      (select (x->>'participant_id')::uuid from jsonb_array_elements(before_members) x);
  if before_members is distinct from after_members then raise exception 'Existing member moved or reordered'; end if;
  if (select count(*) from public.match_members m join public.match_groups g on g.id=m.group_id
      where g.round_id=rid)<>26 then raise exception 'Append lost participants'; end if;
  if exists(select m.participant_id from public.match_members m join public.match_groups g on g.id=m.group_id
      where g.round_id=rid group by m.participant_id having count(*)<>1) then
    raise exception 'Append duplicated a participant'; end if;
  if (select max(n)-min(n) from (select count(m.participant_id) n from public.match_groups g
      left join public.match_members m on m.group_id=g.id where g.round_id=rid group by g.id) sizes)>1 then
    raise exception 'Append produced unnecessarily uneven groups'; end if;
  if (select draw_started_at from public.match_control where id) is distinct from draw_time then
    raise exception 'Append restarted or hid revealed results'; end if;

  -- Refresh and press again: true no-op, including the revision.
  before_snapshot:=public.prayer_snapshot()-'serverTime';
  added:=public.prayer_append(v);
  if added<>0 then raise exception 'Repeated append inserted twice'; end if;
  if (public.prayer_snapshot()-'serverTime') is distinct from before_snapshot then
    raise exception 'No-op append changed persisted state'; end if;

  -- Two admins who read one version cannot both change the event.
  begin
    perform public.prayer_append(stale_v);
    raise exception 'Stale append accepted';
  exception when serialization_failure then null; end;
  foreach op in array array['publish','delete','reset','unpublish','draw'] loop
    begin
      perform public.prayer_command(stale_v,op,
        case when op='publish' then payload when op='delete' then jsonb_build_object('id',pid)
             else jsonb_build_object('confirm','삭제') end);
      raise exception 'Stale % command accepted',op;
    exception when serialization_failure then null; end;
  end loop;
  if (public.prayer_snapshot()-'serverTime') is distinct from before_snapshot then
    raise exception 'Rejected stale operation changed persisted state'; end if;

  -- Editing retains memberships and rejects a second editor's stale version.
  select jsonb_agg(to_jsonb(m) order by m.group_id,m.participant_id) into before_members from public.match_members m;
  perform public.prayer_edit(pid,0,'수정검증','운영팀','수정 기도');
  begin
    perform public.prayer_edit(pid,0,'덮어쓰기','운영팀','실패해야 함');
    raise exception 'Stale participant edit accepted';
  exception when serialization_failure then null; end;
  if (select edit_version from public.participants where id=pid)<>1 then
    raise exception 'Edit version should advance exactly once'; end if;
  select jsonb_agg(to_jsonb(m) order by m.group_id,m.participant_id) into after_members from public.match_members m;
  if before_members is distinct from after_members then raise exception 'Editing moved a member'; end if;

  -- Explicit rematching accepts every target size and preserves participant IDs.
  select array_agg(id order by id) into before_roster from public.participants;
  for target in 2..10 loop
    select revision into v from public.match_control where id;
    select jsonb_build_object('target',target,'mode',case when target%2=0 then 'team' else 'random' end,
      'confirm','재편성','assignments',jsonb_agg(jsonb_build_object('participant_id',p.id,'group_number',1+(p.rn-1)/target)))
      into payload from (select id,row_number() over(order by id) rn from public.participants) p;
    before_snapshot:=public.prayer_snapshot()-'serverTime';
    failed:=false;
    begin
      perform public.prayer_command(v,'publish',payload-'confirm');
    exception when raise_exception then failed:=true; end;
    if not failed then raise exception 'Existing groups replaced without confirmation'; end if;
    if (public.prayer_snapshot()-'serverTime') is distinct from before_snapshot then
      raise exception 'Rejected replacement changed event'; end if;
    perform public.prayer_command(v,'publish',payload);
    select id into rid from public.match_rounds where is_active;
    if (select count(*) from public.match_rounds where is_active)<>1 then raise exception 'Multiple active rounds'; end if;
    if (select array_agg(id order by id) from public.participants) is distinct from before_roster then
      raise exception 'Rematching deleted or recreated participant records'; end if;
    if (select array_agg(m.participant_id order by m.participant_id) from public.match_members m
        join public.match_groups g on g.id=m.group_id where g.round_id=rid) is distinct from before_roster then
      raise exception 'Target size % lost or duplicated assignments',target; end if;
    if (select draw_started_at from public.match_control where id) is not null then
      raise exception 'New round reused old reveal timestamp'; end if;
  end loop;

  -- Empty-roster publish fails atomically. Full deletion is a separate operation.
  select revision into v from public.match_control where id;
  perform public.prayer_command(v,'reset','{"confirm":"삭제"}');
  select revision into v from public.match_control where id;
  before_snapshot:=public.prayer_snapshot()-'serverTime';
  begin
    perform public.prayer_command(v,'publish','{"target":4,"mode":"team","assignments":[]}');
    raise exception 'Empty roster publish accepted';
  exception when serialization_failure then null; end;
  if (public.prayer_snapshot()-'serverTime') is distinct from before_snapshot then
    raise exception 'Failed publish partially changed state'; end if;
end $$;
rollback;
select 'PASS: pending signup, explicit append, no-op append, fixed groups, stale operations, edits, targets 2-10 and atomic failures; fixtures rolled back' as result;

-- The retry token remains private and the same request commits only once.
begin;
set local role service_role;
do $$
declare req uuid:=gen_random_uuid(); first_id uuid; second_id uuid; v bigint;
begin
  first_id:=public.prayer_submit(req,'중복검증','전도팀','검증');
  select revision into v from public.match_control;
  second_id:=public.prayer_submit(req,'중복검증','전도팀','검증');
  if first_id<>second_id or (select revision from public.match_control)<>v then
    raise exception 'Duplicate submission created';
  end if;
  if has_table_privilege('anon','public.participant_submissions','select')
    or has_function_privilege('anon','public.prayer_submit(uuid,text,text,text)','execute')
    or has_table_privilege('anon','public.participants','insert') then
    raise exception 'Anonymous access bypass';
  end if;
end $$;
rollback;
select 'PASS: idempotent retry and restricted mutation access; fixtures rolled back' as result;
