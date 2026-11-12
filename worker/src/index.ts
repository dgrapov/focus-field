// Focus Field shared-data API: POST /api/session, GET /api/totals.
// One D1 table (schema.sql). Gatekeeping: Origin allowlist + Cloudflare Turnstile on every POST.

import { sessionStats, stoufferFromGroups } from './stats';
import { validateSession, originAllowed, TEST_SECRETS, LABELS } from './validate';

// Minimal binding types (kept local so the only dev dependencies are wrangler and vitest).
interface D1Result<T> { results: T[] }
interface D1Prepared { bind(...v: unknown[]): D1Prepared; run(): Promise<unknown>; all<T>(): Promise<D1Result<T>> }
interface D1Database { prepare(sql: string): D1Prepared }
interface Ctx { waitUntil(p: Promise<unknown>): void }
declare const caches: { default: { match(k: Request): Promise<Response | undefined>; put(k: Request, r: Response): Promise<void>; delete(k: Request): Promise<boolean> } };

export interface Env {
  DB: D1Database;
  TURNSTILE_SECRET?: string;   // Worker secret in production; never in a file
  TURNSTILE_SITE_KEY: string;  // public
}

const MAX_BODY = 1_000_000;
const TOTALS_TTL = 60;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function cors(origin: string | null): Record<string, string> {
  if (!originAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin as string,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...cors(origin), ...extra },
  });
}
const fail = (code: string, status: number, origin: string | null) => json({ accepted: false, error: code }, status, origin);

async function verifyTurnstile(env: Env, token: string, origin: string, ip: string | null): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return false;                                                    // fail closed
  if (TEST_SECRETS.has(secret) && origin.startsWith('https://')) return false;  // test keys only ever for localhost
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);                                          // passed through, never stored
  try {
    const r = await fetch(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return false;
    const out = (await r.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}

async function postSession(req: Request, env: Env, ctx: Ctx, origin: string | null): Promise<Response> {
  if (!originAllowed(origin)) return fail('bad_origin', 403, origin);

  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return fail('bad_input', 413, origin);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return fail('bad_input', 413, origin);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(buf)); } catch { return fail('bad_input', 400, origin); }

  const v = validateSession(body);
  if (!v.ok) { console.log('bad_input', v.reason); return fail('bad_input', 400, origin); }
  const s = v.value;

  if (!(await verifyTurnstile(env, s.turnstile_token, origin as string, req.headers.get('CF-Connecting-IP')))) {
    return fail('bad_token', 403, origin);
  }

  const st = sessionStats(s.poles, s.per_second_counts, s.focus_marks);
  const id = crypto.randomUUID();
  const flags = v.flags;
  await env.DB.prepare(
    `INSERT INTO sessions (id, received_at, participant_id, label, poles, seconds, block_size, app_version,
       per_second_counts, focus_marks, goal_n, goal_hits, goal_z, goal_p, base_chi2, base_p, flags)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`
  ).bind(
    id, new Date().toISOString(), s.participant_id, s.label, s.poles, s.per_second_counts.length, s.block_size, s.app_version,
    JSON.stringify(s.per_second_counts), JSON.stringify(s.focus_marks),
    st.goal_n, st.goal_hits, st.goal_z, st.goal_p, st.base_chi2, st.base_p, JSON.stringify(flags)
  ).run();

  memo = null;                                                     // next /api/totals recomputes
  ctx.waitUntil(caches.default.delete(totalsKey(req)).catch(() => false));

  return json({
    accepted: true, id,
    goal_n: st.goal_n, goal_hits: st.goal_hits, goal_z: st.goal_z, goal_p: st.goal_p,
    base_chi2: st.base_chi2, base_p: st.base_p, flags,
  }, 200, origin);
}

// ---------- totals: per-isolate memo + Cache API (the Cache API is a no-op on *.workers.dev) ----------
let memo: { at: number; body: string } | null = null;
const totalsKey = (req: Request) => new Request(new URL('/api/totals', req.url).toString(), { method: 'GET' });

interface Row { label: string; poles: number; sessions: number; seconds: number; goal_n: number; goal_hits: number }

async function computeTotals(env: Env): Promise<string> {
  // Sum per (label, poles) in SQL; Stouffer's Z is linear in those sums (see stats.ts), so no rows leave D1.
  const { results } = await env.DB.prepare(
    `SELECT label, poles, COUNT(*) AS sessions, SUM(seconds) AS seconds,
            SUM(COALESCE(goal_n, 0)) AS goal_n, SUM(COALESCE(goal_hits, 0)) AS goal_hits
       FROM sessions GROUP BY label, poles`
  ).all<Row>();
  const labels = LABELS.map(label => {
    const rows = results.filter(r => r.label === label);
    const sum = (k: keyof Row) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
    const zp = stoufferFromGroups(rows.map(r => ({ poles: r.poles, n: Number(r.goal_n), hits: Number(r.goal_hits) })));
    return { label, sessions: sum('sessions'), seconds: sum('seconds'), goal_n: sum('goal_n'), goal_hits: sum('goal_hits'), z: zp.z, p: zp.p };
  });
  return JSON.stringify({ updated_at: new Date().toISOString(), labels });
}

async function getTotals(req: Request, env: Env, ctx: Ctx, origin: string | null): Promise<Response> {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${TOTALS_TTL}`, ...cors(origin) };
  const now = Date.now();
  if (memo && now - memo.at < TOTALS_TTL * 1000) return new Response(memo.body, { headers });

  const key = totalsKey(req);
  const hit = await caches.default.match(key).catch(() => undefined);
  if (hit) {
    const body = await hit.text();
    memo = { at: now, body };
    return new Response(body, { headers });
  }
  const body = await computeTotals(env);
  memo = { at: now, body };
  ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'Cache-Control': `public, max-age=${TOTALS_TTL}` } })).catch(() => {}));
  return new Response(body, { headers });
}

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    try {
      if (req.method === 'OPTIONS') {
        if (!originAllowed(origin)) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: cors(origin) });
      }
      if (url.pathname === '/api/session') {
        if (req.method !== 'POST') return fail('method_not_allowed', 405, origin);
        return await postSession(req, env, ctx, origin);
      }
      if (url.pathname === '/api/totals') {
        if (req.method !== 'GET') return fail('method_not_allowed', 405, origin);
        if (origin && !originAllowed(origin)) return fail('bad_origin', 403, origin);
        return await getTotals(req, env, ctx, origin);
      }
      return fail('not_found', 404, origin);
    } catch (e) {
      console.error('server_error', e instanceof Error ? e.message : String(e));
      return fail('server_error', 500, origin);
    }
  },
};
