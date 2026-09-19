-- Planilim site v2.34.0
-- Accès universitaire centralisé + documents Études privés + URL signées.
-- À exécuter UNE FOIS dans l'éditeur SQL Supabase après avoir déployé le site v2.34.0.

-- ---------------------------------------------------------------------------
-- 1) Résumé public de la disponibilité des EDT pour la page d'accueil
-- ---------------------------------------------------------------------------
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
        and coalesce(path, '') like 'Groupes Etudiants > Faculté des Sciences et Techniques%') as available_count,
    (select max(coalesce(source_updated_at, updated_at))
       from public.planning_resources
      where active = true
        and coalesce(path, '') like 'Groupes Etudiants > Faculté des Sciences et Techniques%') as last_synced_at,
    (select count(*)::bigint
       from public.documents
      where is_published = true) as study_document_count;
$$;

revoke all on function public.get_public_planning_status() from public;
grant execute on function public.get_public_planning_status() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Helper unique : compte connecté + BIOM validé, ou administrateur
-- ---------------------------------------------------------------------------
create or replace function public.has_university_content_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and (public.is_ade_verified() or public.is_site_admin());
$$;

revoke all on function public.has_university_content_access() from public;
grant execute on function public.has_university_content_access() to anon, authenticated;

create or replace function public.has_course_file_admin_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and public.is_site_admin();
$$;

revoke all on function public.has_course_file_admin_access() from public;
grant execute on function public.has_course_file_admin_access() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Études : tables invisibles sans compte BIOM validé
-- ---------------------------------------------------------------------------
revoke select on table public.subjects from anon;
revoke select on table public.documents from anon;
grant select on table public.subjects to authenticated;
grant select on table public.documents to authenticated;

alter table public.subjects enable row level security;
alter table public.documents enable row level security;

-- Politique permissive explicite pour le contenu publié.
drop policy if exists "verified users read subjects" on public.subjects;
create policy "verified users read subjects"
on public.subjects
for select
to authenticated
using (is_published = true and public.has_university_content_access());

drop policy if exists "verified users read documents" on public.documents;
create policy "verified users read documents"
on public.documents
for select
to authenticated
using (is_published = true and public.has_university_content_access());

-- L'admin doit aussi pouvoir lire les brouillons depuis son panneau.
drop policy if exists "site admins read subjects" on public.subjects;
create policy "site admins read subjects"
on public.subjects
for select
to authenticated
using (public.is_site_admin());

drop policy if exists "site admins read documents" on public.documents;
create policy "site admins read documents"
on public.documents
for select
to authenticated
using (public.is_site_admin());

-- Garde restrictive : une éventuelle ancienne politique permissive ne peut pas
-- réouvrir les tables à un utilisateur authentifié non validé BIOM.
drop policy if exists "university access required for subjects" on public.subjects;
create policy "university access required for subjects"
on public.subjects
as restrictive
for select
to authenticated
using (public.has_university_content_access());

drop policy if exists "university access required for documents" on public.documents;
create policy "university access required for documents"
on public.documents
as restrictive
for select
to authenticated
using (public.has_university_content_access());

-- ---------------------------------------------------------------------------
-- 4) Bucket course-files PRIVÉ
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('course-files', 'course-files', false)
on conflict (id) do update
set public = false;

-- Si d'anciennes lignes ont conservé uniquement l'URL publique Supabase,
-- on reconstruit d'abord storage_path automatiquement.
update public.documents
set storage_path = split_part(url, '/storage/v1/object/public/course-files/', 2)
where coalesce(storage_path, '') = ''
  and url like '%/storage/v1/object/public/course-files/%';

-- On ne conserve plus l'ancienne URL publique dans la table pour les fichiers
-- gérés par le bucket privé. Le site générera une URL signée au moment de l'accès.
update public.documents
set url = 'storage://course-files/' || storage_path
where coalesce(storage_path, '') <> '';

-- Lecture du bucket : uniquement compte BIOM validé ou admin.
drop policy if exists "course files verified read" on storage.objects;
create policy "course files verified read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'course-files'
  and public.has_university_content_access()
);

-- Garde restrictive contre une éventuelle ancienne policy SELECT trop large.
drop policy if exists "course files private read guard" on storage.objects;
create policy "course files private read guard"
on storage.objects
as restrictive
for select
to public
using (
  bucket_id <> 'course-files'
  or public.has_university_content_access()
);

-- Écriture/suppression : administrateur du site uniquement.
drop policy if exists "course files admin insert" on storage.objects;
create policy "course files admin insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'course-files'
  and public.has_course_file_admin_access()
);

drop policy if exists "course files admin update" on storage.objects;
create policy "course files admin update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'course-files'
  and public.has_course_file_admin_access()
)
with check (
  bucket_id = 'course-files'
  and public.has_course_file_admin_access()
);

drop policy if exists "course files admin delete" on storage.objects;
create policy "course files admin delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'course-files'
  and public.has_course_file_admin_access()
);

-- Garde restrictive d'écriture : même si une ancienne policy Storage était
-- permissive, les étudiants ne peuvent pas écrire/supprimer dans course-files.
drop policy if exists "course files admin insert guard" on storage.objects;
create policy "course files admin insert guard"
on storage.objects
as restrictive
for insert
to public
with check (
  bucket_id <> 'course-files'
  or public.has_course_file_admin_access()
);

drop policy if exists "course files admin update guard" on storage.objects;
create policy "course files admin update guard"
on storage.objects
as restrictive
for update
to public
using (
  bucket_id <> 'course-files'
  or public.has_course_file_admin_access()
)
with check (
  bucket_id <> 'course-files'
  or public.has_course_file_admin_access()
);

drop policy if exists "course files admin delete guard" on storage.objects;
create policy "course files admin delete guard"
on storage.objects
as restrictive
for delete
to public
using (
  bucket_id <> 'course-files'
  or public.has_course_file_admin_access()
);

-- Important : les URL externes déjà enregistrées dans public.documents ne sont
-- pas hébergées par Supabase et ne peuvent donc pas être rendues privées par
-- cette migration. Les fichiers importés dans Planilim utilisent désormais
-- course-files privé et des URL signées à durée limitée.
