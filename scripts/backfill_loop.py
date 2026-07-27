# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Loop the add-group Edge Function until a group's history is fully backfilled.

Usage: python backfill_loop.py <group_id>
"""

import json
import sys

import requests

from supa_sql import env

gid = sys.argv[1] if len(sys.argv) > 1 else "104379633"
url = f"{env('SUPABASE_URL')}/functions/v1/add-group?key={env('SYNC_KEY')}"

for i in range(80):
    r = requests.post(url, json={"group_id": gid}, timeout=400).json()
    if r.get("error"):
        print("ERROR:", r["error"])
        sys.exit(1)
    if r.get("done"):
        print("DONE:", json.dumps(r))
        break
    print(f"round {i}: +{r.get('inserted')} back to {r.get('back_to')}", flush=True)
