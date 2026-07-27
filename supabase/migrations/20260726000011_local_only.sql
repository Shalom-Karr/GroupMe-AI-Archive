-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

alter table group_stats add column if not exists local_only boolean not null default false;

create or replace view groups_view as
select group_id, group_name, group_avatar, message_count, first_ts, last_ts, local_only
from group_stats;
