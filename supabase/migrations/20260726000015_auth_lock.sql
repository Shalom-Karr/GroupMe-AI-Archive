-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

-- Admins table controls who can use the admin page.
create table if not exists admins (
  email text primary key,
  added_at timestamptz not null default now()
);
alter table admins enable row level security;
insert into admins (email) values ('shalomkarr@gmail.com') on conflict do nothing;

-- Lock all readable data to LOGGED-IN users only (was anon + authenticated).
-- Anon (logged-out) can no longer read anything; the frontends must send a user JWT.
drop policy if exists "public read messages"      on public.messages;
drop policy if exists "public read members"       on public.members;
drop policy if exists "public read events"        on public.events;
drop policy if exists "public read member_scores" on public.member_scores;
drop policy if exists "public read group_stats"   on public.group_stats;

create policy "auth read messages"      on public.messages      for select to authenticated using (true);
create policy "auth read members"       on public.members       for select to authenticated using (true);
create policy "auth read events"        on public.events        for select to authenticated using (true);
create policy "auth read member_scores" on public.member_scores for select to authenticated using (true);
create policy "auth read group_stats"   on public.group_stats   for select to authenticated using (true);

-- RPCs that back the dashboards must not be callable by anon anymore.
revoke execute on function public.leaderboard(text, bigint, boolean) from anon;
revoke execute on function public.period_stats(text, bigint)         from anon;
revoke execute on function public.likes_given(text, bigint)          from anon;
revoke execute on function public.global_leaderboard(integer)        from anon;
