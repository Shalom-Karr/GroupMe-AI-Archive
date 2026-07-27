// GroupMe Archive
// Copyright (c) 2026 Shalom Karr
// Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
// use without permission, and derivatives must remain open under the same terms.
// See the LICENSE file for full terms.

// Shared archive AI plumbing: Gemini model-fallback cascade + read-only archive
// tools (search_messages / get_context / run_sql / leaderboard / list_admins /
// member_lookup). Copied from chat/index.ts (which keeps its own private copies)
// with two changes: everything is exported, and gemini() takes the tool
// declarations + generationConfig as parameters instead of a module constant.

export const GEMINI_MODELS = (Deno.env.get("GEMINI_MODELS") ??
  ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemma-4-31b-it", "gemma-4-26b-a4b-it",
   "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview",
   "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite"].join(","))
  .split(",").map((m) => m.trim()).filter(Boolean);
let modelIdx = 0;

export async function gemini(system: string, contents: any[], tools?: any[] | null, generationConfig?: any) {
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents,
    ...(tools?.length ? { tools } : {}),
    ...(generationConfig ? { generationConfig } : {}),
  });
  for (let i = modelIdx; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${Deno.env.get("GEMINI_API_KEY")}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
      );
      if (r.status === 429) break;
      if (r.status >= 500) { await new Promise((res) => setTimeout(res, 1500)); continue; }
      if (!r.ok) { break; }
      modelIdx = i;
      return { data: await r.json(), model };
    }
  }
  modelIdx = 0;
  throw new Error("all Gemini models are rate-limited right now - try again in a minute");
}

export async function runTool(supabase: any, gid: string, name: string, args: any, isGlobal = false) {
  if (name === "search_messages") {
    let q = supabase.from("messages")
      .select("id, created_at, name, text, likes")
      .eq("group_id", gid)
      .textSearch("fts", args.query, { type: "websearch", config: "english" })
      .order("created_at", { ascending: false })
      .limit(Math.min(args.limit ?? 20, 50));
    if (args.member) {
      const uid = await resolveUid(supabase, gid, args.member);
      if (uid) q = q.eq("user_id", uid);
    }
    if (args.after) q = q.gte("created_at", Date.parse(args.after) / 1000);
    if (args.before) q = q.lte("created_at", Date.parse(args.before) / 1000);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []).map((m: any) => ({ ...m, date: iso(m.created_at) }));
  }

  if (name === "get_context") {
    let center = args.date_time ? Date.parse(args.date_time) / 1000 : null;
    if (args.message_id) {
      const { data } = await supabase.from("messages").select("created_at")
        .eq("group_id", gid).eq("id", args.message_id).single();
      center = data?.created_at ?? center;
    }
    if (!center) throw new Error("need message_id or date_time");
    const n = Math.min(args.n ?? 15, 40);
    const [before, after] = await Promise.all([
      supabase.from("messages").select("created_at, name, text, likes").eq("group_id", gid)
        .lte("created_at", center).order("created_at", { ascending: false }).limit(n),
      supabase.from("messages").select("created_at, name, text, likes").eq("group_id", gid)
        .gt("created_at", center).order("created_at", { ascending: true }).limit(n),
    ]);
    const rows = [...(before.data ?? []).reverse(), ...(after.data ?? [])];
    return rows.map((m: any) => `[${iso(m.created_at)}] ${m.name}: ${m.text ?? "(media)"}`);
  }

  if (name === "run_sql") {
    // Cross-group confinement is enforced in the DB: run_readonly drops to a
    // non-bypassrls role scoped by app.gid; a non-global query for another group
    // simply returns [] (RLS-filtered). No app-layer substring guard needed.
    const cleanQ = String(args.query ?? "").trim().replace(/;+\s*$/, "");
    const { data, error } = await supabase.rpc("run_readonly", { q: cleanQ, gid, is_global: isGlobal });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data.slice(0, 100) : data;
  }

  if (name === "leaderboard") {
    const p = ["day", "week", "month", "year"].includes(args.period) ? args.period : "all";
    const lim = Math.min(args.limit ?? 10, 25);
    if (p === "all") {
      const [scoresRes, memsRes] = await Promise.all([
        supabase.from("member_scores").select("*").eq("group_id", gid).gte("points", 0).order("points", { ascending: false }).limit(lim),
        supabase.from("members").select("user_id, current_name, last_ts, role").eq("group_id", gid),
      ]);
      if (scoresRes.error) throw new Error(scoresRes.error.message);
      const info: Record<string, any> = {};
      for (const m of memsRes.data ?? []) info[m.user_id] = m;
      return (scoresRes.data ?? []).map((s: any) => ({
        ...s,
        name: info[s.user_id]?.current_name,
        role: info[s.user_id]?.role ?? null,
        last_active: iso(info[s.user_id]?.last_ts),
      }));
    }
    const now = Date.now() / 1000;
    const since = p === "day" ? Math.floor(now - 86400)
      : p === "week" ? Math.floor(now - 7 * 86400)
      : p === "month" ? Math.floor(now - 30 * 86400)
      : Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
    const { data, error } = await supabase.rpc("leaderboard", { gid, since_ts: since, include_inactivity: false });
    if (error) throw new Error(error.message);
    return (data ?? []).filter((x: any) => +x.points >= 0).slice(0, lim);
  }

  if (name === "list_admins") {
    const { data, error } = await supabase.from("members")
      .select("current_name, user_id, role")
      .eq("group_id", gid).in("role", ["owner", "admin"])
      .order("role", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  if (name === "member_lookup") {
    const uid = await resolveUid(supabase, gid, args.who);
    if (!uid) return { error: `no member matching "${args.who}"` };
    const [{ data: mb }, { data: evs }, { data: lb }] = await Promise.all([
      supabase.from("members").select("*").eq("group_id", gid).eq("user_id", uid).single(),
      supabase.from("events").select("ts, type, subject_name, actor_name, detail")
        .eq("group_id", gid).eq("subject_uid", uid).order("ts").limit(200),
      supabase.rpc("leaderboard", { gid, since_ts: 0, include_inactivity: true }),
    ]);
    const idx = (lb ?? []).findIndex((x: any) => x.user_id === uid);
    const row = idx >= 0 ? lb[idx] : null;
    return {
      ...mb,
      member_no_meaning: `member_no ${mb?.member_no} = the ${mb?.member_no}th person to ever enter the group (join order), NOT a ranking`,
      group_role: mb?.role ?? "not currently in the group (or role unknown until next sync)",
      leaderboard_rank: idx >= 0 ? idx + 1 : null,
      leaderboard_points: row ? +row.points : null,
      first_ts: iso(mb?.first_ts), last_ts: iso(mb?.last_ts),
      timeline: (evs ?? []).map((e: any) => ({ date: iso(e.ts), type: e.type, by: e.actor_name, detail: e.detail })),
    };
  }

  throw new Error(`unknown tool ${name}`);
}

export async function resolveUid(supabase: any, gid: string, who: string) {
  const w = String(who).trim();
  const { data: exact } = await supabase.from("members").select("user_id")
    .eq("group_id", gid).eq("user_id", w).limit(1);
  if (exact?.length) return exact[0].user_id;
  const { data } = await supabase.from("members").select("user_id, current_name, names, msg_count")
    .eq("group_id", gid).order("msg_count", { ascending: false });
  const lw = w.toLowerCase();
  const hit = (data ?? []).find((m: any) =>
    (m.current_name ?? "").toLowerCase() === lw ||
    (m.names ?? []).some((n: any) => (n.name ?? "").toLowerCase() === lw)) ??
    (data ?? []).find((m: any) =>
      (m.current_name ?? "").toLowerCase().includes(lw) ||
      (m.names ?? []).some((n: any) => (n.name ?? "").toLowerCase().includes(lw)));
  return hit?.user_id ?? null;
}

export function iso(ts: number | null) {
  return ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) : null;
}
