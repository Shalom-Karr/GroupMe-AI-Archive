-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

create table if not exists member_scores (
  group_id text not null,
  user_id text not null,
  msgs bigint not null default 0,
  likes_rec bigint not null default 0,
  likes_given bigint not null default 0,
  lefts bigint not null default 0,
  kicks bigint not null default 0,
  flags bigint not null default 0,
  inactive_months bigint not null default 0,
  points bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists idx_member_scores_points on member_scores (group_id, points desc);

alter table member_scores enable row level security;
drop policy if exists "public read member_scores" on member_scores;
create policy "public read member_scores" on member_scores for select using (true);

create or replace function refresh_member_scores(gid text)
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $fn$
begin
  delete from member_scores where group_id = gid;
  insert into member_scores (group_id, user_id, msgs, likes_rec, likes_given, lefts, kicks, flags, inactive_months, points)
  select gid, l.user_id, l.msgs, l.likes_rec, l.likes_given, l.lefts, l.kicks, l.flags, l.inactive_months, l.points
  from leaderboard(gid, 0, true) l;
end;
$fn$;

revoke all on function refresh_member_scores(text) from public, anon, authenticated;
grant execute on function refresh_member_scores(text) to service_role;

alter function leaderboard(text, bigint, boolean) set statement_timeout = '30s';
