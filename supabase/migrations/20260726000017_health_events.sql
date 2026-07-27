-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

create table if not exists health_events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  type text not null,
  severity text not null default 'warn',
  group_id text,
  detail text
);

create index if not exists idx_health_events_ts on health_events (ts desc);

alter table health_events enable row level security;

drop policy if exists health_read on health_events;
create policy health_read on health_events for select to authenticated using (true);
