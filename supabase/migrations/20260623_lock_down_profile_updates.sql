-- Security migration: prevent authenticated users from changing privileged profile fields.
--
-- The application does not write to Supabase directly from the browser. Nickname, avatar,
-- password, onboarding state, role, ban status, 迷情劑 access, and auto-publish changes all
-- go through FastAPI using the server-only service-role client. Direct UPDATE access is
-- therefore unnecessary and dangerous: an "own row" RLS policy limits which row can be
-- changed, but not which columns can be changed.
--
-- Safe to run more than once.

begin;

drop policy if exists "Users can update own profile" on public.profiles;
revoke update on table public.profiles from anon, authenticated;

commit;

-- Expected result after the migration: both values are false.
select
  has_table_privilege('anon', 'public.profiles', 'UPDATE') as anon_can_update_profiles,
  has_table_privilege('authenticated', 'public.profiles', 'UPDATE') as authenticated_can_update_profiles;
