// GroupMe Archive
// Copyright (c) 2026 Shalom Karr
// Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
// use without permission, and derivatives must remain open under the same terms.
// See the LICENSE file for full terms.

// Shared helpers for the GroupMe Archive dashboard/leaderboard/admin pages.
const SUPA_URL = 'https://yzszkjabldmvaploythp.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6c3pramFibGRtdmFwbG95dGhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwNzM3MDQsImV4cCI6MjEwMDY0OTcwNH0.lueqxO0z1Rix5wWGZa_77mx72-nJ24fboSriGhlMuq0';
let session = null;
function loadSession() { try { session = JSON.parse(localStorage.getItem('sk_auth') || 'null'); } catch { session = null; } }
function signOut() { localStorage.removeItem('sk_auth'); location.reload(); }
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

for (const k of Object.keys(localStorage)) if (k.startsWith('skc:')) localStorage.removeItem(k);
async function cached(key, ttl, fetcher) {
  try {
    const e = JSON.parse(localStorage.getItem('skc2:' + key) || 'null');
    if (e && Date.now() - e.t < ttl) return e.v;
  } catch {}
  const v = await fetcher();
  try { localStorage.setItem('skc2:' + key, JSON.stringify({ t: Date.now(), v })); } catch {}
  return v;
}

async function sbAll(path) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const chunk = await sb(`${path}${path.includes('?') ? '&' : '?'}limit=1000&offset=${off}`);
    out.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return out;
}
