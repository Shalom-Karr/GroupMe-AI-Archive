# Setup & Deployment

End-to-end guide to stand up the platform. Assumes a GroupMe account/token, a Supabase project, a Cloudflare account, Node (for `npx supabase` / `tailwindcss`), and Python 3.11+.

## 1. Supabase project

1. Create a project. Note the **project ref**, **URL** (`https://<ref>.supabase.co`), **anon key**, and a **service-role key**.
2. Create a **Management API token** (Account → Access Tokens) for `scripts/supa_sql.py`.

## 2. Apply migrations

The `supabase/migrations/` folder is ordered and idempotent-ish. Apply with the Supabase CLI:

```bash
npx supabase link --project-ref <ref>
npx supabase db push
```

Or run each file through the Management API:

```bash
for f in supabase/migrations/*.sql; do python scripts/supa_sql.py --file "$f"; done
```

Key objects created: the content tables, `member_scores` + `refresh_member_scores()`, `leaderboard()` / `global_leaderboard()`, the RLS policies, the `archivist_ro` role + `run_readonly()`, `ai_log`, `admins`, `bots`, `group_blocklist`, `touch_group()`. See [SECURITY.md](SECURITY.md) for the RLS model.

## 3. Configuration

### Local `.env` (git-ignored — never commit)

```
GROUPME_TOKEN=...            # your GroupMe access token
SUPABASE_TOKEN=...           # Supabase Management API token (for scripts)
SUPABASE_PROJECT_REF=...
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=...        # public, RLS-protected
SYNC_KEY=...                 # random shared secret guarding the bot callback + sync
GEMINI_API_KEY=...
```

### Function secrets (server-side)

```bash
npx supabase secrets set \
  GROUPME_TOKEN=... \
  GEMINI_API_KEY=... \
  SYNC_KEY=... \
  ADMIN_EMAILS="you@example.com" \
  --project-ref <ref>
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to functions automatically.
# Optional: GEMINI_MODELS="model-a,model-b,..." overrides the fallback chain.
```

`ADMIN_EMAILS` is a comma list of bootstrap admins; additional admins are managed in the `admins` table via the admin page.

## 4. Deploy the Edge Functions

```bash
npx supabase functions deploy chat --no-verify-jwt --project-ref <ref>
npx supabase functions deploy update-groupme --no-verify-jwt --project-ref <ref>
npx supabase functions deploy add-group --no-verify-jwt --project-ref <ref>
npx supabase functions deploy groupme-bot --no-verify-jwt --project-ref <ref>
```

`--no-verify-jwt` is required: `groupme-bot` and `update-groupme` are called by GroupMe/cron without a Supabase JWT and enforce their own auth (`SYNC_KEY` / admin check). `chat` and `add-group` validate the caller themselves.

## 5. Create an auth user + admin

The dashboard requires login. Create a user in Supabase Auth (Dashboard → Authentication → Users, or `scripts/setup_auth.py`), then add their email to `admins`:

```bash
python scripts/supa_sql.py "insert into admins (email) values ('you@example.com') on conflict do nothing"
```

## 6. Deploy the frontend (Cloudflare Pages)

1. Push this repo to GitHub.
2. In Cloudflare Pages, create a project connected to the repo, branch `master`, **no build command** (static), output directory = repo root.
3. Confirm `SUPA_URL` / `ANON` constants at the top of each HTML page point at your project. These are public by design (RLS-protected).

Every push to `master` redeploys.

## 7. Add your first group

Open `admin.html`, sign in, and use **Add group** (or `?list=1` to pick from your GroupMe groups). This:
- inserts the group, backfills history in chunks,
- creates the SKChats bot with its callback set to `groupme-bot?key=<SYNC_KEY>`,
- syncs live roles and refreshes scores.

To seed a group from the command line instead: `python scripts/seed_group.py --group <id>`.

## 8. Schedule the reconciliation cron

```bash
python scripts/setup_cron.py     # enables pg_cron to hit update-groupme every 6 hours
```

Real-time ingestion via the bot callback keeps data current between cron runs.

## Redeploying after changes

- **Frontend:** commit + push to `master` (Pages redeploys). Rebuild CSS first if you touched Tailwind (see README).
- **Functions:** `npx supabase functions deploy <name> --no-verify-jwt --project-ref <ref>`.
- **Schema:** add a new numbered migration and apply it.
