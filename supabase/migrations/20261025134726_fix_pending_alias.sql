create or replace function public.prayer_add_pending() returns integer
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

