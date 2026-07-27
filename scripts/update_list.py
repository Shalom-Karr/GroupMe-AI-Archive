# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Fetch all new GroupMe messages since the last archive update and merge them in.

Usage: python update_list.py [--token TOKEN] [--group GROUP_ID]
Token resolution order: --token arg, GROUPME_TOKEN env var, .env file, token.txt.
Paginates forward with after_id from the newest archived message and appends
everything new to groupme_<group_id>_messages.json (kept newest first).
"""

import argparse
import json
import os
import sys
import time

import requests

API = "https://api.groupme.com/v3"
session = requests.Session()


def get_token(arg_token):
    if arg_token:
        return arg_token.strip()
    env = os.environ.get("GROUPME_TOKEN")
    if env:
        return env.strip()
    here = os.path.dirname(os.path.abspath(__file__))
    for _ in range(4):  # scripts/ live one level below the repo root that holds .env
        if os.path.exists(os.path.join(here, ".env")) or os.path.exists(os.path.join(here, "token.txt")):
            break
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    env_file = os.path.join(here, ".env")
    if os.path.exists(env_file):
        with open(env_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("GROUPME_TOKEN="):
                    tok = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if tok and tok != "PLACEHOLDER":
                        return tok
    token_file = os.path.join(here, "token.txt")
    if os.path.exists(token_file):
        with open(token_file, encoding="utf-8") as f:
            tok = f.read().strip()
        if tok:
            return tok
    sys.exit("No token found. Pass --token, set GROUPME_TOKEN, or put it in .env")


def fetch_after(token, group_id, after_id):
    params = {"token": token, "limit": 100, "after_id": after_id}
    for attempt in range(6):
        try:
            r = session.get(f"{API}/groups/{group_id}/messages", params=params, timeout=30)
        except requests.RequestException as e:
            print(f"  network error ({e}), retry {attempt + 1}/6")
            time.sleep(2 ** attempt)
            continue
        if r.status_code == 304:
            return []
        if r.status_code == 401:
            sys.exit("401 Unauthorized - token is invalid")
        if r.status_code == 404:
            sys.exit(f"404 - group {group_id} not found or you are not a member")
        if r.status_code in (429, 500, 502, 503):
            wait = 2 ** attempt * 2
            print(f"  HTTP {r.status_code}, backing off {wait}s")
            time.sleep(wait)
            continue
        r.raise_for_status()
        return r.json().get("response", {}).get("messages", []) or []
    sys.exit("Giving up after 6 failed attempts on one page")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token")
    ap.add_argument("--group", default="104645947")
    args = ap.parse_args()

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            f"groupme_{args.group}_messages.json")
    if not os.path.exists(out_path):
        sys.exit(f"{out_path} not found - run download_groupme.py first")

    with open(out_path, encoding="utf-8") as f:
        messages = json.load(f)
    if not messages:
        sys.exit("Archive is empty - run download_groupme.py first")

    token = get_token(args.token)
    known_ids = set(m["id"] for m in messages)
    newest = max(messages, key=lambda m: m["created_at"])
    print(f"Archive has {len(messages)} messages, newest from "
          f"{time.strftime('%Y-%m-%d %H:%M', time.localtime(newest['created_at']))}")

    after_id = newest["id"]
    added = 0
    while True:
        batch = fetch_after(token, args.group, after_id)
        if not batch:
            break
        for msg in batch:
            if msg["id"] not in known_ids:
                known_ids.add(msg["id"])
                messages.append(msg)
                added += 1
        after_id = batch[-1]["id"]
        print(f"  +{added} new so far, up to "
              f"{time.strftime('%Y-%m-%d %H:%M', time.localtime(batch[-1]['created_at']))}")

    if added:
        messages.sort(key=lambda m: m["created_at"], reverse=True)
        tmp_path = out_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(messages, f, ensure_ascii=False, indent=1)
        os.replace(tmp_path, out_path)
        print(f"Added {added} new messages -> {out_path} ({len(messages)} total)")
    else:
        print("No new messages - archive is up to date.")


if __name__ == "__main__":
    main()
