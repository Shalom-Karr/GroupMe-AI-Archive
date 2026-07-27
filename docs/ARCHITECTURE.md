# Architecture

## Components

| Layer | Tech | Role |
|---|---|---|
| Storage | Supabase Postgres | Messages, members, events, scores, logs |
| Compute | Supabase Edge Functions (Deno/TS) | Ingest, sync, AI, admin API |
| Auth | Supabase Auth (email/password, JWT) | Login gate + admin gate |
| Scheduling | pg_cron | 6-hourly reconciliation sync |
| Frontend | Static HTML + vanilla JS + inlined Tailwind | Dashboard, leaderboard, admin |
| Hosting | Cloudflare Pages (from GitHub `master`) | Serves the three pages |
| LLM | Gemini / Gemma (Google Generative Language API) | Archivist answers |

## Data model

All content tables are keyed by `group_id` (text).

- **`messages`** — `(group_id, id)` PK. `created_at` (unix seconds), `user_id`, `name`, `text`, `sender_type` (`user`/`bot`/`system`), `system` (bool), `likes` (int), `raw` (jsonb, the full GroupMe payload), and a `fts` tsvector for full-text search. Denormalized `group_name`/`group_avatar`.
- **`members`** — `(group_id, user_id)` PK. `member_no` (join order: the Nth person to ever appear — **not** a rank), `current_name`, `role` (`owner`/`admin`/`member`/`null` = not currently in the group, synced live from GroupMe), `is_bot`, `msg_count`, `likes_received`, `first_ts`, `last_ts`, `names` (jsonb array of every nickname with first-used timestamp).
- **`events`** — one row per membership event: `type` (`added`/`removed`/`left`/`rejoined`/`renamed`), `subject_uid`/`subject_name`, `actor_uid`/`actor_name`, `ts`, `detail`. The same person can appear many times.
- **`member_scores`** — materialized points table: `(group_id, user_id)` with `msgs`, `likes_rec`, `likes_given`, `lefts`, `kicks`, `flags` (deleted messages), `inactive_months`, `points`. Refreshed by `refresh_member_scores(gid)`.
- **`group_stats`** — per-group snapshot: `group_name`, `message_count`, `first_ts`, `last_ts`, `local_only`.
- **`ai_log`** — every AI question/answer: `source` (`dashboard`/`bot`), `asker_name`, `asker_uid`, `question`, `answer`, `model`, `tools` (jsonb).
- **`bots`** — `(group_id)` → `bot_id`, `admin` (is this an admin/global control room). **`admins`** — allow-listed admin emails. **`group_blocklist`** — groups excluded from the "add group" list. **`bot_seen`** — callback dedup.

## Ingest paths

Two writers keep the archive current:

1. **Real-time (primary).** Every message GroupMe posts is pushed to the `groupme-bot` callback, which immediately upserts it into `messages`, touches `group_stats`, and incrementally maintains `members`/`events` (`maintainDerived`). This means ~0 GroupMe API requests for steady-state ingest.
2. **Reconciliation (safety net).** `update-groupme` runs every 6 hours (pg_cron), syncing all groups in parallel: it pages new messages via `after_id`, refetches the newest 100 for like updates, re-syncs live roles from the GroupMe member list, and always calls `refresh_member_scores`.

## Edge Functions

### `groupme-bot`
GroupMe callback endpoint (deployed `--no-verify-jwt`, guarded by `?key=SYNC_KEY`; `?dry=1` returns the reply as JSON instead of posting).
- Ingests every pushed message (all sender types) into the archive via `EdgeRuntime.waitUntil`.
- For `user` messages starting with `@?skchats`, routes commands: `leaderboard [today|week|month|year]`, `leaderboard help`, `list groups` (admin rooms), `help`; anything else goes to the `chat` function as an AI question.
- Acks GroupMe instantly and answers in the background (GroupMe redelivers slow callbacks → duplicate posts); dedups by `bot_seen` table + an in-memory set.
- Feeds the AI the recent group conversation (and any replied-to message) as context so follow-ups resolve.

### `update-groupme`
Reconciliation sync. `GET/POST ?key=<SYNC_KEY>` **or** an admin JWT (`Authorization: Bearer`). `?group=<id>` syncs a single group. Authorization: `isAuthorized()` accepts the sync key or a Supabase user whose email is in `ADMIN_EMAILS` or the `admins` table.

### `chat`
The AI archivist. `POST { group_id, messages, global?, admin_room?, style?, asker?, asker_uid?, source?, context? }`. Builds a per-group (or global/admin) system brief, runs a function-calling loop over the tools (`search_messages`, `get_context`, `run_sql`, `leaderboard`, `list_admins`, `member_lookup`), and falls back down a model chain on rate limits. See [AI.md](AI.md).

### `add-group`
Admin API. `?whoami=1`, `?page=1` (batched admin load: identity + admin groups + AI log), `?list=1` (your GroupMe groups not yet archived), `?admins=1`, `?logs=1`; POST actions `block`/`unblock`/`set_local`/`set_admin`/add-group. Adding a group creates the SKChats bot (`ensureBot`), backfills history in chunks, and syncs roles.

## Points

Computed per member, per group:

| Signal | Value |
|---|---|
| message sent | +1 |
| like received | +20 |
| like given | +10 |
| leave | −25 |
| kick | −500 |
| deleted message | −5 |
| inactive calendar month (all-time only) | −350 |

- **All-time** board reads the materialized `member_scores` table.
- **Period** boards (day/week/month/year) call the `leaderboard(gid, since_ts, include_inactivity)` SQL function, counting only in-window activity.
- **Global** board sums points per `user_id` across all groups where `group_stats.local_only` is not true, excluding bots and negative totals.
- Bots (`is_bot = true`) are excluded everywhere; negative totals are ranked internally but hidden in the UI.

## Frontend

- **`index.html`** — windowed message browser (PostgREST keyset pagination over `messages`), search, multi-member filter, reply-quote hydration, profile modals, image lightbox, month/date jump rail, admin-only sync button (authenticated by the user's JWT), AI chat panel, group switcher. Login-gated via a `sk_auth` session in `localStorage`; caches under the `skc2:` prefix.
- **`leaderboard.html`** — podium + ranked table from `member_scores`, period tabs, per-group or global, role badges, click-through profiles.
- **`admin.html`** — admin console; gated by the `admins` table (verified server-side).
- **`dashboard.html`** — the original offline viewer that reads a local `groupme_<id>_messages.json` archive; no backend required.
