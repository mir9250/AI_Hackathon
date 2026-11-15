-- Apply once after reviewing. Shared only among signed-in, non-anonymous members.
begin;
create table public.community_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);
create table public.community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index community_posts_created_idx on public.community_posts(created_at desc, id);
create index community_comments_post_idx on public.community_comments(post_id, created_at, id);
create index community_posts_user_idx on public.community_posts(user_id);
create index community_comments_user_idx on public.community_comments(user_id);
alter table public.community_posts enable row level security;
alter table public.community_comments enable row level security;
revoke all on public.community_posts, public.community_comments from anon, authenticated;
grant select, delete on public.community_posts, public.community_comments to authenticated;
grant insert (title, body) on public.community_posts to authenticated;
grant insert (post_id, body) on public.community_comments to authenticated;
create policy community_posts_read on public.community_posts for select to authenticated
 using ((select auth.uid()) is not null and coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false');
create policy community_posts_create on public.community_posts for insert to authenticated
 with check ((select auth.uid()) = user_id and coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false');
create policy community_posts_delete on public.community_posts for delete to authenticated using ((select auth.uid()) = user_id);
create policy community_comments_read on public.community_comments for select to authenticated
 using ((select auth.uid()) is not null and coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false');
create policy community_comments_create on public.community_comments for insert to authenticated
 with check ((select auth.uid()) = user_id and coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false');
create policy community_comments_delete on public.community_comments for delete to authenticated using ((select auth.uid()) = user_id);
commit;
