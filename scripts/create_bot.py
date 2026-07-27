# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Create the SKChats GroupMe bot for a group and register bot ids in the BOT_IDS secret.

Usage: python create_bot.py [--group GROUP_ID] [--name SKChats]
The bot's callback URL is the groupme-bot Edge Function; run once per group.
"""

import argparse
import json
import os
import subprocess
import sys

import requests

from supa_sql import env

GM = "https://api.groupme.com/v3"
HERE = os.path.dirname(os.path.abspath(__file__))


def gm_token():
    for line in open(os.path.join(HERE, ".env"), encoding="utf-8"):
        if line.startswith("GROUPME_TOKEN="):
            return line.split("=", 1)[1].strip()
    sys.exit("GROUPME_TOKEN not in .env")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default="104645947")
    ap.add_argument("--name", default="SKChats")
    args = ap.parse_args()
    tok = gm_token()
    callback = f"{env('SUPABASE_URL')}/functions/v1/groupme-bot?key={env('SYNC_KEY')}"

    bots = requests.get(f"{GM}/bots", params={"token": tok}, timeout=30).json()["response"]
    mine = next((b for b in bots if b["group_id"] == args.group and "groupme-bot" in (b.get("callback_url") or "")), None)
    if mine:
        print(f"Bot already exists for group {args.group}: {mine['bot_id']}")
    else:
        r = requests.post(f"{GM}/bots", params={"token": tok},
                          json={"bot": {"name": args.name, "group_id": args.group, "callback_url": callback}},
                          timeout=30)
        r.raise_for_status()
        mine = r.json()["response"]["bot"]
        print(f"Created bot \"{args.name}\" in group {args.group}: {mine['bot_id']}")

    bots = requests.get(f"{GM}/bots", params={"token": tok}, timeout=30).json()["response"]
    mapping = {b["group_id"]: b["bot_id"] for b in bots if "groupme-bot" in (b.get("callback_url") or "")}
    print(f"BOT_IDS mapping: {mapping}")

    cli_env = {**os.environ, "SUPABASE_ACCESS_TOKEN": env("SUPABASE_TOKEN")}
    subprocess.run(
        ["npx", "supabase", "secrets", "set", f"BOT_IDS={json.dumps(mapping)}",
         "--project-ref", env("SUPABASE_PROJECT_REF")],
        cwd=HERE, env=cli_env, shell=True, check=True)
    print("BOT_IDS secret updated.")


if __name__ == "__main__":
    main()
