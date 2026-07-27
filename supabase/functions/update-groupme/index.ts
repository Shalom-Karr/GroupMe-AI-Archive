// GroupMe Archive
// Copyright (c) 2026 Shalom Karr
// Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
// use without permission, and derivatives must remain open under the same terms.
// See the LICENSE file for full terms.

// Incremental GroupMe sync for every group present in the messages table.
// Invoke: GET/POST ?key=<SYNC_KEY>  (deployed with --no-verify-jwt, guarded by SYNC_KEY secret)

import { createClient } from "npm:@supabase/supabase-js@2";

const GM = "https://api.groupme.com/v3";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
  if (!(await isAuthorized(req, url))) {
    return new Response("forbidden", { status: 403, headers: CORS });
  }
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const token = Deno.env.get("GROUPME_TOKEN")!;

  const only = url.searchParams.get("group");
  let groups: any[] | null;
  let gerr: any;
  if (only) {
    groups = [{ group_id: only }];
  } else {
    ({ data: groups, error: gerr } = await supabase.from("groups_view").select("group_id"));
  }
  if (gerr) return Response.json({ error: gerr.message }, { status: 500, headers: CORS });

  const report: Record<string, unknown> = {};
  // Sync all groups in parallel (each hits GroupMe + the DB independently).
  await Promise.all((groups ?? []).map(async (g: any) => {
    try {
      report[g.group_id] = await syncGroup(supabase, token, g.group_id);
    } catch (e) {
      report[g.group_id] = `error: ${e}`;
    }
  }));
  return Response.json(report, { headers: CORS });
});

async function syncGroup(supabase: any, token: string, gid: string) {
  const info = await (await fetch(`${GM}/groups/${gid}?token=${token}`)).json();
  const gname = info?.response?.name ?? gid;
  const gavatar = info?.response?.image_url ?? "";
  await syncRoles(supabase, gid, info?.response?.members ?? []);

  const { data: newest } = await supabase.from("messages")
    .select("id").eq("group_id", gid)
    .order("created_at", { ascending: false }).limit(1);
  let afterId = newest?.[0]?.id;
  if (!afterId) return "not seeded";

  let added = 0;
  while (true) {
    const res = await fetch(`${GM}/groups/${gid}/messages?token=${token}&limit=100&after_id=${afterId}`);
    if (res.status === 304) break;
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (!res.ok) throw new Error(`GroupMe HTTP ${res.status}`);
    const batch = (await res.json())?.response?.messages ?? [];
    if (!batch.length) break;

    const rows = batch.map((m: any) => ({
      group_id: gid,
      id: m.id,
      group_name: gname,
      group_avatar: gavatar,
      created_at: m.created_at,
      user_id: m.user_id ? String(m.user_id) : null,
      name: m.name ?? null,
      text: m.text ?? null,
      sender_type: m.sender_type ?? null,
      system: !!m.system,
      likes: (m.favorited_by ?? []).length,
      raw: m,
    }));
    const { error } = await supabase.from("messages")
      .upsert(rows, { onConflict: "group_id,id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);

    await maintainDerived(supabase, gid, batch);
    added += batch.length;
    afterId = batch[batch.length - 1].id;
  }
  // Re-fetch the newest 100 messages to capture likes that accrued after ingestion
  // (bot-callback ingestion stores 0 likes; likes arrive later).
  try {
    const res = await fetch(`${GM}/groups/${gid}/messages?token=${token}&limit=100`);
    if (res.ok) {
      const recent = (await res.json())?.response?.messages ?? [];
      if (recent.length) {
        const rows = recent.map((m: any) => ({
          group_id: gid, id: m.id, group_name: gname, group_avatar: gavatar,
          created_at: m.created_at, user_id: m.user_id ? String(m.user_id) : null,
          name: m.name ?? null, text: m.text ?? null, sender_type: m.sender_type ?? null,
          system: !!m.system, likes: (m.favorited_by ?? []).length, raw: m,
        }));
        await supabase.from("messages").upsert(rows, { onConflict: "group_id,id" });
      }
    }
  } catch (_) { /* likes refresh is best-effort */ }

  await refreshStats(supabase, gid, gname, gavatar);
  await supabase.rpc("refresh_member_scores", { gid }); // always, so scores stay current
  return added;
}

async function refreshStats(supabase: any, gid: string, gname: string, gavatar: string) {
  const { count } = await supabase.from("messages").select("*", { count: "exact", head: true }).eq("group_id", gid);
  const { data: first } = await supabase.from("messages").select("created_at").eq("group_id", gid).order("created_at", { ascending: true }).limit(1);
  const { data: last } = await supabase.from("messages").select("created_at").eq("group_id", gid).order("created_at", { ascending: false }).limit(1);
  await supabase.from("group_stats").upsert({
    group_id: gid, group_name: gname, group_avatar: gavatar,
    message_count: count ?? 0,
    first_ts: first?.[0]?.created_at ?? null,
    last_ts: last?.[0]?.created_at ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "group_id" });
}

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

async function maintainDerived(supabase: any, gid: string, batch: any[]) {
  const { data: existing } = await supabase.from("members")
    .select("user_id, member_no, current_name, msg_count, likes_received, first_ts, last_ts, is_bot, names")
    .eq("group_id", gid);
  const members = new Map((existing ?? []).map((m: any) => [m.user_id, m]));
  let maxNo = Math.max(0, ...(existing ?? []).map((m: any) => m.member_no ?? 0));
  const events: any[] = [];
  const dirty = new Set<string>();

  const assign = (uid: unknown) => {
    const u = String(uid ?? "");
    if (!u || u === "null" || u === "undefined") return;
    if (!members.has(u)) {
      members.set(u, {
        user_id: u, member_no: ++maxNo, current_name: null, is_bot: false,
        msg_count: 0, likes_received: 0, first_ts: null, last_ts: null, names: [],
      });
      dirty.add(u);
    }
  };

  for (const m of batch) {
    const ts = m.created_at;
    const ev = m.event ?? {};
    const dd = ev.data ?? {};
    if (dd.adder_user) assign(dd.adder_user.id);
    for (const u of dd.added_users ?? []) {
      assign(u.id);
      events.push({ group_id: gid, ts, type: "added", subject_uid: String(u.id), subject_name: u.nickname,
        actor_uid: dd.adder_user ? String(dd.adder_user.id) : null,
        actor_name: dd.adder_user?.nickname ?? null, detail: null });
    }
    if (dd.user && (ev.type ?? "").includes("rejoin")) {
      assign(dd.user.id);
      events.push({ group_id: gid, ts, type: "rejoined", subject_uid: String(dd.user.id),
        subject_name: dd.user.nickname, actor_uid: null, actor_name: null, detail: null });
    }
    if (dd.removed_user) {
      assign(dd.remover_user?.id); assign(dd.removed_user.id);
      events.push({ group_id: gid, ts, type: dd.remover_user ? "removed" : "left",
        subject_uid: String(dd.removed_user.id), subject_name: dd.removed_user.nickname,
        actor_uid: dd.remover_user ? String(dd.remover_user.id) : null,
        actor_name: dd.remover_user?.nickname ?? null, detail: null });
    }

    const uid = String(m.user_id ?? "");
    if (!uid || m.system || m.sender_type === "system") continue;
    const isBot = m.sender_type === "bot";
    if (!members.has(uid)) {
      members.set(uid, {
        user_id: uid, member_no: isBot ? null : ++maxNo, current_name: null, is_bot: isBot,
        msg_count: 0, likes_received: 0, first_ts: ts, last_ts: ts, names: [],
      });
    }
    const mb = members.get(uid)!;
    mb.msg_count += 1;
    mb.likes_received += (m.favorited_by ?? []).length;
    mb.first_ts = mb.first_ts ?? ts;
    mb.last_ts = ts;
    mb.is_bot = mb.is_bot || isBot;
    if (m.name && m.name !== mb.current_name) {
      if (mb.current_name) {
        events.push({ group_id: gid, ts, type: "renamed", subject_uid: uid, subject_name: m.name,
          actor_uid: null, actor_name: null, detail: `${mb.current_name} -> ${m.name}` });
      }
      mb.current_name = m.name;
      if (!(mb.names ?? []).some((x: any) => x.name === m.name)) {
        mb.names = [...(mb.names ?? []), { name: m.name, first_used: ts }];
      }
    }
    dirty.add(uid);
  }

  if (dirty.size) {
    const rows = [...dirty].map((u) => ({ group_id: gid, ...members.get(u)! }));
    const { error } = await supabase.from("members").upsert(rows, { onConflict: "group_id,user_id" });
    if (error) throw new Error(error.message);
  }
  if (events.length) {
    const { error } = await supabase.from("events").insert(events);
    if (error) throw new Error(error.message);
  }
}
