# The AI archivist

The `chat` Edge Function answers natural-language questions about the archive, in the dashboard chat panel and from GroupMe (`@SKChats <question>`).

## Request

```
POST /functions/v1/chat
{
  group_id,            // focused group
  messages: [{ role: 'user'|'model', text }],
  global?,             // dashboard: allow cross-group queries (focused group is default)
  admin_room?,         // bot in an admin/global control room: global-first
  style?,              // 'short' => one plain-text paragraph, <400 chars (bot replies)
  asker?, asker_uid?,  // who is asking (resolves "my points", "me")
  source?,             // 'dashboard' | 'bot' (for ai_log)
  context?             // recent group messages + reply target (bot follow-ups)
}
=> { answer, tools_used, model }
```

## Model fallback

`MODELS` is a chain (overridable via the `GEMINI_MODELS` secret), default order roughly `gemini-3.1-flash-lite → gemini-3.5-flash-lite → gemma-4-31b-it → gemma-4-26b-a4b-it → premium flashes → 2.x`. On `429` the function advances to the next model; on `5xx` it retries once. This keeps the bot answering within free-tier daily limits.

## Tools (function calling)

| Tool | Purpose |
|---|---|
| `search_messages` | Full-text search this group (websearch syntax, optional member/date bounds) |
| `get_context` | N messages around a timestamp or message id |
| `run_sql` | One read-only `SELECT` over the schema, RLS-confined (see [SECURITY.md](SECURITY.md)) |
| `leaderboard` | Points board for a period (`all`/`day`/`week`/`month`/`year`) |
| `list_admins` | Live owner/admins from synced roles |
| `member_lookup` | Resolve a person by any nickname/uid → profile, member number, aliases, timeline, rank |

The loop runs up to ~10 hops; if the tool budget is exhausted it asks the model for a best-effort final answer from the results gathered.

## Scope model

- **Per-group (default for a group's bot):** the brief tells the model it can only see this group; tools return nothing for others. For questions *about* another chat, it uses the framing *"I don't have access to other chats, but from what's been discussed here, …"* — answering only from what this group's messages actually mention, never fabricating.
- **Global (dashboard focused-group, or admin room):** `run_sql` reads across all groups; the structured tools still cover only the focused group, so cross-group work goes through SQL. An admin/global room is global-first and ignores its own console membership.

## Accuracy guardrails (in the system brief)

Built from real failure modes observed in `ai_log`:

- **No fabricated numbers.** The model may not state any statistic (points, rank, counts, dates) unless a tool returned it *that turn*. Definitional questions ("what are points?") get the definition only — no invented personal total.
- **Asker identity injected** so "my points" / "me" resolve to the right `user_id`; never guess a total.
- **member #N is join order, not rank.** Rank comes from the leaderboard / `member_lookup`.
- **Events vs people.** "How many were kicked" = `count(distinct subject_uid)`, not a raw event count.
- **No invented real names or promotion dates.** Nicknames are self-chosen handles; the DB does not record when anyone was promoted.
- **Recency weighting** for "who's valuable / deserves promoting" questions.
- **Evidence-based purpose inference** for "what is this group for" — from earliest + recent messages, without inventing an origin story.

Every question and answer (with the model and tools used) is written to `ai_log`, viewable on the admin page — the feedback loop for tuning the brief.

> Known open items are tracked in the audit backlog (period boards use rolling windows vs calendar boundaries; likes-given period attribution; `is_global` server-side authz; ambiguous-name disambiguation).
