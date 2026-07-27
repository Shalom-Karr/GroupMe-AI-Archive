-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

create or replace function likes_given(gid text, since_ts bigint)
returns table(user_id text, given bigint)
language sql
security definer
set search_path = public
as $fn$
  select f.uid as user_id, count(*) as given
  from messages m, jsonb_array_elements_text(coalesce(m.raw->'favorited_by', '[]'::jsonb)) f(uid)
  where m.group_id = gid and m.created_at >= since_ts
  group by f.uid;
$fn$;

grant execute on function likes_given(text, bigint) to anon, authenticated;
