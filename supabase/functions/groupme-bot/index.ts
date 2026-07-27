// GroupMe Archive
// Copyright (c) 2026 Shalom Karr
// Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
// use without permission, and derivatives must remain open under the same terms.
// See the LICENSE file for full terms.

// GroupMe bot callback: "@SKChats <question>" -> AI archivist, "Leaderboard [today|week|month|year]" -> top 5.
// Deployed with --no-verify-jwt; guarded by ?key=SYNC_KEY (GroupMe can't send headers).
// ?dry=1 returns the reply as JSON instead of posting (for testing).

import { createClient } from "npm:@supabase/supabase-js@2";

const PERIOD_LABEL: Record<string, string> = {
  all: "All-Time", day: "Today's", week: "This Week's", month: "This Month's", year: "This Year's",
};

const seen = new Set<string>();

// Write one pushed message straight into the archive. Dedup by (group_id,id).
// Only touches archived groups. Members/events/scores/likes reconciled by the 6h cron.
async function ingestMessage(supabase: any, m: any) {
  const gid = String(m.group_id ?? "");
  if (!gid || !m.id) return;
  const { data: gs } = await supabase.from("group_stats").select("group_name").eq("group_id", gid).maybeSingle();
  if (!gs) return; // not an archived group -> ignore
  const row = {
    group_id: gid, id: String(m.id), group_name: gs.group_name ?? null,
    created_at: m.created_at, user_id: m.user_id ? String(m.user_id) : null,
    name: m.name ?? null, text: m.text ?? null, sender_type: m.sender_type ?? null,
    system: !!m.system, likes: (m.favorited_by ?? []).length, raw: m,
  };
  const { data: ins } = await supabase.from("messages")
    .upsert(row, { onConflict: "group_id,id", ignoreDuplicates: true }).select("id");
  if (!ins?.length) return; // duplicate delivery -> already ingested
  await supabase.rpc("touch_group", { gid, ts: m.created_at });
  await maintainDerived(supabase, gid, [m]); // keep members/events current in real-time
}

// Incremental member/event maintenance for a set of new messages (mirrors update-groupme).
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
      members.set(u, { user_id: u, member_no: ++maxNo, current_name: null, is_bot: false, msg_count: 0, likes_received: 0, first_ts: null, last_ts: null, names: [] });
      dirty.add(u);
    }
  };
  for (const m of batch) {
    const ts = m.created_at;
    const dd = (m.event ?? {}).data ?? {};
    const evType = (m.event ?? {}).type ?? "";
    if (dd.adder_user) assign(dd.adder_user.id);
    for (const u of dd.added_users ?? []) {
      assign(u.id);
      events.push({ group_id: gid, ts, type: "added", subject_uid: String(u.id), subject_name: u.nickname, actor_uid: dd.adder_user ? String(dd.adder_user.id) : null, actor_name: dd.adder_user?.nickname ?? null, detail: null });
    }
    if (dd.user && evType.includes("rejoin")) {
      assign(dd.user.id);
      events.push({ group_id: gid, ts, type: "rejoined", subject_uid: String(dd.user.id), subject_name: dd.user.nickname, actor_uid: null, actor_name: null, detail: null });
    }
    if (dd.removed_user) {
      assign(dd.remover_user?.id); assign(dd.removed_user.id);
      events.push({ group_id: gid, ts, type: dd.remover_user ? "removed" : "left", subject_uid: String(dd.removed_user.id), subject_name: dd.removed_user.nickname, actor_uid: dd.remover_user ? String(dd.remover_user.id) : null, actor_name: dd.remover_user?.nickname ?? null, detail: null });
    }
    const uid = String(m.user_id ?? "");
    if (!uid || m.system || m.sender_type === "system") continue;
    const isBot = m.sender_type === "bot";
    if (!members.has(uid)) members.set(uid, { user_id: uid, member_no: isBot ? null : ++maxNo, current_name: null, is_bot: isBot, msg_count: 0, likes_received: 0, first_ts: ts, last_ts: ts, names: [] });
    const mb = members.get(uid)!;
    mb.msg_count += 1;
    mb.likes_received += (m.favorited_by ?? []).length;
    mb.first_ts = mb.first_ts ?? ts;
    mb.last_ts = ts;
    mb.is_bot = mb.is_bot || isBot;
    if (m.name && m.name !== mb.current_name) {
      if (mb.current_name) events.push({ group_id: gid, ts, type: "renamed", subject_uid: uid, subject_name: m.name, actor_uid: null, actor_name: null, detail: `${mb.current_name} -> ${m.name}` });
      mb.current_name = m.name;
      if (!(mb.names ?? []).some((x: any) => x.name === m.name)) mb.names = [...(mb.names ?? []), { name: m.name, first_used: ts }];
    }
    dirty.add(uid);
  }
  if (dirty.size) {
    const rows = [...dirty].map((u) => ({ group_id: gid, ...members.get(u)! }));
    await supabase.from("members").upsert(rows, { onConflict: "group_id,user_id" });
  }
  if (events.length) await supabase.from("events").insert(events);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== Deno.env.get("SYNC_KEY")) {
    return new Response("forbidden", { status: 403 });
  }
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "bad json" }); }
  const dry = url.searchParams.get("dry") === "1";
  const gid = String(body.group_id ?? "");
  const reg = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Real-time archive ingestion: every message GroupMe pushes to the bot is written to
  // the DB immediately (~0 GroupMe API requests). Runs for ALL sender types (user/bot/system)
  // in archived groups. Members/events/scores/likes are reconciled by the 6-hourly cron.
  if (!dry && body.id && gid) {
    (globalThis as any).EdgeRuntime?.waitUntil?.(ingestMessage(reg, body).catch((e: any) => console.log("ingest err", String(e).slice(0, 200))));
  }

  if (body.sender_type !== "user") return Response.json({ ok: true, ingested: true });
  const text = String(body.text ?? "").trim();
  if (!/^@?skchats/i.test(text)) return Response.json({ ok: true, ingested: true });

  const msgId = String(body.id ?? "");
  if (msgId && seen.has(msgId)) return Response.json({ ok: true, ignored: "duplicate delivery" });
  if (msgId) {
    seen.add(msgId);
    if (seen.size > 200) seen.delete(seen.values().next().value);
    const { data: ins } = await reg.from("bot_seen")
      .upsert({ msg_id: msgId }, { onConflict: "msg_id", ignoreDuplicates: true }).select();
    if (!ins?.length) return Response.json({ ok: true, ignored: "duplicate delivery" });
  }
  const { data: botRows } = await reg.from("bots").select("bot_id, admin").eq("group_id", gid).limit(1);
  const botId = botRows?.[0]?.bot_id ?? JSON.parse(Deno.env.get("BOT_IDS") ?? "{}")[gid];
  const isAdminGroup = !!botRows?.[0]?.admin;
  if (!botId && !dry) return Response.json({ ok: true, ignored: "no bot registered for group" });

  const asker = body.name ?? null;
  const askerUid = body.user_id ? String(body.user_id) : null;
  if (dry) {
    const reply = await buildReply(reg, gid, text, isAdminGroup, asker, askerUid, body);
    return Response.json({ ok: true, reply });
  }
  // Ack GroupMe immediately (it redelivers slow callbacks -> duplicate posts), answer in background.
  (globalThis as any).EdgeRuntime?.waitUntil?.((async () => {
    const reply = await buildReply(reg, gid, text, isAdminGroup, asker, askerUid, body);
    if (reply) await post(botId, reply);
  })());
  return Response.json({ ok: true, queued: true });
});

// Recent group conversation leading up to an @skchats question, so the AI can
// resolve follow-ups ("help him out", "make up your mind") and GroupMe replies.
async function recentContext(supabase: any, gid: string, body: any, limit = 12): Promise<string> {
  const before = body.created_at ?? Math.floor(Date.now() / 1000);
  const curId = String(body.id ?? "");
  const { data } = await supabase.from("messages")
    .select("id, created_at, name, text, sender_type")
    .eq("group_id", gid).lte("created_at", before)
    .order("created_at", { ascending: false }).limit(limit + 6);
  const label = (m: any) => (m.sender_type === "bot" ? "SKChats" : (m.name ?? "?"));
  const rows = (data ?? []).filter((m: any) => String(m.id) !== curId).slice(0, limit).reverse();
  const lines = rows.map((m: any) => `${label(m)}: ${(m.text ?? "(media)").replace(/\s+/g, " ").slice(0, 300)}`);
  let head = "";
  const replyAtt = (body.attachments ?? []).find((a: any) => a.type === "reply");
  const rid = replyAtt ? String(replyAtt.reply_id ?? replyAtt.base_reply_id ?? "") : "";
  if (rid) {
    const { data: rm } = await supabase.from("messages")
      .select("name, text, sender_type").eq("group_id", gid).eq("id", rid).maybeSingle();
    if (rm) head = `The asker is REPLYING to this specific message -> ${label(rm)}: ${(rm.text ?? "(media)").replace(/\s+/g, " ").slice(0, 300)}\n`;
  }
  return (head + lines.join("\n")).trim();
}

async function buildReply(reg: any, gid: string, text: string, isAdminGroup: boolean, asker: string | null, askerUid: string | null, body: any): Promise<string | null> {
  let reply: string | null = null;
  try {
    const m = text.match(/^@?skchats[:,]?\s*([\s\S]*)$/i);
    if (m) {
      const rest = m[1].trim();
      const lb = rest.match(/^leaderboard(?:\s+(today|daily|day|week|weekly|month|monthly|year|yearly|help))?$/i);
      if (!rest || /^help$/i.test(rest)) {
        reply = helpText(isAdminGroup);
      } else if (isAdminGroup && /^(list\s+groups?|groups)$/i.test(rest)) {
        reply = await listGroupsText();
      } else if (lb && (lb[1] ?? "").toLowerCase() === "help") {
        reply = "How the leaderboard works - every member starts at zero:\n" +
          "+1 point per message sent\n" +
          "+20 points per like received\n" +
          "+10 points per like you give\n" +
          "-25 points each time you leave the group\n" +
          "-500 points each time you get kicked\n" +
          "-5 points per deleted message\n" +
          "-350 points per calendar month with no posts (from your join month; all-time board only)\n" +
          "Members below zero are not shown. Bots are excluded.\n" +
          "Boards: skchats leaderboard [today | week | month | year]";
      } else if (lb) {
        const p = (lb[1] ?? "").toLowerCase();
        const period = p.startsWith("to") || p === "day" || p === "daily" ? "day"
          : p.startsWith("week") ? "week"
          : p.startsWith("month") ? "month"
          : p.startsWith("year") ? "year" : "all";
        reply = isAdminGroup ? await globalLeaderboardText(period) : await leaderboardText(gid, period);
      } else {
        const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
        const context = await recentContext(reg, gid, body).catch(() => "");
        const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}`, apikey: anon },
          body: JSON.stringify({ group_id: gid, messages: [{ role: "user", text: rest }], global: isAdminGroup, admin_room: isAdminGroup, style: "short", source: "bot", asker, asker_uid: askerUid, context }),
        });
        const data = await r.json();
        reply = data.answer
          ? String(data.answer).replace(/\*\*/g, "")
          : `Sorry, I couldn't answer that (${data.error ?? "unknown error"}).`;
      }
    }
  } catch (e) {
    reply = `Something broke: ${String(e).slice(0, 120)}`;
  }
  return reply;
}

function chunkText(text: string, max = 900): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max && chunks.length < 1) {
    let cut = Math.max(rest.lastIndexOf("\n", max), rest.lastIndexOf(". ", max) + 1, rest.lastIndexOf(" ", max));
    if (cut < max * 0.4) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  chunks.push(rest.length > max ? rest.slice(0, max - 1).trimEnd() + "…" : rest);
  return chunks;
}

async function post(botId: string, text: string) {
  for (const c of chunkText(text)) {
    await fetch("https://api.groupme.com/v3/bots/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_id: botId, text: c }),
    });
    await new Promise((r) => setTimeout(r, 400));
  }
}

function periodSince(p: string) {
  const now = Date.now() / 1000;
  if (p === "day") return Math.floor(now - 86400);
  if (p === "week") return Math.floor(now - 7 * 86400);
  if (p === "month") return Math.floor(now - 30 * 86400);
  if (p === "year") return Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
  return 0;
}

async function leaderboardText(gid: string, period: string) {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let data: any[];
  if (period === "all") {
    const [scoresRes, memsRes] = await Promise.all([
      supabase.from("member_scores").select("user_id, points").eq("group_id", gid).gte("points", 0).order("points", { ascending: false }).limit(10),
      supabase.from("members").select("user_id, current_name").eq("group_id", gid),
    ]);
    if (scoresRes.error) throw new Error(scoresRes.error.message);
    const names: Record<string, string> = {};
    for (const m of memsRes.data ?? []) names[m.user_id] = m.current_name;
    data = (scoresRes.data ?? []).map((s: any) => ({ ...s, name: names[s.user_id] }));
  } else {
    const res = await supabase.rpc("leaderboard", { gid, since_ts: periodSince(period), include_inactivity: false });
    if (res.error) throw new Error(res.error.message);
    data = res.data ?? [];
  }
  const scored = data.filter((x: any) => +x.points >= 0 && (period === "all" ||
    +x.msgs > 0 || +x.likes_given > 0 || +x.lefts > 0 || +x.kicks > 0 || +x.flags > 0));
  if (!scored.length) return `🏆 ${PERIOD_LABEL[period]} Leaderboard - no activity yet.`;
  const medals = ["🥇", "🥈", "🥉", "4.", "5."];
  const lines = scored.slice(0, 5).map((x: any, i: number) =>
    `${medals[i]} ${x.name ?? x.user_id} — ${(+x.points).toLocaleString("en-US")} pts`);
  return `🏆 ${PERIOD_LABEL[period]} Leaderboard — Top 5\n${lines.join("\n")}`;
}

const MEDALS = ["🥇", "🥈", "🥉", "4.", "5."];

async function globalLeaderboardText(period: string) {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let scored: any[];
  if (period === "all") {
    const { data, error } = await supabase.rpc("global_leaderboard", { lim: 5 });
    if (error) throw new Error(error.message);
    scored = (data ?? []).filter((x: any) => +x.points >= 0);
  } else {
    const since = periodSince(period);
    const { data: groups } = await supabase.from("group_stats").select("group_id").or("local_only.is.null,local_only.eq.false");
    const agg: Record<string, { name: string; points: number }> = {};
    for (const g of groups ?? []) {
      const { data } = await supabase.rpc("leaderboard", { gid: g.group_id, since_ts: since, include_inactivity: false });
      for (const s of data ?? []) {
        if (+s.points <= 0) continue;
        const a = agg[s.user_id] ?? (agg[s.user_id] = { name: s.name ?? s.user_id, points: 0 });
        a.points += +s.points;
      }
    }
    scored = Object.values(agg).sort((a, b) => b.points - a.points);
  }
  if (!scored.length) return `🏆 Global ${PERIOD_LABEL[period]} Leaderboard - no activity yet.`;
  const lines = scored.slice(0, 5).map((x: any, i: number) =>
    `${MEDALS[i]} ${x.name ?? x.user_id} — ${(+x.points).toLocaleString("en-US")} pts`);
  return `🌐 Global ${PERIOD_LABEL[period]} Leaderboard — Top 5\n${lines.join("\n")}\n(summed across all archived groups)`;
}

async function listGroupsText() {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const [{ data: gs }, { data: bots }] = await Promise.all([
    supabase.from("group_stats").select("group_id, group_name, message_count, local_only").order("message_count", { ascending: false }),
    supabase.from("bots").select("group_id"),
  ]);
  const botSet = new Set((bots ?? []).map((b: any) => b.group_id));
  const lines = (gs ?? []).map((g: any) =>
    `• ${g.group_name} — ${(+g.message_count).toLocaleString("en-US")} msgs` +
    (g.local_only ? " [local-only]" : "") + (botSet.has(g.group_id) ? "" : " [no bot]"));
  return `📚 Archived groups (${(gs ?? []).length}):\n${lines.join("\n")}`;
}

function helpText(isAdmin: boolean) {
  const base = "SKChats commands:\n" +
    "- skchats leaderboard : top 5\n" +
    "- skchats leaderboard today / week / month / year\n" +
    "- skchats leaderboard help : how scoring works\n" +
    '- @skchats <question> : ask the AI about this chat';
  if (!isAdmin) return base;
  return "SKChats (ADMIN/global) commands:\n" +
    "- skchats leaderboard [today/week/month/year] : GLOBAL board across all groups\n" +
    "- skchats list groups : every archived group + stats\n" +
    "- skchats leaderboard help : how scoring works\n" +
    '- @skchats <question> : ask the AI across ALL groups (compare, search any group)';
}
