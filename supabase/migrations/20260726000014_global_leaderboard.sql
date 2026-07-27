-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

-- Global leaderboard: sum each person's points across all non-local-only groups.
create or replace function global_leaderboard(lim integer default 10)
returns table(user_id text, name text, points bigint, groups bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  with scoped as (
    select ms.user_id, ms.points, ms.group_id
    from member_scores ms
    join group_stats gs on gs.group_id = ms.group_id and coalesce(gs.local_only, false) = false
  ),
  latest_name as (
    select distinct on (m.user_id) m.user_id, m.current_name
    from members m
    join group_stats gs on gs.group_id = m.group_id and coalesce(gs.local_only, false) = false
    where m.is_bot = false and m.current_name is not null
    order by m.user_id, m.last_ts desc nulls last
  )
  select s.user_id,
         coalesce(l.current_name, s.user_id) as name,
         sum(s.points)::bigint as points,
         count(*)::bigint as groups
  from scoped s
  left join latest_name l on l.user_id = s.user_id
  group by s.user_id, l.current_name
  having sum(s.points) >= 0
  order by points desc
  limit lim;
$fn$;

grant execute on function global_leaderboard(integer) to anon, authenticated, service_role;
