# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Run the same archive question through candidate Gemini/Gemma models with real tools.

Usage: python test_models.py "question" [model1 model2 ...]
Tools hit the live Supabase data (PostgREST + Management API) exactly like the chat function.
"""

import json
import sys
import time
import urllib.parse

import requests

from supa_sql import run_sql, env

GID = "104645947"
SUPA = env("SUPABASE_URL")
ANON = env("SUPABASE_ANON_KEY")
KEY = env("GEMINI_API_KEY")

DEFAULT_MODELS = ["gemma-4-31b-it", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.6-flash"]

TOOLS = [{"functionDeclarations": [
    {"name": "search_messages", "description": "Full-text search messages in this group. Returns matching messages with dates.",
     "parameters": {"type": "object", "properties": {
         "query": {"type": "string"}, "member": {"type": "string"},
         "after": {"type": "string"}, "before": {"type": "string"}, "limit": {"type": "number"}},
         "required": ["query"]}},
    {"name": "get_context", "description": "Read the conversation around a moment: N messages before/after a timestamp or message id.",
     "parameters": {"type": "object", "properties": {
         "message_id": {"type": "string"}, "date_time": {"type": "string"}, "n": {"type": "number"}}}},
    {"name": "run_sql", "description": "Run a read-only SELECT for aggregates/stats. Tables: messages(group_id,id,created_at unixtime,user_id,name,text,sender_type,system,likes), members(group_id,user_id,member_no,current_name,is_bot,msg_count,likes_received,first_ts,last_ts,names jsonb), events(group_id,ts,type added|removed|left|rejoined|renamed,subject_uid,subject_name,actor_uid,actor_name,detail). ALWAYS filter by group_id.",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "member_lookup", "description": "Resolve a person by any nickname or user_id: profile, member number, all nicknames, join/leave/rename timeline.",
     "parameters": {"type": "object", "properties": {"who": {"type": "string"}}, "required": ["who"]}},
]}]


def rest(path):
    r = requests.get(f"{SUPA}/rest/v1/{path}", headers={"apikey": ANON, "Authorization": f"Bearer {ANON}"}, timeout=30)
    r.raise_for_status()
    return r.json()


def iso(ts):
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts)) if ts else None


def resolve_uid(who):
    who = str(who).strip()
    members = rest(f"members?group_id=eq.{GID}&select=user_id,current_name,names,msg_count&order=msg_count.desc")
    lw = who.lower()
    for m in members:
        if m["user_id"] == who:
            return m["user_id"]
    for m in members:
        if (m.get("current_name") or "").lower() == lw or any((n.get("name") or "").lower() == lw for n in m.get("names") or []):
            return m["user_id"]
    for m in members:
        if lw in (m.get("current_name") or "").lower() or any(lw in (n.get("name") or "").lower() for n in m.get("names") or []):
            return m["user_id"]
    return None


def run_tool(name, args):
    if name == "search_messages":
        q = urllib.parse.quote(args["query"])
        url = f"messages?group_id=eq.{GID}&select=id,created_at,name,text,likes&fts=wfts(english).{q}&order=created_at.desc&limit={min(int(args.get('limit', 20)), 50)}"
        if args.get("member"):
            uid = resolve_uid(args["member"])
            if uid:
                url += f"&user_id=eq.{uid}"
        rows = rest(url)
        return [{**r, "date": iso(r["created_at"])} for r in rows]
    if name == "get_context":
        center = None
        if args.get("message_id"):
            rows = rest(f"messages?group_id=eq.{GID}&id=eq.{args['message_id']}&select=created_at")
            center = rows[0]["created_at"] if rows else None
        if center is None and args.get("date_time"):
            center = time.mktime(time.strptime(args["date_time"][:16].replace("T", " "), "%Y-%m-%d %H:%M"))
        if center is None:
            return {"error": "need message_id or date_time"}
        n = min(int(args.get("n", 15)), 40)
        before = rest(f"messages?group_id=eq.{GID}&created_at=lte.{int(center)}&select=created_at,name,text&order=created_at.desc&limit={n}")
        after = rest(f"messages?group_id=eq.{GID}&created_at=gt.{int(center)}&select=created_at,name,text&order=created_at.asc&limit={n}")
        return [f"[{iso(m['created_at'])}] {m['name']}: {m.get('text') or '(media)'}" for m in list(reversed(before)) + after]
    if name == "run_sql":
        q = args["query"]
        if not q.strip().lower().startswith(("select", "with")):
            return {"error": "only SELECT allowed"}
        return run_sql(q)[:100]
    if name == "member_lookup":
        uid = resolve_uid(args["who"])
        if not uid:
            return {"error": f"no member matching {args['who']}"}
        mb = rest(f"members?group_id=eq.{GID}&user_id=eq.{uid}&select=*")[0]
        evs = rest(f"events?group_id=eq.{GID}&subject_uid=eq.{uid}&select=ts,type,actor_name,detail&order=ts.asc&limit=200")
        mb["first_ts"], mb["last_ts"] = iso(mb.get("first_ts")), iso(mb.get("last_ts"))
        mb["timeline"] = [{"date": iso(e["ts"]), "type": e["type"], "by": e.get("actor_name"), "detail": e.get("detail")} for e in evs]
        return mb


def brief():
    g = rest(f"groups_view?group_id=eq.{GID}")[0]
    top = rest(f"members?group_id=eq.{GID}&is_bot=eq.false&select=member_no,current_name,user_id,msg_count,names&order=msg_count.desc&limit=15")
    lines = [f"#{m['member_no']} {m['current_name']} (uid {m['user_id']}, {m['msg_count']} msgs"
             + (f", aka {' / '.join(n['name'] for n in m['names'])})" if len(m.get('names') or []) > 1 else ")") for m in top]
    return (f'You are the archivist for the GroupMe group "{g["group_name"]}" (id {GID}).\n'
            f'Archive: {g["message_count"]} messages from {iso(g["first_ts"])[:10]} to {iso(g["last_ts"])[:10]}.\n'
            "Timestamps in the database are unix seconds; format dates for people.\n"
            "Nicknames change constantly - ALWAYS resolve people to user_id via member_lookup before other queries about them, "
            f"and always filter SQL by group_id = '{GID}'.\n"
            "Use the tools before answering; never guess. Cite dates like [Dec 20, 2024] for claims. Be concise and direct.\n"
            "Top members:\n" + "\n".join(lines))


def ask(model, question, system):
    contents = [{"role": "user", "parts": [{"text": question}]}]
    tools_used = []
    t0 = time.time()
    for hop in range(8):
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={KEY}",
            json={"system_instruction": {"parts": [{"text": system}]}, "contents": contents, "tools": TOOLS},
            timeout=120)
        if r.status_code == 429:
            return {"model": model, "error": "429 rate limited", "tools": tools_used}
        if r.status_code >= 400:
            return {"model": model, "error": f"HTTP {r.status_code}: {r.text[:200]}", "tools": tools_used}
        parts = r.json().get("candidates", [{}])[0].get("content", {}).get("parts", [])
        calls = [p["functionCall"] for p in parts if "functionCall" in p]
        if not calls:
            answer = "".join(p.get("text", "") for p in parts)
            return {"model": model, "answer": answer.strip(), "tools": tools_used, "hops": hop, "secs": round(time.time() - t0, 1)}
        contents.append({"role": "model", "parts": parts})
        responses = []
        for c in calls:
            tools_used.append(f"{c['name']}({json.dumps(c.get('args', {}))[:80]})")
            try:
                result = run_tool(c["name"], c.get("args") or {})
            except Exception as e:
                result = {"error": str(e)[:200]}
            responses.append({"functionResponse": {"name": c["name"], "response": {"result": result}}})
        contents.append({"role": "user", "parts": responses})
    return {"model": model, "error": "hop limit", "tools": tools_used}


if __name__ == "__main__":
    question = sys.argv[1] if len(sys.argv) > 1 else "Who has been removed from the group the most times, and who removed them?"
    models = sys.argv[2:] or DEFAULT_MODELS
    system = brief()
    print(f"QUESTION: {question}\n" + "=" * 70)
    for model in models:
        res = ask(model, question, system)
        print(f"\n### {model}  ({res.get('secs', '?')}s, {len(res.get('tools', []))} tool calls)")
        for t in res.get("tools", []):
            print(f"    {t}")
        print(res.get("answer") or f"ERROR: {res.get('error')}")
        print("-" * 70)
        time.sleep(3)
