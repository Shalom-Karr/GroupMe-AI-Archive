# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Download full GroupMe group message history to JSON via the API.

Usage: python download_groupme.py [--token TOKEN] [--group GROUP_ID] [--years YEARS]
Token resolution order: --token arg, GROUPME_TOKEN env var, .env file, token.txt.
Paginates backwards with before_id until messages are older than the cutoff or
history is exhausted. Writes groupme_<group_id>_messages.json (newest first).
Resumable: progress is checkpointed every 25 pages to a .partial.json file.
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

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
    sys.exit("No token found. Pass --token, set GROUPME_TOKEN, or put it in token.txt")


def fetch_page(token, group_id, before_id=None, limit=100):
    params = {"token": token, "limit": limit}
    if before_id:
        params["before_id"] = before_id
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
    ap.add_argument("--years", type=float, default=2.0)
    args = ap.parse_args()

    token = get_token(args.token)
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.years * 365.25)
    cutoff_ts = int(cutoff.timestamp())
    out_path = f"groupme_{args.group}_messages.json"
    partial_path = out_path.replace(".json", ".partial.json")

    messages = []
    before_id = None
    if os.path.exists(partial_path):
        with open(partial_path, encoding="utf-8") as f:
            messages = json.load(f)
        if messages:
            before_id = messages[-1]["id"]
            print(f"Resuming from checkpoint: {len(messages)} messages, before_id={before_id}")

    page = 0
    done = False
    start = time.time()
    while not done:
        batch = fetch_page(token, args.group, before_id)
        if not batch:
            print("Reached the beginning of group history.")
            break
        for msg in batch:
            if msg.get("created_at", 0) < cutoff_ts:
                done = True
                break
            messages.append(msg)
        before_id = batch[-1]["id"]
        page += 1
        if page % 10 == 0:
            oldest = datetime.fromtimestamp(batch[-1]["created_at"], tz=timezone.utc)
            rate = len(messages) / max(time.time() - start, 1)
            print(f"  {len(messages)} messages, back to {oldest:%Y-%m-%d}, {rate:.0f} msg/s", flush=True)
        if page % 25 == 0:
            with open(partial_path, "w", encoding="utf-8") as f:
                json.dump(messages, f, ensure_ascii=False)

    if done:
        print(f"Hit {args.years}-year cutoff ({cutoff:%Y-%m-%d}).")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(messages, f, ensure_ascii=False, indent=1)
    if os.path.exists(partial_path):
        os.remove(partial_path)

    if messages:
        newest = datetime.fromtimestamp(messages[0]["created_at"], tz=timezone.utc)
        oldest = datetime.fromtimestamp(messages[-1]["created_at"], tz=timezone.utc)
        print(f"Done: {len(messages)} messages ({oldest:%Y-%m-%d} to {newest:%Y-%m-%d}) -> {out_path}")
    else:
        print("No messages retrieved.")


if __name__ == "__main__":
    main()
