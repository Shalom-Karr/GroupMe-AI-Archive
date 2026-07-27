-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

-- SK RouteMe (Google Voice SMS responder) state. sk_ prefix, same project.
-- RLS enabled with NO policies: SMS content is PII, reachable ONLY via the
-- service-role key inside edge functions. archivist_ro gets NO grants here,
-- so the LLM run_sql tool physically cannot read SMS.

create table if not exists sk_conversations (
  id         bigint generated always as identity primary key,
  phone      text not null,                                -- E.164 +1XXXXXXXXXX
  role       text not null check (role in ('user','model','system')),
  message    text not null,
  inbound_id text,                                          -- Gmail message id on user turns
  created_at timestamptz not null default now(),
  fts        tsvector generated always as (to_tsvector('english', coalesce(message,''))) stored
);
create index if not exists idx_sk_conv_phone_time on sk_conversations (phone, created_at desc);
create index if not exists idx_sk_conv_fts        on sk_conversations using gin (fts);
-- Plain (non-partial) unique index: NULLs are distinct, so unlimited rows with
-- inbound_id null are allowed, and PostgREST upsert (on conflict inbound_id) can
-- infer it. A partial index (where inbound_id is not null) would break that inference.
create unique index if not exists uq_sk_conv_inbound on sk_conversations (inbound_id);

create table if not exists sk_processed (
  gmail_message_id text primary key,
  phone            text,
  decision         text,            -- null=in-flight | reply|escalate|ignore|blocked|shadow
  parts            jsonb,           -- audit copy of sent parts (never re-sent on replay)
  escalation_text  text,            -- returned again on replay of an escalate decision
  created_at       timestamptz not null default now(),
  decided_at       timestamptz
);

create table if not exists sk_user_status (
  phone      text primary key,                              -- E.164
  status     text not null default 'active',                -- active | ignore | blocked
  notes      text,
  updated_at timestamptz not null default now()
);

create table if not exists sk_logs (
  id         bigint generated always as identity primary key,
  phone      text,
  keyword    text,                  -- 'AI' | 'escalate' | 'ignore' | 'shadow' | keyword | 'group-add'
  status     text not null,
  detail     jsonb,                 -- {model, tools, parts, reason, draft, category, confidence}
  created_at timestamptz not null default now()
);
create index if not exists idx_sk_logs_time  on sk_logs (created_at desc);
create index if not exists idx_sk_logs_phone on sk_logs (phone, created_at desc);

create table if not exists sk_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into sk_config(key, value) values ('canon', jsonb_build_object(
  'sign_off',      '-Answered by David AI',
  'identity_text', '<<PASTE identity copy from the live AI_SYSTEM_PROMPT property>>',
  'menu_text',     '<<PASTE the canonical chat/menu keyword list>>',
  'ad_price_text', '<<PASTE the exact current ad pricing>>',
  'sms_help_text', '<<PASTE the canonical join/SMS-help instructions>>'
)) on conflict (key) do nothing;

alter table sk_conversations enable row level security;
alter table sk_processed     enable row level security;
alter table sk_user_status   enable row level security;
alter table sk_logs          enable row level security;
alter table sk_config        enable row level security;
-- No policies on purpose: service_role (bypassrls) only.
-- Deliberately NO "grant select ... to archivist_ro" on any sk_ table.
