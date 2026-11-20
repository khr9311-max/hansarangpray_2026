-- Roll back only the legacy-write freeze. Data and function definitions stay.
-- Before restoring old traffic, reconcile any newer Google Sheets submissions
-- and stop Sheets writes so the two stores cannot diverge.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';

drop trigger if exists prayer_sheets_read_only on public.match_control;
drop trigger if exists prayer_sheets_read_only on public.participants;
drop trigger if exists prayer_sheets_read_only on public.match_rounds;
drop trigger if exists prayer_sheets_read_only on public.match_groups;
drop trigger if exists prayer_sheets_read_only on public.match_members;
drop trigger if exists prayer_sheets_read_only on public.participant_submissions;

commit;
