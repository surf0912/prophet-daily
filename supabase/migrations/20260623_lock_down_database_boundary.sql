-- Close direct Supabase API access for the FastAPI-only architecture.
-- Safe for existing data: this changes privileges and the future-signup trigger only.

begin;

-- raw_user_meta_data is editable by the signing-up user and is not authorization data.
-- Every new profile starts at reader; routers/invites.py promotes it through the service-role
-- client only after atomically claiming a valid invite.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    'reader'
  );
  return new;
end;
$$;

-- The app never queries public tables from the browser. Deny the generated REST API to both
-- public client roles; the backend service role is deliberately untouched and keeps working.
revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

-- Keep future tables/sequences closed when they are created by the SQL Editor's current role.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- The trigger may still execute internally; it does not need to be exposed as an RPC.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

commit;

-- Expected result: every value below is false.
select
  has_table_privilege('anon',          'public.profiles', 'select') as anon_profiles_select,
  has_table_privilege('authenticated', 'public.profiles', 'select') as auth_profiles_select,
  has_table_privilege('authenticated', 'public.novels',   'select') as auth_novels_select,
  has_table_privilege('authenticated', 'public.chapters', 'select') as auth_chapters_select,
  has_table_privilege('authenticated', 'public.chapters', 'insert') as auth_chapters_insert,
  has_table_privilege('authenticated', 'public.chapters', 'update') as auth_chapters_update,
  has_table_privilege('authenticated', 'public.chapters', 'delete') as auth_chapters_delete;
