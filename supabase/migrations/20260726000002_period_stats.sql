-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

create or replace function period_stats(gid text, since_ts bigint)
returns table(user_id text, name text, msgs bigint, likes bigint)
language sql
security definer
set search_path = public
as $fn$
  select m.user_id, max(mb.current_name) as name, count(*) as msgs, coalesce(sum(m.likes), 0) as likes
  from messages m
  join members mb on mb.group_id = m.group_id and mb.user_id = m.user_id and mb.is_bot = false
  where m.group_id = gid and m.created_at >= since_ts
    and m.system = false and coalesce(m.sender_type, '') not in ('system', 'bot') and m.user_id is not null
  group by m.user_id;
$fn$;

grant execute on function period_stats(text, bigint) to anon, authenticated;
