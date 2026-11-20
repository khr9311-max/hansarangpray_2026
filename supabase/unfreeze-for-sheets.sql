-- Enable Supabase writes after Sheets has been frozen and the import verified.
-- Reconcile the newest Sheets snapshot before directing traffic here.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';

drop trigger if exists prayer_sheets_read_only on public.match_control;
drop trigger if exists prayer_sheets_read_only on public.participants;
drop trigger if exists prayer_sheets_read_only on public.match_rounds;
drop trigger if exists prayer_sheets_read_only on public.match_groups;
drop trigger if exists prayer_sheets_read_only on public.match_members;
drop trigger if exists prayer_sheets_read_only on public.participant_submissions;
do $$
begin
  if to_regclass('public.prayer_checkins') is not null then
    drop trigger if exists prayer_sheets_read_only on public.prayer_checkins;
  end if;
end;
$$;

commit;
