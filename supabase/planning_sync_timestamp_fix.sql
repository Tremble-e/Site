-- 2.36.26 — Corrige la date publique de dernière synchronisation.
-- À exécuter une fois dans Supabase > SQL Editor.

create or replace function public.get_public_planning_status()
returns table (
    available_count bigint,
    last_synced_at timestamptz,
    study_document_count bigint
)
language sql
security definer
set search_path = public
as $$
    select
        (select count(*)::bigint
           from public.planning_resources
          where coalesce(active, true) = true) as available_count,
        (select max(updated_at)
           from public.planning_resources
          where coalesce(active, true) = true) as last_synced_at,
        (select count(*)::bigint
           from public.documents
          where coalesce(is_published, true) = true) as study_document_count;
$$;

revoke all on function public.get_public_planning_status() from public;
grant execute on function public.get_public_planning_status() to anon, authenticated;
