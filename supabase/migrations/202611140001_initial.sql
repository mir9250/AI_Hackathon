-- Apply once with the Supabase SQL editor / migration runner, before deployment.
begin;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.houses (
  house_id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  address text not null check (char_length(btrim(address)) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.photos (
  photo_id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses(house_id) on delete cascade,
  stage text not null check (stage in ('entry', 'exit')),
  location text not null check (char_length(btrim(location)) between 1 and 80),
  original_path text not null unique,
  preview_path text,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/heic','image/heif','image/webp')),
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  upload_id uuid not null,
  paired_entry_photo_id uuid unique,
  created_at timestamptz not null default now(),
  unique (house_id, upload_id),
  unique (photo_id, house_id),
  foreign key (paired_entry_photo_id, house_id) references public.photos(photo_id, house_id),
  check ((stage = 'entry' and paired_entry_photo_id is null) or
         (stage = 'exit' and paired_entry_photo_id is not null)),
  check (paired_entry_photo_id is distinct from photo_id)
);

create table public.analyses (
  photo_id uuid primary key references public.photos(photo_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','analyzing','completed','failed')),
  overall_result text check (overall_result in ('suspected','needs_review','none')),
  damages jsonb not null default '[]' check (jsonb_typeof(damages) = 'array'),
  model_name text, error_code text, started_at timestamptz,
  updated_at timestamptz not null default now(),
  active_request_id uuid,
  check (status <> 'completed' or overall_result is not null)
);

create table public.comparisons (
  exit_photo_id uuid primary key references public.photos(photo_id) on delete cascade,
  entry_photo_id uuid not null references public.photos(photo_id),
  status text not null default 'pending' check (status in ('pending','analyzing','completed','failed')),
  overall_result text check (overall_result in ('change_suspected','needs_review','no_visible_change')),
  changes jsonb not null default '[]' check (jsonb_typeof(changes) = 'array'),
  model_name text, error_code text, started_at timestamptz,
  updated_at timestamptz not null default now(),
  active_request_id uuid,
  check (status <> 'completed' or overall_result is not null)
);

create table public.contracts (
  contract_id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses(house_id) on delete cascade,
  source_type text not null check (source_type in ('pdf','images')),
  original_path text unique,
  page_count integer check (page_count between 1 and 20),
  upload_id uuid not null,
  upload_status text not null default 'draft' check (upload_status in ('draft','ready','deleting')),
  created_at timestamptz not null default now(),
  unique (house_id, upload_id),
  check (source_type <> 'images' or (original_path is null and (page_count is null or page_count <= 10))),
  check (upload_status <> 'ready' or (page_count is not null and
         (source_type <> 'pdf' or original_path is not null)))
);

create table public.contract_pages (
  page_id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(contract_id) on delete cascade,
  page_number integer not null check (page_number between 1 and 10),
  original_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/heic','image/heif','image/webp')),
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  unique (contract_id, page_number)
);

create table public.contract_analyses (
  contract_id uuid primary key references public.contracts(contract_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','analyzing','completed','failed')),
  document_quality text check (document_quality in ('readable','partially_readable','unreadable')),
  summary jsonb check (jsonb_typeof(summary) = 'object'),
  findings jsonb not null default '[]' check (jsonb_typeof(findings) = 'array'),
  checklist jsonb not null default '[]' check (jsonb_typeof(checklist) = 'array'),
  warnings jsonb not null default '[]' check (jsonb_typeof(warnings) = 'array'),
  model_name text, error_code text, consent_at timestamptz, started_at timestamptz,
  updated_at timestamptz not null default now(),
  active_request_id uuid,
  check (status <> 'completed' or (document_quality in ('readable','partially_readable')
         and document_quality is not null and summary is not null)),
  check (status not in ('analyzing','completed') or consent_at is not null)
);

create table public.ai_request_logs (
  request_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_type text not null check (task_type in ('photo_analysis','photo_comparison','contract_analysis')),
  resource_id uuid not null,
  status text not null check (status in ('pending','analyzing','completed','failed')),
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index ai_usage_user_date on public.ai_request_logs(user_id, created_at);
create index photos_house_created on public.photos(house_id, created_at desc);
create index contracts_house_created on public.contracts(house_id, created_at desc);

-- Internal correlation fields supplement the specification's tables, without
-- introducing user functionality. Later AI workers must compare before writing.
alter table public.analyses add foreign key (active_request_id)
  references public.ai_request_logs(request_id) on delete set null;
alter table public.comparisons add foreign key (active_request_id)
  references public.ai_request_logs(request_id) on delete set null;
alter table public.contract_analyses add foreign key (active_request_id)
  references public.ai_request_logs(request_id) on delete set null;

create function public.touch_updated_at() returns trigger language plpgsql
set search_path = '' as $$
begin
  new.updated_at = clock_timestamp();
  if tg_table_name in ('profiles', 'houses') then
    new.created_at = old.created_at;
    if new.user_id <> old.user_id then
      raise exception 'Owner cannot change' using errcode = '23514';
    end if;
    if tg_table_name = 'houses' then
      if new.house_id <> old.house_id then
        raise exception 'House identity cannot change' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger houses_touch before update on public.houses for each row execute function public.touch_updated_at();
create trigger analyses_touch before update on public.analyses for each row execute function public.touch_updated_at();
create trigger comparisons_touch before update on public.comparisons for each row execute function public.touch_updated_at();
create trigger contract_analyses_touch before update on public.contract_analyses for each row execute function public.touch_updated_at();

create function public.validate_photo_pair() returns trigger language plpgsql
set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.photo_id <> old.photo_id or new.house_id <> old.house_id
      or new.stage <> old.stage or new.paired_entry_photo_id is distinct from old.paired_entry_photo_id) then
    raise exception 'Photo identity and pairing are immutable' using errcode = '23514';
  end if;
  if new.stage = 'exit' then
    perform 1 from public.photos where photo_id = new.paired_entry_photo_id
      and house_id = new.house_id and stage = 'entry' and location = new.location for key share;
    if not found then
      raise exception 'Exit photo requires a matching entry photo and location' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger photos_pair before insert or update on public.photos for each row execute function public.validate_photo_pair();

create function public.validate_analysis_photo() returns trigger language plpgsql
set search_path = '' as $$
begin
  if tg_table_name = 'analyses' then
    perform 1 from public.photos where photo_id = new.photo_id and stage = 'entry';
  else
    perform 1 from public.photos where photo_id = new.exit_photo_id and stage = 'exit'
      and paired_entry_photo_id = new.entry_photo_id;
  end if;
  if not found then raise exception 'Invalid analysis photo' using errcode = '23514'; end if;
  return new;
end;
$$;
create trigger analyses_photo before insert or update on public.analyses for each row execute function public.validate_analysis_photo();
create trigger comparisons_photo before insert or update on public.comparisons for each row execute function public.validate_analysis_photo();

create function public.validate_contract_pages() returns trigger language plpgsql
set search_path = '' as $$
declare
  parent public.contracts;
  actual_count integer;
  highest_page integer;
begin
  if tg_table_name = 'contract_pages' then
    select * into parent from public.contracts where contract_id = new.contract_id for update;
    if parent.source_type <> 'images' or parent.upload_status <> 'draft' then
      raise exception 'Pages require an image draft' using errcode = '23514';
    end if;
  else
    if new.upload_status = 'ready' and new.source_type = 'images' then
      select count(*), max(page_number) into actual_count, highest_page
        from public.contract_pages where contract_id = new.contract_id;
      if actual_count = 0 or actual_count <> new.page_count or highest_page <> actual_count then
        raise exception 'Pages must be continuous and complete' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger pages_valid before insert or update on public.contract_pages for each row execute function public.validate_contract_pages();
create trigger contracts_complete before insert or update on public.contracts for each row execute function public.validate_contract_pages();

-- No browser write policies for file/AI tables: later backend operations will
-- enforce ownership before privileged writes. Read policies use the house owner.
alter table public.profiles enable row level security;
alter table public.houses enable row level security;
alter table public.photos enable row level security;
alter table public.analyses enable row level security;
alter table public.comparisons enable row level security;
alter table public.contracts enable row level security;
alter table public.contract_pages enable row level security;
alter table public.contract_analyses enable row level security;
alter table public.ai_request_logs enable row level security;

revoke all on public.profiles, public.houses, public.photos, public.analyses,
  public.comparisons, public.contracts, public.contract_pages, public.contract_analyses,
  public.ai_request_logs from anon, authenticated;
grant select, insert, update on public.profiles, public.houses to authenticated;
grant select on public.photos, public.analyses, public.comparisons, public.contracts,
  public.contract_pages, public.contract_analyses, public.ai_request_logs to authenticated;
grant all on public.profiles, public.houses, public.photos, public.analyses,
  public.comparisons, public.contracts, public.contract_pages, public.contract_analyses,
  public.ai_request_logs to service_role;

create policy profiles_select on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_insert on public.profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy houses_select on public.houses for select to authenticated using (user_id = (select auth.uid()));
create policy houses_insert on public.houses for insert to authenticated with check (user_id = (select auth.uid()));
create policy houses_update on public.houses for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy photos_read on public.photos for select to authenticated using (
  exists(select 1 from public.houses h where h.house_id = photos.house_id and h.user_id = (select auth.uid())));
create policy analyses_read on public.analyses for select to authenticated using (
  exists(select 1 from public.photos p where p.photo_id = analyses.photo_id));
create policy comparisons_read on public.comparisons for select to authenticated using (
  exists(select 1 from public.photos p where p.photo_id = comparisons.exit_photo_id));
create policy contracts_read on public.contracts for select to authenticated using (
  exists(select 1 from public.houses h where h.house_id = contracts.house_id and h.user_id = (select auth.uid())));
create policy pages_read on public.contract_pages for select to authenticated using (
  exists(select 1 from public.contracts c where c.contract_id = contract_pages.contract_id));
create policy contract_analyses_read on public.contract_analyses for select to authenticated using (
  exists(select 1 from public.contracts c where c.contract_id = contract_analyses.contract_id));
create policy ai_logs_read on public.ai_request_logs for select to authenticated using (user_id = (select auth.uid()));

revoke all on function public.touch_updated_at(), public.validate_photo_pair(),
  public.validate_analysis_photo(), public.validate_contract_pages() from public;

-- Private originals, previews and documents. No direct browser object policies.
insert into storage.buckets(id, name, public, file_size_limit)
  values ('deposit-private', 'deposit-private', false, 20971520);

commit;
