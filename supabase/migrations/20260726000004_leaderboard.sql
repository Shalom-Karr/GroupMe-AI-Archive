-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

create or replace function leaderboard(gid text, since_ts bigint, include_inactivity boolean)
returns table(
  user_id text, name text, msgs bigint, likes_rec bigint, likes_given bigint,
  lefts bigint, kicks bigint, flags bigint, inactive_months bigint, points bigint
)
language sql
security definer
set search_path = public
as $fn$
with base as (
  select mb.user_id, mb.current_name, mb.first_ts
  from members mb
  where mb.group_id = gid and mb.is_bot = false
),
msg as (
  select m.user_id, count(*) as msgs, coalesce(sum(m.likes), 0) as likes_rec
  from messages m
  where m.group_id = gid and m.created_at >= since_ts and m.system = false
    and coalesce(m.sender_type, '') not in ('system', 'bot') and m.user_id is not null
  group by m.user_id
),
giv as (
  select f.uid as user_id, count(*) as given
  from messages m, jsonb_array_elements_text(coalesce(m.raw->'favorited_by', '[]'::jsonb)) f(uid)
  where m.group_id = gid and m.created_at >= since_ts
  group by f.uid
),
ev as (
  select e.subject_uid as user_id,
         count(*) filter (where e.type = 'left') as lefts,
         count(*) filter (where e.type = 'removed') as kicks
  from events e
  where e.group_id = gid and e.ts >= since_ts
  group by e.subject_uid
),
jn as (
  select e.subject_uid as user_id, min(e.ts) as join_ts
  from events e
  where e.group_id = gid and e.type = 'added'
  group by e.subject_uid
),
flagged as (
  select m2.user_id, count(*) as flags
  from messages ev
  join messages m2 on m2.group_id = ev.group_id and m2.id = ev.raw->'event'->'data'->>'message_id'
  where ev.group_id = gid and ev.created_at >= since_ts
    and ev.raw->'event'->>'type' = 'message.deleted' and m2.user_id is not null
  group by m2.user_id
),
inact as (
  select b.user_id,
    case when include_inactivity then (
      select count(*)
      from generate_series(
        date_trunc('month', to_timestamp(coalesce(j.join_ts, b.first_ts))),
        date_trunc('month', now()),
        interval '1 month') g(mon)
      where not exists (
        select 1 from messages mm
        where mm.group_id = gid and mm.user_id = b.user_id
          and mm.system = false and coalesce(mm.sender_type, '') not in ('system', 'bot')
          and date_trunc('month', to_timestamp(mm.created_at)) = g.mon)
    ) else 0 end as inactive_months
  from base b
  left join jn j on j.user_id = b.user_id
)
select b.user_id, b.current_name as name,
  coalesce(m.msgs, 0), coalesce(m.likes_rec, 0), coalesce(g.given, 0),
  coalesce(e.lefts, 0), coalesce(e.kicks, 0), coalesce(f.flags, 0),
  coalesce(i.inactive_months, 0),
  coalesce(m.msgs, 0) + coalesce(m.likes_rec, 0) * 20 + coalesce(g.given, 0) * 10
    - coalesce(e.lefts, 0) * 25 - coalesce(e.kicks, 0) * 500 - coalesce(f.flags, 0) * 5
    - coalesce(i.inactive_months, 0) * 350 as points
from base b
left join msg m on m.user_id = b.user_id
left join giv g on g.user_id = b.user_id
left join ev e on e.user_id = b.user_id
left join flagged f on f.user_id = b.user_id
left join inact i on i.user_id = b.user_id
where since_ts = 0 or coalesce(m.msgs, 0) > 0 or coalesce(e.lefts, 0) > 0
   or coalesce(e.kicks, 0) > 0 or coalesce(g.given, 0) > 0 or coalesce(f.flags, 0) > 0
order by points desc;
$fn$;

grant execute on function leaderboard(text, bigint, boolean) to anon, authenticated;
