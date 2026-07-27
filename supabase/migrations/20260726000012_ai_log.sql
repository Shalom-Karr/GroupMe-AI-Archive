-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

create table if not exists ai_log (
  id bigint generated always as identity primary key,
  group_id text not null,
  source text not null default 'bot',
  asker_name text,
  asker_uid text,
  question text not null,
  answer text,
  model text,
  tools jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_log_group_time on ai_log (group_id, created_at desc);
create index if not exists idx_ai_log_time on ai_log (created_at desc);

alter table ai_log enable row level security;
