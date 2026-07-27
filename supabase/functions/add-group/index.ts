// GroupMe Archive
// Copyright (c) 2026 Shalom Karr
// Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
// use without permission, and derivatives must remain open under the same terms.
// See the LICENSE file for full terms.

// Chunked full-history backfill for a group + derived-table rebuild when done.
// POST {group_id} repeatedly until {done:true}. Guarded by ?key=SYNC_KEY.
// Safe to run on an already-seeded group: it verifies history start and rebuilds derived data.

import { createClient } from "npm:@supabase/supabase-js@2";

const GM = "https://api.groupme.com/v3";
const PAGES_PER_CALL = 30;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (obj: unknown, status = 200) => Response.json(obj, { status, headers: CORS });

async function isAuthorized(req: Request, url: URL): Promise<boolean> {
  if (url.searchParams.get("key") === Deno.env.get("SYNC_KEY")) return true;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user?.email) return false;
  const email = data.user.email.toLowerCase();
  const allowed = (Deno.env.get("ADMIN_EMAILS") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.includes(email)) return true;
  const { data: row } = await admin.from("admins").select("email").ilike("email", email).maybeSingle();
  return !!row;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("whoami")) {
    const t = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const a = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await a.auth.getUser(t);
    const email = data?.user?.email?.toLowerCase();
    if (!email) return json({ authed: false, admin: false });
    const { data: row } = await a.from("admins").select("email").ilike("email", email).maybeSingle();
    return json({ authed: true, email, admin: !!row });
  }
  if (req.method === "GET" && url.searchParams.get("page")) {
    // Everything the admin page needs on load, in one invocation: identity,
    // admin groups and the AI log. One getUser instead of three.
    const t = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const a = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await a.auth.getUser(t);
    const email = data?.user?.email?.toLowerCase();
    if (!email) return json({ who: { authed: false, admin: false } });
    const allowed = (Deno.env.get("ADMIN_EMAILS") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    let admin = allowed.includes(email);
    if (!admin) {
      const { data: row } = await a.from("admins").select("email").ilike("email", email).maybeSingle();
      admin = !!row;
    }
    if (!admin) return json({ who: { authed: true, email, admin: false } });
    const [{ data: bots }, { data: gs }, { data: logs }] = await Promise.all([
      a.from("bots").select("group_id, admin").eq("admin", true),
      a.from("group_stats").select("group_id, group_name"),
      a.from("ai_log").select("*").order("created_at", { ascending: false }).limit(200),
    ]);
    const names: Record<string, string> = {};
    for (const g of gs ?? []) names[g.group_id] = g.group_name;
    return json({
      who: { authed: true, email, admin: true },
      admins: (bots ?? []).map((b: any) => ({ group_id: b.group_id, name: names[b.group_id] ?? b.group_id })),
      logs: (logs ?? []).map((l: any) => ({ ...l, group_name: names[l.group_id] ?? l.group_id })),
    });
  }

  if (!(await isAuthorized(req, url))) {
    return new Response("forbidden", { status: 403, headers: CORS });
  }
  const token = Deno.env.get("GROUPME_TOKEN")!;
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (req.method === "GET" && url.searchParams.get("admins")) {
    const [{ data: bots }, { data: gs }] = await Promise.all([
      supabase.from("bots").select("group_id, admin").eq("admin", true),
      supabase.from("group_stats").select("group_id, group_name"),
    ]);
    const names: Record<string, string> = {};
    for (const g of gs ?? []) names[g.group_id] = g.group_name;
    return json({ admins: (bots ?? []).map((b: any) => ({ group_id: b.group_id, name: names[b.group_id] ?? b.group_id })) });
  }

  if (req.method === "GET" && url.searchParams.get("logs")) {
    const grp = url.searchParams.get("group");
    let q = supabase.from("ai_log").select("*").order("created_at", { ascending: false }).limit(200);
    if (grp) q = q.eq("group_id", grp);
    const [{ data: logs }, { data: gs }] = await Promise.all([
      q, supabase.from("group_stats").select("group_id, group_name"),
    ]);
    const names: Record<string, string> = {};
    for (const g of gs ?? []) names[g.group_id] = g.group_name;
    return json({ logs: (logs ?? []).map((l: any) => ({ ...l, group_name: names[l.group_id] ?? l.group_id })) });
  }

  if (req.method === "GET" && url.searchParams.get("health")) {
    const primaryModel = "gemini-3.1-flash-lite";
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [{ data: events }, { data: allGroups }, { data: allBots }, { data: fallbackLogs }, { data: latestLog }] = await Promise.all([
      supabase.from("health_events").select("*").order("ts", { ascending: false }).limit(100),
      supabase.from("group_stats").select("group_id, group_name"),
      supabase.from("bots").select("group_id"),
      supabase.from("ai_log").select("model, created_at")
        .gt("created_at", sevenDaysAgo)
        .not("model", "is", null)
        .neq("model", primaryModel)
        .order("created_at", { ascending: false })
        .limit(500),
      supabase.from("ai_log").select("model").order("created_at", { ascending: false }).limit(1),
    ]);
    const botGroupIds = new Set((allBots ?? []).map((b: any) => b.group_id));
    const no_bot_groups = (allGroups ?? [])
      .filter((g: any) => !botGroupIds.has(g.group_id))
      .map((g: any) => ({ group_id: g.group_id, group_name: g.group_name }));
    const fallbackMap: Record<string, { model: string; count: number; last_ts: string }> = {};
    for (const r of fallbackLogs ?? []) {
      if (!fallbackMap[r.model]) fallbackMap[r.model] = { model: r.model, count: 0, last_ts: r.created_at };
      fallbackMap[r.model].count++;
      if (r.created_at > fallbackMap[r.model].last_ts) fallbackMap[r.model].last_ts = r.created_at;
    }
    const model_fallbacks = Object.values(fallbackMap);
    const current_model = latestLog?.[0]?.model ?? null;
    return json({ events: events ?? [], no_bot_groups, model_fallbacks, current_model });
  }

  if (req.method === "GET" && url.searchParams.get("list")) {
    // Fetch GroupMe group pages in parallel (was sequential -> slow).
    const pages = await Promise.all([1, 2, 3, 4, 5].map(async (page) => {
      const r = await fetch(`${GM}/groups?token=${token}&per_page=100&page=${page}&omit=memberships`);
      return r.ok ? ((await r.json())?.response ?? []) : [];
    }));
    const mine: any[] = pages.flat();
    const [{ data: existing }, { data: blockedRows }] = await Promise.all([
      supabase.from("group_stats").select("group_id"),
      supabase.from("group_blocklist").select("group_id, name"),
    ]);
    const have = new Set((existing ?? []).map((g: any) => g.group_id));
    const blockedSet = new Set((blockedRows ?? []).map((g: any) => g.group_id));
    const groups = mine
      .filter((g: any) => !have.has(String(g.group_id)) && !blockedSet.has(String(g.group_id)))
      .map((g: any) => ({
        group_id: String(g.group_id),
        name: g.name,
        image_url: g.image_url ?? null,
        messages: g.messages?.count ?? 0,
      }))
      .sort((a: any, b: any) => b.messages - a.messages);
    return json({ groups, blocked: blockedRows ?? [], archived: have.size });
  }

  const body = await req.json().catch(() => ({}));

  if (body.action === "block" || body.action === "unblock") {
    const bgid = String(body.group_id ?? "").trim();
    if (!bgid) return json({ error: "group_id required" }, 400);
    if (body.action === "block") {
      await supabase.from("group_blocklist").upsert(
        { group_id: bgid, name: body.name ?? null }, { onConflict: "group_id" });
    } else {
      await supabase.from("group_blocklist").delete().eq("group_id", bgid);
    }
    return json({ ok: true, action: body.action, group_id: bgid });
  }

  if (body.action === "set_local") {
    const lgid = String(body.group_id ?? "").trim();
    if (!lgid) return json({ error: "group_id required" }, 400);
    await supabase.from("group_stats").update({ local_only: !!body.local_only }).eq("group_id", lgid);
    return json({ ok: true, group_id: lgid, local_only: !!body.local_only });
  }

  if (body.action === "set_admin") {
    const agid = String(body.group_id ?? "").trim();
    if (!agid) return json({ error: "group_id required" }, 400);
    // Ensure the group has a bot (an admin control group must be able to reply).
    const bot = await ensureBot(supabase, agid, token);
    await supabase.from("bots").update({ admin: !!body.admin }).eq("group_id", agid);
    return json({ ok: true, group_id: agid, admin: !!body.admin, bot });
  }

  const gid = String(body.group_id ?? "").trim();
  if (!gid) return json({ error: "group_id required" }, 400);
  const { data: blocked } = await supabase.from("group_blocklist").select("group_id").eq("group_id", gid).limit(1);
  if (blocked?.length) return json({ error: "this group is on the do-not-archive list - unblock it first" }, 400);

  const infoRes = await fetch(`${GM}/groups/${gid}?token=${token}`);
  if (!infoRes.ok) {
    return json({ error: `GroupMe says ${infoRes.status} - is the id right and are you a member?` }, 400);
  }
  const info = (await infoRes.json())?.response;
  const gname = info?.name ?? gid;
  const gavatar = info?.image_url ?? "";

  const { data: oldest } = await supabase.from("messages").select("id,created_at")
    .eq("group_id", gid).order("created_at", { ascending: true }).limit(1);
  let beforeId: string | null = oldest?.[0]?.id ?? null;
  let oldestTs: number | undefined = oldest?.[0]?.created_at;

  let inserted = 0;
  let reachedStart = false;
  for (let page = 0; page < PAGES_PER_CALL; page++) {
    const qs = beforeId ? `&before_id=${beforeId}` : "";
    const res = await fetch(`${GM}/groups/${gid}/messages?token=${token}&limit=100${qs}`);
    if (res.status === 304) { reachedStart = true; break; }
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); page--; continue; }
    if (!res.ok) return json({ error: `GroupMe HTTP ${res.status}` }, 500);
    const batch = (await res.json())?.response?.messages ?? [];
    if (!batch.length) { reachedStart = true; break; }
    const rows = batch.map((m: any) => ({
      group_id: gid, id: m.id, group_name: gname, group_avatar: gavatar,
      created_at: m.created_at, user_id: m.user_id ? String(m.user_id) : null,
      name: m.name ?? null, text: m.text ?? null, sender_type: m.sender_type ?? null,
      system: !!m.system, likes: (m.favorited_by ?? []).length, raw: m,
    }));
    const { error } = await supabase.from("messages").upsert(rows, { onConflict: "group_id,id", ignoreDuplicates: true });
    if (error) return json({ error: error.message }, 500);
    inserted += batch.length;
    beforeId = batch[batch.length - 1].id;
    oldestTs = batch[batch.length - 1].created_at;
  }

  if (!reachedStart) {
    return json({
      done: false, inserted,
      back_to: oldestTs ? new Date(oldestTs * 1000).toISOString().slice(0, 10) : null,
      group_name: gname,
    });
  }

  await rebuildDerived(supabase, gid);
  await syncRoles(supabase, gid, info?.members ?? []);
  await supabase.rpc("refresh_member_scores", { gid });
  const bot = await ensureBot(supabase, gid, token);
  const { count } = await supabase.from("messages").select("*", { count: "exact", head: true }).eq("group_id", gid);
  const { data: firstM } = await supabase.from("messages").select("created_at").eq("group_id", gid).order("created_at", { ascending: true }).limit(1);
  const { data: lastM } = await supabase.from("messages").select("created_at").eq("group_id", gid).order("created_at", { ascending: false }).limit(1);
  await supabase.from("group_stats").upsert({
    group_id: gid, group_name: gname, group_avatar: gavatar,
    message_count: count ?? 0,
    first_ts: firstM?.[0]?.created_at ?? null,
    last_ts: lastM?.[0]?.created_at ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "group_id" });
  return json({ done: true, inserted, total: count, group_name: gname, bot });
});

async function syncRoles(supabase: any, gid: string, liveMembers: any[]) {
  if (!liveMembers.length) return;
  await supabase.from("members").update({ role: null }).eq("group_id", gid);
  const rows = liveMembers.map((m: any) => ({
    group_id: gid,
    user_id: String(m.user_id),
    role: (m.roles ?? []).includes("owner") ? "owner" : (m.roles ?? []).includes("admin") ? "admin" : "member",
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await supabase.from("members").upsert(rows.slice(i, i + 500), { onConflict: "group_id,user_id" });
  }
}

async function ensureBot(supabase: any, gid: string, token: string) {
  const { data: existing } = await supabase.from("bots").select("bot_id").eq("group_id", gid).limit(1);
  if (existing?.length) return { status: "already registered", bot_id: existing[0].bot_id };
  const callback = `${Deno.env.get("SUPABASE_URL")}/functions/v1/groupme-bot?key=${Deno.env.get("SYNC_KEY")}`;
  const listRes = await fetch(`${GM}/bots?token=${token}`);
  const bots = (await listRes.json())?.response ?? [];
  let bot = bots.find((b: any) => b.group_id === gid && (b.callback_url ?? "").includes("groupme-bot"));
  let status = "found existing";
  if (!bot) {
    const createRes = await fetch(`${GM}/bots?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot: { name: "SKChats", group_id: gid, callback_url: callback } }),
    });
    if (!createRes.ok) return { status: `bot create failed: HTTP ${createRes.status}` };
    bot = (await createRes.json())?.response?.bot;
    status = "created";
  }
  if (!bot?.bot_id) return { status: "bot create failed: no id returned" };
  await supabase.from("bots").upsert(
    { group_id: gid, bot_id: bot.bot_id, bot_name: bot.name ?? "SKChats" },
    { onConflict: "group_id" },
  );
  return { status, bot_id: bot.bot_id };
}

async function rebuildDerived(supabase: any, gid: string) {
  const msgs: any[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase.from("messages")
      .select("created_at,user_id,name,sender_type,system,likes,ev:raw->event")
      .eq("group_id", gid)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    msgs.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  let counter = 0;
  const memberNo: Record<string, number> = {};
  const assign = (uid: unknown) => {
    const u = String(uid ?? "");
    if (u && u !== "null" && u !== "undefined" && !(u in memberNo)) memberNo[u] = ++counter;
  };
  const members: Record<string, any> = {};
  const events: any[] = [];

  for (const m of msgs) {
    const ts = m.created_at;
    const ev = m.ev ?? {};
    const dd = ev.data ?? {};
    if (dd.adder_user) assign(dd.adder_user.id);
    for (const u of dd.added_users ?? []) {
      assign(u.id);
      events.push({ group_id: gid, ts, type: "added", subject_uid: String(u.id), subject_name: u.nickname,
        actor_uid: dd.adder_user ? String(dd.adder_user.id) : null, actor_name: dd.adder_user?.nickname ?? null, detail: null });
    }
    if (dd.user && (ev.type ?? "").includes("rejoin")) {
      assign(dd.user.id);
      events.push({ group_id: gid, ts, type: "rejoined", subject_uid: String(dd.user.id), subject_name: dd.user.nickname,
        actor_uid: null, actor_name: null, detail: null });
    }
    if (dd.removed_user) {
      assign(dd.remover_user?.id); assign(dd.removed_user.id);
      events.push({ group_id: gid, ts, type: dd.remover_user ? "removed" : "left",
        subject_uid: String(dd.removed_user.id), subject_name: dd.removed_user.nickname,
        actor_uid: dd.remover_user ? String(dd.remover_user.id) : null, actor_name: dd.remover_user?.nickname ?? null, detail: null });
    }
    const uid = String(m.user_id ?? "");
    if (!uid || uid === "null" || m.system || m.sender_type === "system") continue;
    const isBot = m.sender_type === "bot";
    if (!isBot) assign(uid);
    const mb = members[uid] ?? (members[uid] = {
      group_id: gid, user_id: uid, member_no: null, current_name: null, is_bot: isBot,
      msg_count: 0, likes_received: 0, first_ts: ts, last_ts: ts, names: [],
    });
    mb.member_no = isBot ? null : memberNo[uid];
    mb.is_bot = mb.is_bot || isBot;
    mb.msg_count++;
    mb.likes_received += m.likes ?? 0;
    mb.last_ts = ts;
    if (m.name && m.name !== mb.current_name) {
      if (mb.current_name) {
        events.push({ group_id: gid, ts, type: "renamed", subject_uid: uid, subject_name: m.name,
          actor_uid: null, actor_name: null, detail: `${mb.current_name} -> ${m.name}` });
      }
      mb.current_name = m.name;
      if (!mb.names.some((x: any) => x.name === m.name)) mb.names.push({ name: m.name, first_used: ts });
    }
  }

  const mrows = Object.values(members);
  for (let i = 0; i < mrows.length; i += 500) {
    const { error } = await supabase.from("members").upsert(mrows.slice(i, i + 500), { onConflict: "group_id,user_id" });
    if (error) throw new Error(error.message);
  }
  await supabase.from("events").delete().eq("group_id", gid);
  for (let i = 0; i < events.length; i += 500) {
    const { error } = await supabase.from("events").insert(events.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
}
