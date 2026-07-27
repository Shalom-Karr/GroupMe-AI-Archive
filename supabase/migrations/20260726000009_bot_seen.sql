-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

create table if not exists bot_seen (
  msg_id text primary key,
  at timestamptz not null default now()
);

alter table bot_seen enable row level security;
