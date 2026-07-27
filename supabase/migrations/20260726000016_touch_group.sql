-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

-- Called by the bot on each ingested message to keep group_stats roughly live between
-- 6-hourly full reconciliations (which recompute the exact count).
create or replace function touch_group(gid text, ts bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update group_stats
     set message_count = message_count + 1,
         last_ts = greatest(coalesce(last_ts, 0), ts)
   where group_id = gid;
$$;

revoke all on function touch_group(text, bigint) from public, anon, authenticated;
grant execute on function touch_group(text, bigint) to service_role;
