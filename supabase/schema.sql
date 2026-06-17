-- ============================================================
-- 預言家日報 (The Prophet's Daily) - Supabase Schema
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- Enable UUID extension (usually pre-enabled on Supabase)
create extension if not exists "uuid-ossp";

-- ============================================================
-- PROFILES (extends Supabase Auth users)
-- ============================================================
create table public.profiles (
  id          uuid references auth.users on delete cascade primary key,
  username    text unique not null,
  role        text not null default 'reader' check (role in ('super_admin', 'admin', 'writer', 'reader')),
  avatar_url  text,
  created_at  timestamptz default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'reader')
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- NOVELS
-- ============================================================
create table public.novels (
  id          uuid primary key default uuid_generate_v4(),
  title       text not null,
  author      text,
  description text,
  cover_url   text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ============================================================
-- CHAPTERS
-- ============================================================
create table public.chapters (
  id            uuid primary key default uuid_generate_v4(),
  novel_id      uuid references public.novels(id) on delete cascade not null,
  chapter_num   integer not null,
  title         text,
  content       text not null,           -- OCR result
  source_image  text,                    -- Supabase Storage path
  created_by    uuid references public.profiles(id),
  created_at    timestamptz default now(),
  unique(novel_id, chapter_num)
);

-- ============================================================
-- PERMISSIONS (user ↔ novel access)
-- ============================================================
create table public.permissions (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references public.profiles(id) on delete cascade not null,
  novel_id   uuid references public.novels(id) on delete cascade not null,
  granted_by uuid references public.profiles(id),
  granted_at timestamptz default now(),
  unique(user_id, novel_id)
);

-- ============================================================
-- COMMENTS
-- ============================================================
create table public.comments (
  id          uuid primary key default uuid_generate_v4(),
  chapter_id  uuid references public.chapters(id) on delete cascade not null,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  content     text not null,
  parent_id   uuid references public.comments(id) on delete cascade,  -- nested replies
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles    enable row level security;
alter table public.novels      enable row level security;
alter table public.chapters    enable row level security;
alter table public.permissions enable row level security;
alter table public.comments    enable row level security;

-- PROFILES
create policy "Public profiles are viewable by authenticated users"
  on public.profiles for select
  to authenticated using (true);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- NOVELS: everyone authenticated can see novels (content gated via chapters)
create policy "Authenticated users can view novels"
  on public.novels for select
  to authenticated using (true);

create policy "Admins can manage novels"
  on public.novels for all
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'super_admin'))
  );

-- CHAPTERS: only users with permission (or admins/writers)
create policy "Users with permission can read chapters"
  on public.chapters for select
  to authenticated
  using (
    exists (
      select 1 from public.permissions
      where user_id = auth.uid() and novel_id = chapters.novel_id
    )
    or
    exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'super_admin'))
  );

create policy "Admins can manage chapters"
  on public.chapters for all
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'super_admin', 'writer'))
  );

-- PERMISSIONS
create policy "Users can view own permissions"
  on public.permissions for select
  to authenticated
  using (user_id = auth.uid() or
    exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'super_admin'))
  );

create policy "Admins can manage permissions"
  on public.permissions for all
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'super_admin'))
  );

-- COMMENTS: only users with access to the parent novel
create policy "Users with novel access can read comments"
  on public.comments for select
  to authenticated
  using (
    exists (
      select 1 from public.chapters c
      join public.permissions p on p.novel_id = c.novel_id
      where c.id = comments.chapter_id and p.user_id = auth.uid()
    )
    or
    exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'super_admin'))
  );

create policy "Users with novel access can create comments"
  on public.comments for insert
  to authenticated
  with check (
    exists (
      select 1 from public.chapters c
      join public.permissions p on p.novel_id = c.novel_id
      where c.id = chapter_id and p.user_id = auth.uid()
    )
    and user_id = auth.uid()
  );

create policy "Users can delete own comments"
  on public.comments for delete
  using (user_id = auth.uid());

create policy "Admins can delete any comment"
  on public.comments for delete
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'super_admin'))
  );

-- ============================================================
-- INVITE TOKENS
-- ============================================================
create table public.invite_tokens (
  id          uuid primary key default uuid_generate_v4(),
  token       text unique not null default encode(gen_random_bytes(24), 'hex'),
  role        text not null default 'reader' check (role in ('admin', 'writer', 'reader')),
  created_by  uuid references public.profiles(id),
  created_at  timestamptz default now(),
  expires_at  timestamptz default (now() + interval '7 days'),
  used_by     uuid references public.profiles(id),
  used_at     timestamptz
);

alter table public.invite_tokens enable row level security;

-- NOTE: invite tokens are SECRET capabilities. They are validated server-side by
-- the FastAPI backend using the service role, so we deliberately do NOT grant
-- anon/authenticated SELECT here — that would let anyone enumerate unused tokens
-- and self-register (potentially as admin). Service role bypasses RLS.

-- Only admins/super_admin can create invite tokens
create policy "Admins can manage invite tokens"
  on public.invite_tokens for all
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role in ('super_admin', 'admin'))
  );

-- ============================================================
-- STORAGE BUCKETS (run in Dashboard > Storage, or via API)
-- ============================================================
-- Bucket: novel-images (private, requires auth)
-- insert into storage.buckets (id, name, public) values ('novel-images', 'novel-images', false);
