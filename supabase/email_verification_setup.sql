-- v2.36.19 — Vérification d'accès ADE par e-mail universitaire via Supabase Auth OTP.
-- Accepte : @etu.unilim.fr (étudiants) et @unilim.fr (personnel / enseignants).
-- À exécuter une fois dans Supabase > SQL Editor.

-- Les demandes en attente sont temporaires : on peut recréer cette table sans perdre une validation existante.
drop table if exists public.ade_email_verification_codes;

create table public.ade_email_verification_codes (
    user_id uuid primary key references auth.users(id) on delete cascade,
    student_email text not null,
    shadow_auth_user_id uuid null,
    expires_at timestamptz not null,
    last_sent_at timestamptz not null default now(),
    window_started_at timestamptz not null default now(),
    sends_in_window integer not null default 1 check (sends_in_window >= 0),
    attempts integer not null default 0 check (attempts >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index ade_email_verification_codes_expires_idx
    on public.ade_email_verification_codes (expires_at);

alter table public.ade_email_verification_codes enable row level security;
-- Aucune policy : seule l'Edge Function (service role) doit accéder aux demandes.

create table if not exists public.ade_student_identities (
    user_id uuid primary key references auth.users(id) on delete cascade,
    student_email text not null unique,
    verified_at timestamptz not null default now()
);

-- Nettoie d'éventuelles anciennes liaisons orphelines avant de réinstaller la contrainte.
delete from public.ade_student_identities i
where not exists (select 1 from auth.users u where u.id = i.user_id);

-- Garantit que supprimer le compte du site libère immédiatement l'adresse universitaire.
alter table public.ade_student_identities
    drop constraint if exists ade_student_identities_user_id_fkey;
alter table public.ade_student_identities
    add constraint ade_student_identities_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;

-- Les adresses sont normalisées en minuscules par l'Edge Function ; cet index protège aussi les anciens enregistrements.
create unique index if not exists ade_student_identities_email_lower_unique
    on public.ade_student_identities (lower(student_email));

alter table public.ade_student_identities enable row level security;
-- Aucune policy : seule l'Edge Function (service role) lit/écrit cette table.

-- Si ade_verifications possède la contrainte standard, on s'assure aussi qu'elle est nettoyée avec le compte.
do $$
begin
    if to_regclass('public.ade_verifications') is not null then
        delete from public.ade_verifications v
        where not exists (select 1 from auth.users u where u.id = v.user_id);
        alter table public.ade_verifications
            drop constraint if exists ade_verifications_user_id_fkey;
        alter table public.ade_verifications
            add constraint ade_verifications_user_id_fkey
            foreign key (user_id) references auth.users(id) on delete cascade;
    end if;
end $$;
