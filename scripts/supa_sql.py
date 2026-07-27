# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Run SQL against the Supabase project via the Management API (no DB password needed).

Usage: python supa_sql.py --file schema.sql | python supa_sql.py "select 1"
"""

import json
import os
import sys

import requests


def env(key):
    # Walk up from this file's dir to find the repo-root .env (scripts live in scripts/).
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(4):
        p = os.path.join(d, ".env")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                for line in f:
                    if line.startswith(key + "="):
                        return line.split("=", 1)[1].strip()
            break
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    sys.exit(f"{key} not found in .env")


def run_sql(query):
    ref = env("SUPABASE_PROJECT_REF")
    token = env("SUPABASE_TOKEN")
    r = requests.post(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"query": query},
        timeout=120,
    )
    if r.status_code >= 400:
        sys.exit(f"HTTP {r.status_code}: {r.text[:2000]}")
    return r.json()


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--file":
        sql = open(sys.argv[2], encoding="utf-8").read()
    elif len(sys.argv) >= 2:
        sql = sys.argv[1]
    else:
        sys.exit("usage: python supa_sql.py --file x.sql | python supa_sql.py \"select 1\"")
    out = run_sql(sql)
    print(json.dumps(out, indent=1, default=str)[:4000])
