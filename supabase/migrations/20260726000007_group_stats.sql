-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

create table if not exists group_stats (
  group_id text primary key,
  group_name text,
  group_avatar text,
  message_count bigint not null default 0,
  first_ts bigint,
  last_ts bigint,
  updated_at timestamptz not null default now()
);

alter table group_stats enable row level security;
drop policy if exists "public read group_stats" on group_stats;
create policy "public read group_stats" on group_stats for select using (true);

insert into group_stats (group_id, group_name, group_avatar, message_count, first_ts, last_ts)
select group_id,
       (array_agg(group_name order by created_at desc))[1],
       (array_agg(group_avatar order by created_at desc))[1],
       count(*), min(created_at), max(created_at)
from messages
group by group_id
on conflict (group_id) do update set
  group_name = excluded.group_name,
  group_avatar = excluded.group_avatar,
  message_count = excluded.message_count,
  first_ts = excluded.first_ts,
  last_ts = excluded.last_ts,
  updated_at = now();

create or replace view groups_view as
select group_id, group_name, group_avatar, message_count, first_ts, last_ts
from group_stats;
