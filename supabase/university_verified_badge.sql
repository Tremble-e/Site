-- 2.36.27 — Expose uniquement un booléen public de vérification universitaire.
-- Aucune adresse universitaire n'est rendue publique.

alter table public.profiles
    add column if not exists university_verified boolean not null default false;

update public.profiles p
set university_verified = exists (
    select 1
    from public.ade_verifications v
    where v.user_id = p.user_id
      and v.verified_at is not null
);

create or replace function public.sync_profile_university_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'DELETE' then
        update public.profiles
        set university_verified = false
        where user_id = old.user_id;
        return old;
    end if;

    update public.profiles
    set university_verified = (new.verified_at is not null)
    where user_id = new.user_id;
    return new;
end;
$$;

drop trigger if exists ade_verification_profile_badge_sync on public.ade_verifications;
create trigger ade_verification_profile_badge_sync
after insert or update or delete on public.ade_verifications
for each row execute function public.sync_profile_university_verified();

revoke all on function public.sync_profile_university_verified() from public;
