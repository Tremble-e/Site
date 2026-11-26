-- Liens de téléchargement des projets par système.
-- À exécuter une fois dans l'éditeur SQL du projet Supabase.
-- Le lien Windows conserve la colonne app_url et ses valeurs existantes.
begin;

alter table public.projects
    add column if not exists android_url text,
    add column if not exists mac_url text;

comment on column public.projects.app_url is 'Lien de téléchargement Windows ; un lien vide masque le bouton.';
comment on column public.projects.android_url is 'Lien de téléchargement Android ; un lien vide masque le bouton.';
comment on column public.projects.mac_url is 'Lien de téléchargement Mac ; un lien vide masque le bouton.';

notify pgrst, 'reload schema';

commit;
