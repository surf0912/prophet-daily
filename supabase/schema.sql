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
    'reader'
  );
  return new;
end;
$$ language plpgsql security definer set search_path = '';

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

-- Profiles are deliberately NOT directly writable by anon/authenticated clients.
-- Every profile mutation goes through the FastAPI backend, whose service-role client
-- performs field-level validation and authorization. A row-only "own profile" UPDATE
-- policy would also let a user change security-sensitive columns such as role, banned,
-- mqj_access, and auto_publish.
revoke update on table public.profiles from anon, authenticated;

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

-- ============================================================
-- MIGRATIONS since the initial schema — IDEMPOTENT, SAFE TO RE-RUN.
-- Run this whole block in the SQL Editor to guarantee the DB has every
-- column/table the FastAPI backend needs (covers any migration that was
-- missed). The backend uses the service-role key, which bypasses RLS.
-- ============================================================

-- profiles: nickname, 迷情劑 access, onboarding-tour flag, ban, guide-seed flag
alter table public.profiles add column if not exists nickname     text;
alter table public.profiles add column if not exists mqj_access   text default 'none';
alter table public.profiles add column if not exists tour_seen    text;
alter table public.profiles add column if not exists banned       boolean default false;
alter table public.profiles add column if not exists guide_seeded boolean default false;

-- novels: forum/novel kind, approval status, classification, co-owners, series, guide demo
alter table public.novels add column if not exists kind         text default 'novel';
alter table public.novels add column if not exists status       text default 'pending';
alter table public.novels add column if not exists category     text;
alter table public.novels add column if not exists characters   text[] default '{}';
alter table public.novels add column if not exists owners       uuid[] default '{}';
alter table public.novels add column if not exists series       text;
alter table public.novels add column if not exists series_order integer default 0;
alter table public.novels add column if not exists is_guide     boolean default false;

-- comment_likes: per-comment likes for forum 蓋樓 (羊皮紙 已收藏)
create table if not exists public.comment_likes (
  id            uuid primary key default uuid_generate_v4(),
  novel_id      uuid references public.novels(id) on delete cascade not null,
  comment_index integer not null,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  created_at    timestamptz default now(),
  unique (novel_id, comment_index, user_id)
);

-- novel_favorites: whole-work favorites for 意若思鏡 收藏夾
create table if not exists public.novel_favorites (
  user_id    uuid references public.profiles(id) on delete cascade not null,
  novel_id   uuid references public.novels(id) on delete cascade not null,
  created_at timestamptz default now(),
  primary key (user_id, novel_id)
);

alter table public.comment_likes   enable row level security;
alter table public.novel_favorites enable row level security;
-- (No anon/authenticated policies: only the service-role backend touches these,
--  and service role bypasses RLS — so anon keys are denied by default.)

-- feedback: 許願池 (wish) + 回報問題 (bug), shared table
create table if not exists public.feedback (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('wish','bug')),
  content     text not null,
  status      text default 'open',
  admin_reply text,
  created_at  timestamptz default now()
);

-- faqs: admin-authored 常見問題
create table if not exists public.faqs (
  id          uuid primary key default uuid_generate_v4(),
  question    text not null,
  answer      text not null,
  sort_order  integer default 0,
  created_at  timestamptz default now()
);

alter table public.feedback enable row level security;
alter table public.faqs     enable row level security;

-- novel_views: per-open view log for the silent 24h "hot" ranking on the shelf
create table if not exists public.novel_views (
  id         uuid primary key default uuid_generate_v4(),
  novel_id   uuid references public.novels(id) on delete cascade not null,
  user_id    uuid references public.profiles(id) on delete cascade not null,
  created_at timestamptz default now()
);
alter table public.novel_views enable row level security;

-- ============================================================
-- COLUMNS / TABLES ADDED SINCE THE INITIAL SCHEMA
-- Idempotent (add column / create table IF NOT EXISTS) so a fresh run of this file reproduces
-- the full current production schema. Keep this in sync when the app starts using a new column.
-- ============================================================

-- profiles: settings + moderation + onboarding state the backend writes via the service role.
alter table public.profiles add column if not exists nickname     text;
alter table public.profiles add column if not exists banned       boolean default false;
alter table public.profiles add column if not exists mqj_access   text;       -- 迷情劑 access: null / 'pending' / 'approved'
alter table public.profiles add column if not exists auto_publish boolean default false;
alter table public.profiles add column if not exists guide_seeded boolean default false;
alter table public.profiles add column if not exists tour_seen    text;       -- onboarding-tour version completed
alter table public.profiles add column if not exists last_seen_at timestamptz;-- activity for the 不活躍用戶 report
alter table public.profiles add column if not exists home_chars   text;       -- hidden 心動-cover photos (comma-joined)
alter table public.profiles add column if not exists reg_ip       text;       -- (legacy) IP at sign-up; matching now uses account_signals
alter table public.profiles add column if not exists reg_fp       text;       -- (legacy) fingerprint at sign-up; matching now uses account_signals
alter table public.profiles add column if not exists flag_note    text;       -- 疑似回鍋 review note, set when a sign-up matches a banned account

-- Per-account device signals for re-registration / ban-evasion review. We accumulate every distinct
-- (kind,value) a member is seen with (did = localStorage token, fp = trait hash, ip = address) so a
-- returning banned user can be cross-matched on any device/network they have ever used.
create table if not exists public.account_signals (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('did','fp','ip')),
  value      text not null,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create unique index if not exists account_signals_uniq   on public.account_signals(user_id, kind, value);
create index        if not exists account_signals_lookup on public.account_signals(kind, value);
alter table public.account_signals enable row level security;   -- service-role only; no anon/authenticated policy
revoke all on public.account_signals from anon, authenticated;

-- novels: kind/category/characters/series/owners/status/locking the app relies on.
alter table public.novels add column if not exists kind         text default 'novel';   -- 'novel' | 'forum'
alter table public.novels add column if not exists status       text default 'pending'; -- 'pending' | 'approved'
alter table public.novels add column if not exists is_guide     boolean default false;  -- seeded 作家入職指南
alter table public.novels add column if not exists owners       uuid[] default '{}';    -- co-owners (authors)
alter table public.novels add column if not exists category     text;                   -- 吐真劑 / 迷情劑 / 儲思盆
alter table public.novels add column if not exists characters   text[] default '{}';    -- character codes
alter table public.novels add column if not exists series       text;
alter table public.novels add column if not exists series_order integer;
alter table public.novels add column if not exists locked       boolean default false;  -- author-locked (hidden from others)

-- 自創角色 (private custom characters) + their private work tags — EXPERIMENTAL.
create table if not exists public.custom_characters (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade not null,
  name       text not null,
  avatar     text,
  created_at timestamptz not null default now()
);
create table if not exists public.custom_char_tags (
  user_id    uuid references public.profiles(id) on delete cascade not null,
  char_id    uuid not null,
  novel_id   uuid references public.novels(id) on delete cascade not null,
  created_at timestamptz not null default now(),
  primary key (user_id, char_id, novel_id)
);
-- Both are written only by the FastAPI service role; keep them off-limits to anon/authenticated.
alter table public.custom_characters enable row level security;
alter table public.custom_char_tags  enable row level security;

-- ============================================================
-- API BOUNDARY LOCKDOWN
-- The browser talks only to FastAPI. Its service-role client is the sole database gateway, so
-- anon/authenticated must not be able to bypass application visibility/ownership checks by
-- calling Supabase's generated REST API directly. RLS remains enabled as defense in depth.
-- ============================================================
revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ============================================================
-- AUDIT LOG: admin actions — who approved / banned / changed role / deleted / locked / reset
-- password / changed 迷情劑 / issued or revoked invites. Written only by the FastAPI service role;
-- super_admin reads it through the backend (/permissions/audit-log).
-- ============================================================
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  actor_name  text,
  action      text not null,
  target_type text,
  target_id   text,
  detail      text,
  created_at  timestamptz not null default now()
);
alter table public.audit_log enable row level security;
revoke all privileges on table public.audit_log from anon, authenticated;
