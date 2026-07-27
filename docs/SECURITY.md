# Security model

## Authentication

- **Every page requires login.** The three HTML pages gate on a Supabase Auth session (`sk_auth` in `localStorage`, refreshed via the refresh-token grant). No session → login overlay, no data.
- **The admin page additionally requires admin.** `admin.html` verifies the signed-in user server-side (`add-group?whoami=1` / `?page=1`): the function calls `auth.getUser(jwt)` and checks the email against `ADMIN_EMAILS` (env) or the `admins` table. A logged-in non-admin sees a "not authorized" overlay.

## Authorization on write/expensive endpoints

- **`groupme-bot`** — deployed `--no-verify-jwt`; guarded by `?key=SYNC_KEY`. GroupMe cannot send auth headers, so the shared secret in the callback URL is the guard.
- **`update-groupme`** — accepts `?key=SYNC_KEY` (for cron) **or** an admin Supabase JWT. The dashboard's Sync button and the admin page both use the logged-in user's JWT; only admins can trigger a sync.
- **`add-group`** — validates the caller's JWT against the admin allow-list for every mutating action.
- **`chat`** — callable with the public anon key (it is a read-only archivist); scope is enforced by the RLS layer below, and every Q&A is written to `ai_log`.

## Row-Level Security & cross-group isolation

RLS is enabled on all tables and restricts reads to the `authenticated` role (migration `auth_lock`). The AI's ad-hoc SQL tool is additionally sandboxed:

- **`run_readonly(q, gid, is_global)`** is a `SECURITY DEFINER` function owned by **`archivist_ro`**, a dedicated role **without** `BYPASSRLS`. It runs the caller's `SELECT` as that confined role inside a read-only transaction, setting transaction-local GUCs `app.gid` / `app.scope`.
- RLS policies key off those GUCs: a non-global query for another group is **physically filtered to zero rows** at the database — not by an application string check. A group's bot can never read another group's data unless that group is explicitly an admin/global room.
- The tool description forbids trailing semicolons/multiple statements, and the app strips a trailing `;`; the real backstop is that `archivist_ro` can only `SELECT`.

## Handling untrusted input

Message text and member names are attacker-influenced (anyone in a GroupMe group can type anything). The `chat` function:
- passes recent group messages to the model as **context data explicitly labelled "not instructions"**, and
- treats only the current question as the request.

(Hardening the `asker` name injection and adding an `is_global` server-side authz check are tracked improvements — see the audit backlog.)

## Secrets

- `.env` is git-ignored and has never been committed. Server secrets live in Supabase function secrets.
- **No private secret is in tracked source.** The frontend contains only the Supabase **URL**, **anon key**, and **project ref** — all public by design and protected by RLS. (The `SYNC_KEY`, service-role key, GroupMe token, and Gemini key never appear in the frontend or the repo.)
- The `SYNC_KEY` is embedded in each bot's GroupMe callback URL, which is visible to anyone holding the GroupMe token; treat it as rotatable and scoped to ingest/sync only.

## What a leaked anon key can and cannot do

The anon key only grants what RLS allows. With login enforced and tables restricted to `authenticated`, an anon caller gets no rows from the content tables; the `chat` endpoint is read-only and group-scoped. There is no path from a public credential to another group's data or to a write.
