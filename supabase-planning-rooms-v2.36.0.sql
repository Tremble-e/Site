-- Planilim site v2.36.0
-- Mise à jour du résumé public pour inclure les emplois du temps de salles.
-- À exécuter une fois si get_public_planning_status() est déjà déployée.

create or replace function public.get_public_planning_status()
returns table (
  available_count bigint,
  last_synced_at timestamptz,
  study_document_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)::bigint
       from public.planning_resources
      where active = true
        and (
          coalesce(path, '') like 'Groupes Etudiants > Faculté des Sciences et Techniques%'
          or coalesce(path, '') like 'Salles > LIMOGES > LIMOGES La Borie FST%'
        )) as available_count,
    (select max(coalesce(source_updated_at, updated_at))
       from public.planning_resources
      where active = true
        and (
          coalesce(path, '') like 'Groupes Etudiants > Faculté des Sciences et Techniques%'
          or coalesce(path, '') like 'Salles > LIMOGES > LIMOGES La Borie FST%'
        )) as last_synced_at,
    (select count(*)::bigint
       from public.documents
      where is_published = true) as study_document_count;
$$;

revoke all on function public.get_public_planning_status() from public;
grant execute on function public.get_public_planning_status() to anon, authenticated;
