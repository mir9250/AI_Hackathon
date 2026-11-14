-- Apply after 001–005. Living records are separate from entry/exit evidence.
begin;
create table public.living_records (
  photo_id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses(house_id) on delete cascade,
  category text not null check (category in ('mold','wall','other')),
  description text not null check (char_length(btrim(description)) between 1 and 2000),
  original_path text not null unique,
  preview_path text,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/heic','image/heif','image/webp')),
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  upload_id uuid not null,
  created_at timestamptz not null default now(),
  unique (house_id, upload_id)
);
create index living_records_house_created on public.living_records(house_id, created_at desc);
alter table public.living_records enable row level security;
revoke all on public.living_records from anon, authenticated;
grant select on public.living_records to authenticated;
grant all on public.living_records to service_role;
create policy living_records_read on public.living_records for select to authenticated using (
  exists(select 1 from public.houses h where h.house_id = living_records.house_id and h.user_id = (select auth.uid()))
);
commit;
