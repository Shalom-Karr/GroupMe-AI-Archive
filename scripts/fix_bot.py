# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Recreate a broken SKChats bot for a group and re-register it. Usage: python fix_bot.py <group_id> [old_bot_id]"""
import sys, time, requests
from supa_sql import env, run_sql

gid = sys.argv[1]
old = sys.argv[2] if len(sys.argv) > 2 else None
tok = env("GROUPME_TOKEN")
cb = f"{env('SUPABASE_URL')}/functions/v1/groupme-bot?key={env('SYNC_KEY')}"

if old:
    d = requests.post("https://api.groupme.com/v3/bots/destroy", params={"token": tok}, json={"bot_id": old}, timeout=30)
    print("destroy", old, "->", d.status_code)

c = requests.post("https://api.groupme.com/v3/bots", params={"token": tok},
                  json={"bot": {"name": "SKChats", "group_id": gid, "callback_url": cb}}, timeout=30)
print("create ->", c.status_code)
bid = c.json()["response"]["bot"]["bot_id"]
print("new bot_id:", bid)
time.sleep(1)
p = requests.post("https://api.groupme.com/v3/bots/post",
                  json={"bot_id": bid, "text": "SKChats is now connected here. Try: skchats leaderboard"}, timeout=30)
print("post to new bot ->", p.status_code)
run_sql(f"update bots set bot_id = '{bid}' where group_id = '{gid}'")
print("registered in DB")
