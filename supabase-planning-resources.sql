-- Planilim - emplois du temps partagés et préférence de chaque étudiant.
-- À exécuter une fois dans l'éditeur SQL du projet Supabase.

create table if not exists public.planning_resources (
  resource_id text primary key,
  label text not null,
  path text,
  academic_year text,
  event_count integer not null default 0,
  week_count integer not null default 0,
  payload jsonb not null,
  active boolean not null default true,
  source_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_planning_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  resource_id text references public.planning_resources(resource_id) on delete set null,
  updated_at timestamptz not null default now()
);

-- La validation ADE est distincte du compte Planilim. Elle est accordee
-- uniquement par la fonction Edge apres un retour CAS valide et n'expire pas :
-- l'etudiant ne s'authentifie donc qu'a sa premiere utilisation du planning.
create table if not exists public.ade_verifications (
  user_id uuid primary key references auth.users(id) on delete cascade,
  verified_at timestamptz not null default now(),
  provider text not null default 'unilim-cas'
);

-- Etats ephemeres utilises pendant l'aller-retour vers le CAS. Cette table
-- n'est jamais exposee aux navigateurs.
create table if not exists public.ade_verification_requests (
  state uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  service_url text not null,
  return_url text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.ade_verifications enable row level security;
alter table public.ade_verification_requests enable row level security;

drop policy if exists "users read own ade verification" on public.ade_verifications;
create policy "users read own ade verification"
on public.ade_verifications for select
to authenticated
using (auth.uid() = user_id);

create or replace function public.is_ade_verified()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.ade_verifications
    where user_id = auth.uid()
  );
$$;

revoke all on function public.is_ade_verified() from public;
grant execute on function public.is_ade_verified() to authenticated;

alter table public.planning_resources enable row level security;
alter table public.user_planning_preferences enable row level security;

drop policy if exists "authenticated users read active plannings" on public.planning_resources;
create policy "authenticated users read active plannings"
on public.planning_resources for select
to authenticated
using ((active = true and public.is_ade_verified()) or public.is_site_admin());

drop policy if exists "admins insert plannings" on public.planning_resources;
create policy "admins insert plannings"
on public.planning_resources for insert
to authenticated
with check (public.is_site_admin());

drop policy if exists "admins update plannings" on public.planning_resources;
create policy "admins update plannings"
on public.planning_resources for update
to authenticated
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "admins delete plannings" on public.planning_resources;
create policy "admins delete plannings"
on public.planning_resources for delete
to authenticated
using (public.is_site_admin());

drop policy if exists "users read own planning preference" on public.user_planning_preferences;
create policy "users read own planning preference"
on public.user_planning_preferences for select
to authenticated
using (auth.uid() = user_id and (public.is_ade_verified() or public.is_site_admin()));

drop policy if exists "users insert own planning preference" on public.user_planning_preferences;
create policy "users insert own planning preference"
on public.user_planning_preferences for insert
to authenticated
with check (auth.uid() = user_id and (public.is_ade_verified() or public.is_site_admin()));

drop policy if exists "users update own planning preference" on public.user_planning_preferences;
create policy "users update own planning preference"
on public.user_planning_preferences for update
to authenticated
using (auth.uid() = user_id and (public.is_ade_verified() or public.is_site_admin()))
with check (auth.uid() = user_id and (public.is_ade_verified() or public.is_site_admin()));

create index if not exists planning_resources_active_label_idx
  on public.planning_resources (active, label);

grant select on public.planning_resources to authenticated;
grant select, insert, update on public.user_planning_preferences to authenticated;
grant select on public.ade_verifications to authenticated;


-- Erreurs de collecte partagées entre les postes administrateur. Une erreur
-- disparaît dès que la ressource est synchronisée avec succès sur n'importe
-- quel ordinateur connecté au même compte administrateur.
create table if not exists public.planning_sync_failures (
  resource_id text primary key,
  label text,
  path text,
  error_code text not null,
  error_message text,
  attempt_count integer not null default 1,
  last_failed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.planning_sync_failures enable row level security;

drop policy if exists "admins read planning sync failures" on public.planning_sync_failures;
create policy "admins read planning sync failures"
on public.planning_sync_failures for select
to authenticated
using (public.is_site_admin());

drop policy if exists "admins insert planning sync failures" on public.planning_sync_failures;
create policy "admins insert planning sync failures"
on public.planning_sync_failures for insert
to authenticated
with check (public.is_site_admin());

drop policy if exists "admins update planning sync failures" on public.planning_sync_failures;
create policy "admins update planning sync failures"
on public.planning_sync_failures for update
to authenticated
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "admins delete planning sync failures" on public.planning_sync_failures;
create policy "admins delete planning sync failures"
on public.planning_sync_failures for delete
to authenticated
using (public.is_site_admin());

grant select, insert, update, delete on public.planning_sync_failures to authenticated;
