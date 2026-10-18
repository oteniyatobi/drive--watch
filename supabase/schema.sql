-- DriverWatch — Supabase schema
-- Run once in Supabase Dashboard → SQL Editor → New query → Run.
-- Replaces the Firestore collections users/{uid} and users/{uid}/recordings/{id}.

-- ─────────────────────────────────────────────
-- PROFILES  (was Firestore: users/{uid})
-- ─────────────────────────────────────────────
create table if not exists public.profiles (
    id                        uuid primary key references auth.users (id) on delete cascade,
    driver_name               text not null,
    sex                       text,
    email                     text,
    phone                     text,
    emergency_contact_name    text,
    emergency_contact_phone   text,
    location_consent_granted  boolean not null default false,
    created_at                timestamptz not null default now(),
    updated_at                timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: read own"   on public.profiles;
drop policy if exists "profiles: insert own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;

create policy "profiles: read own"   on public.profiles for select using (auth.uid() = id);
create policy "profiles: insert own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles: update own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end $$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
    before update on public.profiles
    for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- RECORDINGS  (was Firestore: users/{uid}/recordings/{id})
-- Video files stay in Cloudinary; this table holds metadata + URL.
-- ─────────────────────────────────────────────
create table if not exists public.recordings (
    user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
    id              text not null,
    reference_id    text,
    driver_name     text,
    url             text,
    public_id       text,
    storage_backend text not null default 'cloudinary',
    type            text,
    readable_time   text,
    created_at      timestamptz not null default now(),
    primary key (user_id, id)
);

create index if not exists recordings_user_created_idx on public.recordings (user_id, created_at desc);

alter table public.recordings enable row level security;

drop policy if exists "recordings: read own"   on public.recordings;
drop policy if exists "recordings: insert own" on public.recordings;
drop policy if exists "recordings: delete own" on public.recordings;

create policy "recordings: read own"   on public.recordings for select using (auth.uid() = user_id);
create policy "recordings: insert own" on public.recordings for insert with check (auth.uid() = user_id);
create policy "recordings: delete own" on public.recordings for delete using (auth.uid() = user_id);

-- Live vault updates (replaces Firestore onSnapshot)
do $$
begin
    alter publication supabase_realtime add table public.recordings;
exception when duplicate_object then null;
end $$;
