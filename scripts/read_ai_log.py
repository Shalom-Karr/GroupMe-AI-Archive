# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Print the AI question log (from ai_log), newest first."""

import sys

from supa_sql import run_sql

limit = sys.argv[1] if len(sys.argv) > 1 else "30"
rows = run_sql(
    "select l.created_at, l.source, l.asker_name, "
    "coalesce(g.group_name, l.group_id) as grp, l.question, l.answer, l.model "
    "from ai_log l left join group_stats g on g.group_id = l.group_id "
    f"order by l.created_at desc limit {int(limit)}"
)
print(f"{len(rows)} logged AI questions (newest first):\n")
for r in rows:
    when = str(r["created_at"])[:16].replace("T", " ")
    who = r["asker_name"] or r["source"]
    print("=" * 72)
    print(f"[{when}] {who} in {r['grp']}  ({r['model']})")
    print("Q:", (r["question"] or "").strip())
    print("A:", (r["answer"] or "").strip())
