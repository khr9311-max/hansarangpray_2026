-- Keep PostgREST's safeupdate enabled for intentional snapshot replacement
-- and for the explicitly confirmed administrative reset.
do $migration$
declare
  target regprocedure;
  definition text;
begin
  foreach target in array array[
    'public.prayer_import(jsonb,bigint,boolean)'::regprocedure,
    'public.prayer_runtime_command(public.match_control,text,jsonb)'::regprocedure
  ] loop
    definition := pg_catalog.pg_get_functiondef(target);
    if position('delete from public.match_rounds;' in definition) = 0
        or position('delete from public.participants;' in definition) = 0 then
      raise exception 'Expected the two unfiltered deletes in %', target;
    end if;
    execute replace(
      replace(definition, 'delete from public.match_rounds;', 'delete from public.match_rounds where id is not null;'),
      'delete from public.participants;', 'delete from public.participants where id is not null;'
    );
  end loop;
end;
$migration$;
