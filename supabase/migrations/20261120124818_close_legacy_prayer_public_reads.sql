revoke select on table public.participants, public.match_rounds, public.match_groups, public.match_members from public, anon, authenticated;
revoke execute on function public.prayer_snapshot() from public, anon, authenticated;
grant execute on function public.prayer_snapshot() to service_role;
