# Changelog

Notable changes, newest first. Dates are approximate.

## 2026-07

- **Public-release prep.** Removed the `SYNC_KEY` from the dashboard (the Sync button now authenticates with the admin's JWT); moved all Python utilities to `scripts/`; verified no private secret is in tracked source or history; rewrote the README and added `docs/`.
- **Bot understands replies & follow-ups.** `@SKChats` questions now receive the recent group conversation (and any replied-to message) as context, so "help him out", "is that good?", and "who's behind me?" resolve correctly.
- **AI anti-fabrication.** Hard rule added: the archivist may not state a statistic unless a tool returned it that turn; definitional questions get the definition only (fixes invented points totals).
- **Admin page speed.** Batched identity + admin groups + AI log into a single `?page=1` call; the page reveals immediately and the GroupMe group list lazy-loads; `?list=1` pagination parallelized. Added `?group=` single-group resync to `update-groupme`.
- **Real-time ingestion.** The bot callback writes each new message straight to the archive; a reconciliation cron backfills anything missed. Parallel multi-group sync.
- **Security lockdown.** Login required on all pages; admin page gated by the `admins` table; RLS enabled on every table; the AI's SQL tool confined to a non-`BYPASSRLS` role scoped by transaction-local GUCs (cross-group isolation).
- **SKChats bot.** Callback bot answering `skchats leaderboard [period]`, `skchats list groups`, `skchats leaderboard help`, and `@skchats <question>` AI questions.
- **Multi-group.** `group_id` dimension throughout; group switcher; self-service group adding with automatic bot creation and history backfill; local-only and blocklist flags; a global admin room.
- **Leaderboard.** Points economy (messages, likes given/received, leaves, kicks, deleted messages, inactivity); day/week/month/year and global boards; materialized `member_scores` to avoid RPC timeouts.

## Earlier

- Cloud migration to Supabase (Postgres + Edge Functions) and Cloudflare Pages, with an AI archivist over the archive.
- HTML dashboard: windowed message browser, date jump, search, member filters, reply rendering, member profiles, image lightbox.
- Initial full-history GroupMe downloader to JSON (paginated back years, resumable).
