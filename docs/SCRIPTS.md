# Scripts

Python ops/setup utilities in `scripts/`. **Run them from the repo root** (`python scripts/<name>.py …`) — they locate the repo-root `.env` by walking up from their own directory, and shared helpers import `supa_sql`.

Requires Python 3.11+ and `requests`. Secrets come from `.env` (see [SETUP.md](SETUP.md#configuration)).

| Script | Purpose | Usage |
|---|---|---|
| `supa_sql.py` | Run SQL via the Supabase Management API (no DB password needed). Also the shared `env()` / `run_sql()` helper other scripts import. | `python scripts/supa_sql.py "select 1"` · `python scripts/supa_sql.py --file supabase/migrations/x.sql` |
| `seed_group.py` | **Add a chat:** download a group's full history (if needed) and bulk-insert it into Supabase. Safe to re-run. | `python scripts/seed_group.py --group <id>` |
| `download_groupme.py` | Full-history backfill to `groupme_<id>_messages.json` (resumable, rate-limit aware). Token: `--token`, `GROUPME_TOKEN`, `.env`, or `token.txt`. | `python scripts/download_groupme.py --group <id> [--years N]` |
| `update_list.py` | Incremental JSON update — fetch new messages since the last archive and merge. | `python scripts/update_list.py --group <id>` |
| `backfill_loop.py` | Loop the `add-group` function until a group's history is fully backfilled. | `python scripts/backfill_loop.py <id>` |
| `create_bot.py` | Create the SKChats bot for a group and register its id. | `python scripts/create_bot.py <id>` |
| `fix_bot.py` | Recreate a broken bot and re-register it in the `bots` table. | `python scripts/fix_bot.py <group_id> [old_bot_id]` |
| `setup_auth.py` | Create the admin auth user for the gated admin page. | `python scripts/setup_auth.py` |
| `setup_cron.py` | Enable pg_cron + pg_net and schedule the reconciliation sync (interval set in the script; the platform runs it as the safety net alongside real-time ingest). | `python scripts/setup_cron.py` |
| `read_ai_log.py` | Print the AI question log (`ai_log`), newest first. | `python scripts/read_ai_log.py` |
| `fetch_logs.py` | Fetch recent Edge Function logs via the Management API. | `python scripts/fetch_logs.py <function>` |
| `probe_ai.py` | Adversarial probe of the archivist via the bot `?dry=1` endpoint; prints Q/A for review. | `python scripts/probe_ai.py` |
| `test_models.py` | Run the same question through candidate Gemini/Gemma models with real tools, to compare. | `python scripts/test_models.py` |
| `test_authflow.py` | End-to-end auth test with a throwaway user (creates, tests, deletes). | `python scripts/test_authflow.py` |

> `probe_ai.py`, `test_models.py`, and `test_authflow.py` are development/verification helpers, not part of normal operation.
