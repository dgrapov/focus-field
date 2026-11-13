// Focus Field shared-data API: POST /api/session, GET /api/totals, GET /api/results.
// D1 tables in schema.sql. Gatekeeping: Origin allowlist + Cloudflare Turnstile on every POST.
// Read-optimised: each save also updates small summary tables; an hourly cron rebuilds totals and results
// into one snapshot row each; GET endpoints read that row (memoised per Worker copy). Nothing a visitor
// does scans the sessions table.

import { sessionStats, stoufferFromGroups } from './stats';
import { validateSession, originAllowed, TEST_SECRETS, LABELS } from './validate';
import { overallBoard, runBoard, cumulativeByDay, tagFor, groupOf, MIN_OVERALL_DRAWS, MIN_RUN_DRAWS, TOP_N, type IdPolesRow, type RunRow, type DayRow } from './results';
import * as SQL from './sql';

// Minimal binding types (kept local so the only dev dependencies are wrangler and vitest).
interface D1Result<T> { results: T[] }
interface D1Prepared { bind(...v: unknown[]): D1Prepared; run(): Promise<unknown>; all<T>(): Promise<D1Result<T>>; first<T>(): Promise<T | null> }
interface D1Database { prepare(sql: string): D1Prepared; batch(s: D1Prepared[]): Promise<unknown[]> }
interface Ctx { waitUntil(p: Promise<unknown>): void }

export interface Env {
  DB: D1Database;
  TURNSTILE_SECRET?: string;   // Worker secret in production; never in a file
  TURNSTILE_SITE_KEY: string;  // public
}

const MAX_BODY = 1_000_000;
const MEMO_MS = 5 * 60 * 1000;        // each Worker copy re-reads the snapshot row at most every 5 minutes
const CLIENT_MAX_AGE = 600;           // browsers may reuse a response for 10 minutes
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITE_HOSTNAME = 'dgrapov.github.io';

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
  const test = TEST_SECRETS.has(secret);
  if (test && origin.startsWith('https://')) return false;                     // test keys only ever for localhost
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);                                          // passed through, never stored
  try {
    const r = await fetch(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { console.log('turnstile_http', r.status); return false; }
    const out = (await r.json()) as { success?: boolean; hostname?: string; 'error-codes'?: string[] };
    // A real token must have been issued on the site itself. Test secrets report a placeholder hostname, so skip it there.
    const good = out.success === true && (test || out.hostname === SITE_HOSTNAME);
    if (!good) console.log('turnstile_reject', JSON.stringify({ success: out.success, hostname: out.hostname, codes: out['error-codes'] }));   // no secret, token or IP
    return good;
  } catch (e) {
    console.log('turnstile_error', e instanceof Error ? e.name : 'unknown');
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
  const now = new Date().toISOString();
  const db = env.DB;
  const stmts = [
    db.prepare(SQL.INSERT_SESSION).bind(
      id, now, s.participant_id, s.label, s.poles, s.per_second_counts.length, s.block_size, s.app_version,
      JSON.stringify(s.per_second_counts), JSON.stringify(s.focus_marks),
      st.goal_n, st.goal_hits, st.goal_z, st.goal_p, st.base_chi2, st.base_p, JSON.stringify(flags)),
    db.prepare(SQL.UPSERT_ID_POLES).bind(s.label, s.participant_id, s.poles, st.goal_n, st.goal_hits),
    db.prepare(SQL.UPSERT_DAY).bind(s.label, now.slice(0, 10), s.poles, st.goal_n, st.goal_hits, s.per_second_counts.length),
  ];
  if (st.goal_n >= MIN_RUN_DRAWS && st.goal_z !== null) stmts.push(db.prepare(SQL.UPSERT_RUN).bind(groupOf(s.label), s.participant_id, st.goal_z, now));
  await db.batch(stmts);                                           // one transaction: the session and its summaries land together

  return json({
    accepted: true, id,
    goal_n: st.goal_n, goal_hits: st.goal_hits, goal_z: st.goal_z, goal_p: st.goal_p,
    base_chi2: st.base_chi2, base_p: st.base_p, flags,
  }, 200, origin);
}

// ---------- hourly rebuild: summary tables -> one snapshot row per endpoint ----------
interface Row { label: string; poles: number; sessions: number; seconds: number; n: number; hits: number }

/** Build both snapshots from the summary tables (rows grow with ids and days, not sessions). */
export async function rebuild(env: Env): Promise<{ totals: string; results: string }> {
  const db = env.DB;
  const [idRows, runRows, dayRows] = await Promise.all([
    db.prepare(SQL.READ_ID_POLES).all<IdPolesRow>(),
    db.prepare(SQL.READ_RUNS).all<RunRow>(),
    db.prepare(SQL.READ_DAYS).all<DayRow>(),
  ]);
  const built = new Date().toISOString();

  // Totals per label, from the per-day rows summed over days.
  const labels = LABELS.map(label => {
    const rows = dayRows.results.filter(r => r.label === label);
    const byPoles = new Map<number, Row>();
    for (const r of rows) {
      const g = byPoles.get(r.poles) || { label, poles: r.poles, sessions: 0, seconds: 0, n: 0, hits: 0 };
      g.sessions += Number(r.sessions); g.seconds += Number(r.seconds); g.n += Number(r.n); g.hits += Number(r.hits); byPoles.set(r.poles, g);
    }
    const gs = [...byPoles.values()];
    const zp = stoufferFromGroups(gs.map(g => ({ poles: g.poles, n: g.n, hits: g.hits })));
    const sum = (k: 'sessions' | 'seconds' | 'n' | 'hits') => gs.reduce((a, g) => a + g[k], 0);
    return { label, sessions: sum('sessions'), seconds: sum('seconds'), goal_n: sum('n'), goal_hits: sum('hits'), z: zp.z, p: zp.p };
  });
  const totals = JSON.stringify({ updated_at: built, labels });

  const id = (pid: string) => pid;
  const op = overallBoard(idRows.results, 'participants', id), oc = overallBoard(idRows.results, 'control', id);
  const rp = runBoard(runRows.results, 'participants', id), rc = runBoard(runRows.results, 'control', id);
  for (const b of [op.board, oc.board, rp, rc]) for (const e of b.top) e.tag = await tagFor(e.tag);   // public tags only for shown rows
  const results = JSON.stringify({
    updated_at: built,
    rules: { top_n: TOP_N, min_overall_focus_minutes: MIN_OVERALL_DRAWS / 500 / 60, min_run_focus_seconds: MIN_RUN_DRAWS / 500, rebuilt: 'hourly' },
    overall: { participants: op.board, control: oc.board },
    single_run: { participants: rp, control: rc },
    cumulative: cumulativeByDay(dayRows.results, LABELS),
    funnel: { participants: op.funnel, control: oc.funnel },
  });

  await db.batch([
    db.prepare(SQL.WRITE_SNAPSHOT).bind('totals', totals, built),
    db.prepare(SQL.WRITE_SNAPSHOT).bind('results', results, built),
  ]);
  memo.clear();
  return { totals, results };
}

// Per-Worker-copy memo of the snapshot rows (the Cache API does nothing on *.workers.dev).
const memo = new Map<string, { at: number; body: string }>();

async function getSnapshot(key: 'totals' | 'results', env: Env, origin: string | null): Promise<Response> {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CLIENT_MAX_AGE}`, ...cors(origin) };
  const now = Date.now();
  const m = memo.get(key);
  if (m && now - m.at < MEMO_MS) return new Response(m.body, { headers });
  const row = await env.DB.prepare(SQL.READ_SNAPSHOT).bind(key).first<{ body: string }>();
  // No snapshot yet (first deploy, before the first cron run): build once now.
  const body = row ? row.body : (await rebuild(env))[key];
  memo.set(key, { at: now, body });
  return new Response(body, { headers });
}

export default {
  // Cron (wrangler.jsonc "triggers"): rebuild the snapshots once an hour.
  async scheduled(_event: unknown, env: Env, ctx: Ctx): Promise<void> {
    ctx.waitUntil(rebuild(env).then(() => undefined));
  },

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
        return await getSnapshot('totals', env, origin);
      }
      if (url.pathname === '/api/results') {
        if (req.method !== 'GET') return fail('method_not_allowed', 405, origin);
        if (origin && !originAllowed(origin)) return fail('bad_origin', 403, origin);
        return await getSnapshot('results', env, origin);
      }
      return fail('not_found', 404, origin);
    } catch (e) {
      console.error('server_error', e instanceof Error ? e.message : String(e));
      return fail('server_error', 500, origin);
    }
  },
};
