-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

create table if not exists group_blocklist (
  group_id text primary key,
  name text,
  at timestamptz not null default now()
);

alter table group_blocklist enable row level security;
