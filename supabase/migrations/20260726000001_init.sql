-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

create table if not exists messages (
  group_id text not null,
  id text not null,
  group_name text,
  group_avatar text,
  created_at bigint not null,
  user_id text,
  name text,
  text text,
  sender_type text,
  system boolean not null default false,
  likes integer not null default 0,
  raw jsonb not null,
  fts tsvector generated always as (to_tsvector('english', coalesce(text, ''))) stored,
  primary key (group_id, id)
);

create index if not exists idx_messages_group_time on messages (group_id, created_at);
create index if not exists idx_messages_group_user on messages (group_id, user_id, created_at);
create index if not exists idx_messages_fts on messages using gin (fts);

create table if not exists members (
  group_id text not null,
  user_id text not null,
  member_no integer,
  current_name text,
  is_bot boolean not null default false,
  msg_count integer not null default 0,
  likes_received integer not null default 0,
  first_ts bigint,
  last_ts bigint,
  names jsonb not null default '[]',
  primary key (group_id, user_id)
);

create table if not exists events (
  id bigint generated always as identity primary key,
  group_id text not null,
  ts bigint not null,
  type text not null,
  subject_uid text,
  subject_name text,
  actor_uid text,
  actor_name text,
  detail text
);

create index if not exists idx_events_group_subject on events (group_id, subject_uid, ts);
create index if not exists idx_events_group_time on events (group_id, ts);

create or replace view groups_view as
select distinct on (group_id)
  group_id,
  group_name,
  group_avatar,
  (select count(*) from messages m2 where m2.group_id = m.group_id) as message_count,
  (select min(created_at) from messages m3 where m3.group_id = m.group_id) as first_ts,
  (select max(created_at) from messages m4 where m4.group_id = m.group_id) as last_ts
from messages m
order by group_id, created_at desc;

alter table messages enable row level security;
alter table members enable row level security;
alter table events enable row level security;

create policy "public read messages" on messages for select using (true);
create policy "public read members" on members for select using (true);
create policy "public read events" on events for select using (true);

create or replace function run_readonly(q text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if q ~* '\m(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|vacuum)\M' then
    raise exception 'only read-only SELECT queries are allowed';
  end if;
  if q !~* '^\s*(select|with)\M' then
    raise exception 'only read-only SELECT queries are allowed';
  end if;
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', q) into result;
  return result;
end;
$$;

revoke all on function run_readonly(text) from public, anon, authenticated;
