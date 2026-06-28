-- Persist the DB pieces used by the 許願池 writer-reply and notification-centre settings features.
-- Safe to run repeatedly.

begin;

alter table public.profiles
  add column if not exists wish_reply boolean default false;

create table if not exists public.app_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

commit;
