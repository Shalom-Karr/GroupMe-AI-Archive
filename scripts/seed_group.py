# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Seed a GroupMe group's full history into the Supabase database.

Usage: python seed_group.py [--group GROUP_ID]
Downloads full history first if groupme_<id>_messages.json doesn't exist,
then bulk-inserts messages + computed members/events via the Management API.
Re-running is safe (ON CONFLICT DO NOTHING). Add any chat you're a member of.
"""

import argparse
import json
import os
import subprocess
import sys
import time

import requests

from supa_sql import run_sql, env

HERE = os.path.dirname(os.path.abspath(__file__))
BATCH = 500


def gm_token():
    for line in open(os.path.join(HERE, ".env"), encoding="utf-8"):
        if line.startswith("GROUPME_TOKEN="):
            return line.split("=", 1)[1].strip()
    sys.exit("GROUPME_TOKEN not in .env")


def group_info(gid):
    r = requests.get(f"https://api.groupme.com/v3/groups/{gid}", params={"token": gm_token()}, timeout=30)
    r.raise_for_status()
    g = r.json()["response"]
    return g.get("name") or gid, g.get("image_url") or ""


def dollar_quote(s):
    tag = "JB1"
    while f"${tag}$" in s:
        tag += "x"
    return f"${tag}${s}${tag}$"


def sql_str(s):
    return "'" + str(s).replace("'", "''") + "'"


def build_numbering(msgs):
    member_no, counter = {}, [0]

    def assign(uid):
        uid = str(uid)
        if uid and uid != "None" and uid not in member_no:
            counter[0] += 1
            member_no[uid] = counter[0]

    for m in msgs:
        dd = (m.get("event") or {}).get("data") or {}
        if dd.get("adder_user"): assign(dd["adder_user"].get("id"))
        for u in dd.get("added_users") or []: assign(u.get("id"))
        if dd.get("user"): assign(dd["user"].get("id"))
        if dd.get("remover_user"): assign(dd["remover_user"].get("id"))
        if dd.get("removed_user"): assign(dd["removed_user"].get("id"))
        if not m.get("system") and m.get("sender_type") not in ("system", "bot") and m.get("user_id"):
            assign(m["user_id"])
    return member_no


def build_members_events(msgs, gid):
    member_no = build_numbering(msgs)
    members, events = {}, []
    for m in msgs:
        ts = m["created_at"]
        ev = m.get("event") or {}
        dd = ev.get("data") or {}
        if dd:
            adder = dd.get("adder_user")
            for u in dd.get("added_users") or []:
                events.append((ts, "added", str(u.get("id")), u.get("nickname"),
                               str(adder.get("id")) if adder else None, adder.get("nickname") if adder else None, None))
            if dd.get("user") and "rejoin" in (ev.get("type") or ""):
                u = dd["user"]
                events.append((ts, "rejoined", str(u.get("id")), u.get("nickname"), None, None, None))
            if dd.get("removed_user"):
                u, rv = dd["removed_user"], dd.get("remover_user")
                events.append((ts, "removed" if rv else "left", str(u.get("id")), u.get("nickname"),
                               str(rv.get("id")) if rv else None, rv.get("nickname") if rv else None, None))
        uid = str(m.get("user_id") or "")
        if not uid or m.get("system") or m.get("sender_type") == "system":
            continue
        is_bot = m.get("sender_type") == "bot"
        mb = members.setdefault(uid, {"member_no": member_no.get(uid), "is_bot": is_bot, "msg_count": 0,
                                      "likes_received": 0, "first_ts": ts, "last_ts": ts,
                                      "current_name": None, "names": []})
        mb["msg_count"] += 1
        mb["likes_received"] += len(m.get("favorited_by") or [])
        mb["last_ts"] = ts
        n = m.get("name")
        if n and n != mb["current_name"]:
            if mb["current_name"] is not None:
                events.append((ts, "renamed", uid, n, None, None, f'{mb["current_name"]} -> {n}'))
            mb["current_name"] = n
            if n not in [x["name"] for x in mb["names"]]:
                mb["names"].append({"name": n, "first_used": ts})
    return members, events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default="104645947")
    args = ap.parse_args()
    gid = args.group

    json_path = os.path.join(HERE, f"groupme_{gid}_messages.json")
    if not os.path.exists(json_path):
        print(f"No local archive for {gid}, downloading full history first...")
        subprocess.run([sys.executable, os.path.join(HERE, "download_groupme.py"),
                        "--group", gid, "--years", "50"], check=True)

    msgs = json.load(open(json_path, encoding="utf-8"))
    msgs.sort(key=lambda m: m["created_at"])
    gname, gavatar = group_info(gid)
    print(f"Seeding {len(msgs)} messages from \"{gname}\" ({gid})")

    start = time.time()
    for i in range(0, len(msgs), BATCH):
        chunk = msgs[i:i + BATCH]
        payload = dollar_quote(json.dumps(chunk, ensure_ascii=False))
        q = f"""
insert into messages (group_id, id, group_name, group_avatar, created_at, user_id, name, text, sender_type, system, likes, raw)
select {sql_str(gid)}, j->>'id', {sql_str(gname)}, {sql_str(gavatar)}, (j->>'created_at')::bigint,
       j->>'user_id', j->>'name', j->>'text', j->>'sender_type',
       coalesce((j->>'system')::boolean, false),
       coalesce(jsonb_array_length(j->'favorited_by'), 0), j
from jsonb_array_elements({payload}::jsonb) j
on conflict (group_id, id) do nothing;"""
        run_sql(q)
        done = min(i + BATCH, len(msgs))
        if done % 5000 < BATCH or done == len(msgs):
            rate = done / max(time.time() - start, 1)
            print(f"  {done}/{len(msgs)} messages ({rate:.0f}/s)")

    print("Computing members + events...")
    members, events = build_members_events(msgs, gid)

    mrows = [{"user_id": uid, **mb} for uid, mb in members.items()]
    for i in range(0, len(mrows), BATCH):
        payload = dollar_quote(json.dumps(mrows[i:i + BATCH], ensure_ascii=False))
        run_sql(f"""
insert into members (group_id, user_id, member_no, current_name, is_bot, msg_count, likes_received, first_ts, last_ts, names)
select {sql_str(gid)}, j->>'user_id', (j->>'member_no')::int, j->>'current_name',
       (j->>'is_bot')::boolean, (j->>'msg_count')::int, (j->>'likes_received')::int,
       (j->>'first_ts')::bigint, (j->>'last_ts')::bigint, j->'names'
from jsonb_array_elements({payload}::jsonb) j
on conflict (group_id, user_id) do update set
  member_no = excluded.member_no, current_name = excluded.current_name,
  msg_count = excluded.msg_count, likes_received = excluded.likes_received,
  first_ts = excluded.first_ts, last_ts = excluded.last_ts, names = excluded.names;""")
    print(f"  {len(mrows)} members")

    run_sql(f"delete from events where group_id = {sql_str(gid)};")
    erows = [{"ts": e[0], "type": e[1], "subject_uid": e[2], "subject_name": e[3],
              "actor_uid": e[4], "actor_name": e[5], "detail": e[6]} for e in events]
    for i in range(0, len(erows), BATCH):
        payload = dollar_quote(json.dumps(erows[i:i + BATCH], ensure_ascii=False))
        run_sql(f"""
insert into events (group_id, ts, type, subject_uid, subject_name, actor_uid, actor_name, detail)
select {sql_str(gid)}, (j->>'ts')::bigint, j->>'type', j->>'subject_uid', j->>'subject_name',
       j->>'actor_uid', j->>'actor_name', j->>'detail'
from jsonb_array_elements({payload}::jsonb) j;""")
    print(f"  {len(erows)} events")

    total = run_sql(f"select count(*) n from messages where group_id = {sql_str(gid)};")
    print(f"Done in {time.time() - start:.0f}s. DB now has {total[0]['n']} messages for \"{gname}\".")


if __name__ == "__main__":
    main()
