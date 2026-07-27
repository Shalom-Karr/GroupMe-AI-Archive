# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Fetch recent Edge Function logs via the Supabase Management API.

Usage: python fetch_logs.py [minutes_back]
"""

import datetime
import json
import sys

import requests

from supa_sql import env


def show(sql, label):
    ref = env("SUPABASE_PROJECT_REF")
    tok = env("SUPABASE_TOKEN")
    r = requests.get(
        f"https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all",
        params={"sql": sql},
        headers={"Authorization": f"Bearer {tok}"},
        timeout=60,
    )
    data = r.json()
    rows = data.get("result", data)
    print(f"=== {label} ===")
    if not isinstance(rows, list):
        print(json.dumps(data)[:1500])
        return
    for row in rows:
        ts = row.get("timestamp")
        try:
            ts = datetime.datetime.fromtimestamp(int(ts) / 1e6).strftime("%H:%M:%S")
        except (TypeError, ValueError):
            pass
        msg = str(row.get("event_message", "")).replace("\n", " ~ ")[:300]
        extra = " ".join(f"{k}={v}" for k, v in row.items() if k not in ("timestamp", "event_message", "id"))
        print(f"{ts} | {msg} {extra}")
    print()


if __name__ == "__main__":
    show("select id, function_logs.timestamp, event_message from function_logs order by timestamp desc limit 40",
         "function console logs")
    show("select id, function_edge_logs.timestamp, event_message from function_edge_logs order by timestamp desc limit 30",
         "function requests")
