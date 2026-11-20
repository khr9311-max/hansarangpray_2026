-- Freeze the legacy database before the final Google Sheets export/import.
-- Run as the database owner. Existing records, SELECT permissions and RPC reads
-- remain intact. The matching unfreeze script removes only these six triggers.
--
-- A control-row-only trigger is insufficient: prayer_add_pending() can insert
-- members without updating match_control. Cover direct writes and TRUNCATE too.
-- ACCESS EXCLUSIVE drains current writes before all guards become visible in
-- one commit. Ordinary reads wait briefly during installation, then resume.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';

lock table public.match_control,
  public.participants,
  public.match_rounds,
  public.match_groups,
  public.match_members,
  public.participant_submissions
in access exclusive mode;

create or replace function public.reject_legacy_prayer_writes()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'Storage migrated to Google Sheets' using errcode = '55000';
end;
$$;

revoke all on function public.reject_legacy_prayer_writes()
  from public, anon, authenticated;

drop trigger if exists prayer_sheets_read_only on public.match_control;
create trigger prayer_sheets_read_only
  before insert or update or delete or truncate on public.match_control
  for each statement execute function public.reject_legacy_prayer_writes();

drop trigger if exists prayer_sheets_read_only on public.participants;
create trigger prayer_sheets_read_only
  before insert or update or delete or truncate on public.participants
  for each statement execute function public.reject_legacy_prayer_writes();

drop trigger if exists prayer_sheets_read_only on public.match_rounds;
create trigger prayer_sheets_read_only
  before insert or update or delete or truncate on public.match_rounds
  for each statement execute function public.reject_legacy_prayer_writes();

drop trigger if exists prayer_sheets_read_only on public.match_groups;
create trigger prayer_sheets_read_only
  before insert or update or delete or truncate on public.match_groups
  for each statement execute function public.reject_legacy_prayer_writes();

drop trigger if exists prayer_sheets_read_only on public.match_members;
create trigger prayer_sheets_read_only
  before insert or update or delete or truncate on public.match_members
  for each statement execute function public.reject_legacy_prayer_writes();

drop trigger if exists prayer_sheets_read_only on public.participant_submissions;
create trigger prayer_sheets_read_only
  before insert or update or delete or truncate on public.participant_submissions
  for each statement execute function public.reject_legacy_prayer_writes();

commit;
