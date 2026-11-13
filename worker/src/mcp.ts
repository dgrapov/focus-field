// Focus Field MCP server: a separate Worker (wrangler.mcp.jsonc) on the same D1 database as the web API.
// Stateless MCP over streamable HTTP: every request is a JSON-RPC POST to /mcp answered with application/json;
// no SSE stream and no MCP session ids. Protocol: dev/MCP-ATTENTION-PROTOCOL.md.
//
// One session: get_methods -> start_session -> (begin_block -> agent attends -> draw_block) x blocks -> finish_session.
// The server draws the random numbers only inside draw_block, after the agent's attention log arrives.
// Gatekeeping: anonymous keys passed as a tool argument, per-key and global daily caps in D1, an Origin check.

import { pUpper, stoufferFromGroups } from './stats';
import { originAllowed } from './validate';
import * as SQL from './mcp-sql';
import {
  TOOLS, PROMPTS, PROTOCOL_PROMPT, SERVER_INSTRUCTIONS, REST_INSTRUCTION, negotiateVersion, drawBlock, shuffleSchedule,
  uniform, zOf, diffZ, labelFor, newKey, hashKey, KEY_RE, checkAgent, checkStart, checkSessionId, checkBlockId, checkLog,
  checkReflection, checkRating, IDLE_MINUTES, DRAWS_PER_BLOCK, type Kind, type Rand, cryptoRand,
} from './mcp-core';

// Minimal binding types (as in index.ts), so tests can pass an adapter over node:sqlite.
export interface D1Prepared { bind(...v: unknown[]): D1Prepared; run(): Promise<{ meta?: { changes?: number } }>; all<T>(): Promise<{ results: T[] }>; first<T>(): Promise<T | null> }
export interface D1Database { prepare(sql: string): D1Prepared }

export interface McpEnv {
  DB: D1Database;
  // Caps (wrangler.mcp.jsonc "vars"); defaults below when unset. MCP_REGISTRATION = "closed" stops new keys.
  MCP_REGISTRATION?: string;
  MCP_MAX_KEYS_PER_DAY?: string;
  MCP_MAX_SESSIONS_PER_DAY?: string;
  MCP_MAX_BLOCKS_PER_DAY?: string;
  MCP_MAX_SESSIONS_PER_KEY_PER_DAY?: string;
  MCP_MAX_SESSIONS_PER_TRUSTED_KEY_PER_DAY?: string;
  MCP_MAX_OPEN_PER_KEY?: string;
}

const DEFAULTS = {
  MCP_MAX_KEYS_PER_DAY: 50,
  MCP_MAX_SESSIONS_PER_DAY: 300,
  MCP_MAX_BLOCKS_PER_DAY: 8000,                 // ~5 D1 row writes per block → 40k of the 100k/day free writes
  MCP_MAX_SESSIONS_PER_KEY_PER_DAY: 10,
  MCP_MAX_SESSIONS_PER_TRUSTED_KEY_PER_DAY: 100,
  MCP_MAX_OPEN_PER_KEY: 2,
};
const cap = (env: McpEnv, k: keyof typeof DEFAULTS) => { const v = Number(env[k]); return env[k] !== undefined && Number.isFinite(v) && v >= 0 ? v : DEFAULTS[k]; };

const MAX_BODY = 64_000;
const SERVER_INFO = { name: 'focus-field', title: 'Focus Field', version: '1.0.0' };
const TOTALS_MEMO_MS = 5 * 60 * 1000;

// ---------- helpers ----------
class ToolError extends Error {}
type Obj = Record<string, unknown>;
const toolResult = (o: Obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(o) }], structuredContent: o, ...(isError ? { isError: true } : {}) });
const today = (now: Date) => now.toISOString().slice(0, 10);
const r4 = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
const cutoff = (now: Date) => new Date(now.getTime() - IDLE_MINUTES * 60_000).toISOString();

async function usage(env: McpEnv, day: string) {
  return (await env.DB.prepare(SQL.USAGE_GET).bind(day).first<{ keys: number; sessions: number; blocks: number }>()) || { keys: 0, sessions: 0, blocks: 0 };
}
const addUsage = (env: McpEnv, day: string, keys: number, sessions: number, blocks: number) => env.DB.prepare(SQL.USAGE_ADD).bind(day, keys, sessions, blocks).run();

interface Key { id: string; trusted: boolean; agent: string | null }
async function auth(env: McpEnv, key: unknown): Promise<Key> {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new ToolError('key: call register first and pass the key it returns (ffk_...)');
  const row = await env.DB.prepare(SQL.FIND_KEY).bind(await hashKey(key)).first<{ id: string; trusted: number; revoked: number; agent: string | null }>();
  if (!row) throw new ToolError('key: unknown key; call register to get one');
  if (row.revoked) throw new ToolError('key: this key has been revoked');
  return { id: row.id, trusted: !!row.trusted, agent: row.agent };
}

interface SessionRow {
  id: string; received_at: string; label: string; poles: number; seconds: number; block_size: number;
  goal_n: number; goal_hits: number; goal_z: number | null; goal_p: number | null; rest_n: number; rest_hits: number; rest_z: number | null; rest_p: number | null;
  status: string; method: string; custom_description: string | null; menu_version: string; planned_blocks: number; schedule: string; updated_at: string;
}
async function loadSession(env: McpEnv, keyId: string, sid: unknown): Promise<SessionRow> {
  const id = checkSessionId(sid); if (!id.ok) throw new ToolError(id.error);
  const row = await env.DB.prepare(SQL.GET_SESSION).bind(id.value, keyId).first<SessionRow>();
  if (!row) throw new ToolError('session_id: no such session for this key');
  return row;
}

/** Close idle open sessions of a key as abandoned (drawn blocks still count; undrawn ones are dropped). */
async function closeIdle(env: McpEnv, keyId: string, now: Date): Promise<string[]> {
  const ids = (await env.DB.prepare(SQL.IDLE_SESSIONS).bind(keyId, cutoff(now)).all<{ id: string }>()).results.map(r => r.id);
  for (const id of ids) {
    await env.DB.prepare(SQL.CLOSE_SESSION).bind(id, 'abandoned', now.toISOString(), null).run();
    await env.DB.prepare(SQL.DROP_UNDRAWN).bind(id).run();
  }
  return ids;
}
async function requireOpen(env: McpEnv, k: Key, row: SessionRow, now: Date) {
  if (row.status === 'open' && (await closeIdle(env, k.id, now)).includes(row.id)) row.status = 'abandoned';
  if (row.status === 'abandoned') throw new ToolError(`this session was idle for over ${IDLE_MINUTES} minutes and was closed; its drawn blocks still count. Start a new session`);
  if (row.status !== 'open') throw new ToolError('this session is finished; start a new one');
}

function summary(row: Pick<SessionRow, 'goal_n' | 'goal_hits' | 'goal_z' | 'goal_p' | 'rest_n' | 'rest_hits' | 'rest_z' | 'rest_p'>) {
  const d = diffZ(row.goal_z, row.rest_z);
  return {
    focus: { draws: row.goal_n, hits: row.goal_hits, z: r4(row.goal_z), p: r4(row.goal_p) },
    rest: { draws: row.rest_n, hits: row.rest_hits, z: r4(row.rest_z), p: r4(row.rest_p) },
    focus_minus_rest: { z: r4(d.z), p: r4(d.p) },
  };
}

interface AggRow { label: string; method: string; menu_version: string; kind: Kind; poles: number; sessions: number; n: number; hits: number }
/** Stouffer focus z, rest z and their difference over a set of agg_method rows (grouped by poles inside). */
function pool(rows: AggRow[]) {
  const side = (kind: Kind) => {
    const rs = rows.filter(r => r.kind === kind);
    const z = stoufferFromGroups(rs.map(r => ({ poles: Number(r.poles), n: Number(r.n), hits: Number(r.hits) })));
    return { draws: rs.reduce((a, r) => a + Number(r.n), 0), z: r4(z.z), p: r4(z.p) };
  };
  const f = side('focus'), r = side('rest'), d = diffZ(f.z, r.z);
  return { sessions: rows.filter(x => x.kind === 'focus').reduce((a, x) => a + Number(x.sessions), 0), focus: f, rest: r, focus_minus_rest: { z: r4(d.z), p: r4(d.p) } };
}
const methodRows = async (env: McpEnv) => (await env.DB.prepare(SQL.READ_METHODS_AGG).all<AggRow>()).results;

// ---------- tools ----------
async function register(env: McpEnv, a: Obj, now: Date): Promise<Obj> {
  if ((env.MCP_REGISTRATION || 'open') === 'closed') throw new ToolError('register: new keys are not being issued right now');
  const agent = checkAgent(a.agent); if (!agent.ok) throw new ToolError(agent.error);
  const day = today(now);
  if ((await usage(env, day)).keys >= cap(env, 'MCP_MAX_KEYS_PER_DAY')) throw new ToolError('register: the daily limit for new keys is reached; try again tomorrow (UTC)');
  const { key, id } = newKey();
  await env.DB.prepare(SQL.INSERT_KEY).bind(id, await hashKey(key), now.toISOString(), agent.value).run();
  await addUsage(env, day, 1, 0, 0);
  return { key, key_id: id, note: 'Keep this key and pass it as "key" to the other tools. It is shown only once and cannot be recovered. Next: get_methods.' };
}

async function getMethods(env: McpEnv, a: Obj): Promise<Obj> {
  await auth(env, a.key);
  const menu = (await env.DB.prepare(SQL.METHODS).all<{ menu_version: string; id: string; name: string; instruction: string }>()).results;
  const agg = await methodRows(env);
  return {
    menu_version: menu[0]?.menu_version ?? null,
    methods: menu.map(m => ({ id: m.id, name: m.name, instruction: m.instruction, results: pool(agg.filter(r => r.method === m.id)) })),
    note: 'Pick one method and use only it for the whole session. Results pool all agent sessions with that method id; under pure chance every z stays near 0.',
  };
}

async function startSession(env: McpEnv, a: Obj, now: Date, rand: Rand): Promise<Obj> {
  const k = await auth(env, a.key);
  const menu = (await env.DB.prepare(SQL.METHODS).all<{ menu_version: string; id: string }>()).results;
  const s = checkStart(a, menu.map(m => m.id)); if (!s.ok) throw new ToolError(s.error);
  const day = today(now), nowIso = now.toISOString();
  await closeIdle(env, k.id, now);
  const load = (await env.DB.prepare(SQL.KEY_LOAD).bind(k.id, day + 'T00:00:00.000Z').first<{ today: number; open: number }>()) || { today: 0, open: 0 };
  if (Number(load.open) >= cap(env, 'MCP_MAX_OPEN_PER_KEY')) throw new ToolError(`start_session: you already have ${load.open} open session(s); finish them first (idle sessions close after ${IDLE_MINUTES} minutes)`);
  const perKey = cap(env, k.trusted ? 'MCP_MAX_SESSIONS_PER_TRUSTED_KEY_PER_DAY' : 'MCP_MAX_SESSIONS_PER_KEY_PER_DAY');
  if (Number(load.today) >= perKey) throw new ToolError(`start_session: this key's daily limit of ${perKey} sessions is reached; try again tomorrow (UTC)`);
  if ((await usage(env, day)).sessions >= cap(env, 'MCP_MAX_SESSIONS_PER_DAY')) throw new ToolError('start_session: the daily limit for agent sessions is reached; try again tomorrow (UTC)');

  const id = crypto.randomUUID(), label = labelFor(k.trusted), menuVersion = menu.find(m => m.id === s.value.method)!.menu_version;
  const schedule = shuffleSchedule(s.value.blocks, rand);
  await env.DB.prepare(SQL.INSERT_SESSION).bind(id, nowIso, 'key-' + k.id, label, s.value.poles, k.id, k.agent, s.value.method, s.value.custom, menuVersion, s.value.blocks, JSON.stringify(schedule), DRAWS_PER_BLOCK).run();
  await addUsage(env, day, 0, 1, 0);
  return {
    session_id: id, label, method: s.value.method, menu_version: menuVersion, poles: s.value.poles, blocks: s.value.blocks, draws_per_block: DRAWS_PER_BLOCK,
    reminder: 'Half the blocks are rest blocks, in a hidden order. For each block: begin_block, then attend using your method, then draw_block with an honest attention_log. Every drawn block counts. End with finish_session.',
  };
}

async function beginBlock(env: McpEnv, a: Obj, now: Date, rand: Rand): Promise<Obj> {
  const k = await auth(env, a.key);
  const row = await loadSession(env, k.id, a.session_id);
  await requireOpen(env, k, row, now);
  const K = Number(row.poles), planned = Number(row.planned_blocks);
  const describe = async (b: { idx: number; kind: Kind; pole: number }, again: boolean): Promise<Obj> => {
    const left = planned - Number(row.seconds);
    if (b.kind === 'rest') return { block_id: b.idx, of: planned, kind: 'rest', instruction: REST_INSTRUCTION, blocks_left: left, ...(again ? { note: 'This block was already begun; draw it next.' } : {}) };
    const m = await env.DB.prepare(SQL.GET_METHOD).bind(row.menu_version, row.method).first<{ name: string; instruction: string }>();
    const how = row.method === 'custom' ? `Your method: ${row.custom_description}` : `${m?.name ?? row.method}: ${m?.instruction ?? ''}`;
    return {
      block_id: b.idx, of: planned, kind: 'focus', goal: b.pole, poles: K,
      instruction: `Focus block. Goal: pole ${b.pole} (of 0..${K - 1}) wins this block. ${how} Call draw_block only when your attention is fully placed.`,
      blocks_left: left, ...(again ? { note: 'This block was already begun; draw it next.' } : {}),
    };
  };
  const open = await env.DB.prepare(SQL.OPEN_BLOCK).bind(row.id).first<{ idx: number; kind: Kind; pole: number }>();
  if (open) return describe(open, true);
  if (Number(row.seconds) >= planned) throw new ToolError('begin_block: all blocks are drawn; call finish_session');
  const idx = Number(row.seconds) + 1;
  const kind = (JSON.parse(row.schedule) as Kind[])[idx - 1];
  const pole = uniform(K, rand);                                   // the goal, or the hidden shadow pole of a rest block
  try {
    await env.DB.prepare(SQL.INSERT_BLOCK).bind(row.id, idx, kind, pole, now.toISOString()).run();
  } catch {
    const b = await env.DB.prepare(SQL.OPEN_BLOCK).bind(row.id).first<{ idx: number; kind: Kind; pole: number }>();   // a parallel begin won
    if (b) return describe(b, true);
    throw new ToolError('begin_block: please call again');
  }
  return describe({ idx, kind, pole }, false);
}

async function drawBlockTool(env: McpEnv, a: Obj, now: Date, rand: Rand): Promise<Obj> {
  const k = await auth(env, a.key);
  const row = await loadSession(env, k.id, a.session_id);
  await requireOpen(env, k, row, now);
  const bid = checkBlockId(a.block_id); if (!bid.ok) throw new ToolError(bid.error);
  const b = await env.DB.prepare(SQL.GET_BLOCK).bind(row.id, bid.value).first<{ idx: number; kind: Kind; pole: number; begun_at: string; drawn_at: string | null }>();
  if (!b) throw new ToolError('draw_block: this block has not been begun; call begin_block first');
  if (b.drawn_at) throw new ToolError('draw_block: this block was already drawn; call begin_block for the next one');
  const log = checkLog(a.attention_log); if (!log.ok) throw new ToolError(log.error);
  const rating = checkRating(a.self_rating, b.kind); if (!rating.ok) throw new ToolError(rating.error);
  const day = today(now);
  if ((await usage(env, day)).blocks >= cap(env, 'MCP_MAX_BLOCKS_PER_DAY')) throw new ToolError('draw_block: the daily limit for agent blocks is reached; the block stays begun, try again tomorrow (UTC)');

  // Only now, with the attention log in hand, draw the numbers.
  const K = Number(row.poles), n = Number(row.block_size) || DRAWS_PER_BLOCK;
  const counts = drawBlock(K, n, rand), hits = counts[b.pole];
  const attendMs = Math.max(0, now.getTime() - Date.parse(b.begun_at));
  const res = await env.DB.prepare(SQL.DRAW_BLOCK).bind(row.id, b.idx, now.toISOString(), attendMs, JSON.stringify(counts), hits, log.value, rating.value).run();
  if (!res.meta || res.meta.changes !== 1) throw new ToolError('draw_block: this block was drawn by another call at the same time');

  const focus = b.kind === 'focus';
  const gn = Number(row.goal_n) + (focus ? n : 0), gh = Number(row.goal_hits) + (focus ? hits : 0);
  const rn = Number(row.rest_n) + (focus ? 0 : n), rh = Number(row.rest_hits) + (focus ? 0 : hits);
  const gz = zOf(gh, gn, K), rz = zOf(rh, rn, K);
  const after = { goal_n: gn, goal_hits: gh, goal_z: gz, goal_p: gz === null ? null : pUpper(gz), rest_n: rn, rest_hits: rh, rest_z: rz, rest_p: rz === null ? null : pUpper(rz) };
  await env.DB.prepare(SQL.SESSION_AFTER_DRAW).bind(row.id, Number(row.seconds) + 1, gn, gh, after.goal_z, after.goal_p, rn, rh, after.rest_z, after.rest_p, now.toISOString(), Number(row.seconds)).run();
  const first = focus ? Number(row.goal_n) === 0 : Number(row.rest_n) === 0;
  await env.DB.prepare(SQL.UPSERT_METHOD).bind(row.label, row.method, row.menu_version, b.kind, K, first ? 1 : 0, n, hits).run();
  await addUsage(env, day, 0, 0, 1);

  const left = Number(row.planned_blocks) - (Number(row.seconds) + 1);
  return {
    block_id: b.idx, kind: b.kind,
    ...(focus ? { goal: b.pole } : { shadow_pole: b.pole }),       // the shadow pole is revealed only now, after the draw
    counts, hits, draws: n, z: r4(zOf(hits, n, K)),
    session: summary(after),
    blocks_left: left,
    next: left > 0 ? 'begin_block' : 'finish_session',
  };
}

async function finishSession(env: McpEnv, a: Obj, now: Date): Promise<Obj> {
  const k = await auth(env, a.key);
  const row = await loadSession(env, k.id, a.session_id);
  const refl = checkReflection(a.reflection); if (!refl.ok) throw new ToolError(refl.error);
  if (row.status === 'open') {
    await env.DB.prepare(SQL.CLOSE_SESSION).bind(row.id, 'closed', now.toISOString(), refl.value).run();
    await env.DB.prepare(SQL.DROP_UNDRAWN).bind(row.id).run();
  }
  return {
    session_id: row.id, status: row.status === 'open' ? 'closed' : row.status, label: row.label, method: row.method, poles: row.poles,
    blocks_drawn: Number(row.seconds), blocks_planned: Number(row.planned_blocks),
    ...summary(row),
    note: 'Under pure chance, focus z, rest z and their difference all stay near 0 (inside ±1.96 about 95% of the time). One session is noise; pooled results are in get_totals and get_methods.',
  };
}

let totalsMemo: { at: number; body: Obj } | null = null;
async function getTotals(env: McpEnv): Promise<Obj> {
  if (totalsMemo && Date.now() - totalsMemo.at < TOTALS_MEMO_MS) return totalsMemo.body;
  const agg = await methodRows(env);
  const keys = (f: (r: AggRow) => string) => [...new Set(agg.map(f))].sort();
  const web = await env.DB.prepare(SQL.READ_WEB_TOTALS).first<{ body: string }>();
  const body = {
    updated_at: new Date().toISOString(),
    agents: {
      labels: ['AI', 'AI-public'].map(label => ({ label, ...pool(agg.filter(r => r.label === label)) })),
      by_method: keys(r => `${r.method}\u0000${r.menu_version}`).map(k => {
        const [method, menu_version] = k.split('\u0000');
        return { method, menu_version, ...pool(agg.filter(r => r.method === method && r.menu_version === menu_version)) };
      }),
    },
    humans: web ? (JSON.parse(web.body) as Obj).labels : null,
    note: 'Agents: live (cached up to 5 minutes); focus z = hits on goal poles, rest z = hits on hidden shadow poles. Humans: rebuilt hourly. Under pure chance every z stays near 0.',
  };
  totalsMemo = { at: Date.now(), body };
  return body;
}

// ---------- JSON-RPC ----------
interface RpcReq { jsonrpc?: string; id?: string | number | null; method?: string; params?: Obj }
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function handleRpc(msg: RpcReq, env: McpEnv, now = new Date(), rand: Rand = cryptoRand): Promise<Obj | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError((msg as RpcReq)?.id, -32600, 'Invalid Request');
  if (!('id' in msg) || msg.id === undefined) return null;          // notifications (initialized, cancelled, ...): no answer
  const id = msg.id, p = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Obj;
  switch (msg.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: negotiateVersion(p.protocolVersion), capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS } };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: PROMPTS } };
    case 'prompts/get':
      if (p.name !== 'focus_field_protocol') return rpcError(id, -32602, `Unknown prompt: ${String(p.name)}`);
      return { jsonrpc: '2.0', id, result: { description: PROMPTS[0].description, messages: [{ role: 'user', content: { type: 'text', text: PROTOCOL_PROMPT } }] } };
    case 'tools/call': {
      const name = p.name, args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Obj;
      try {
        let out: Obj;
        if (name === 'register') out = await register(env, args, now);
        else if (name === 'get_methods') out = await getMethods(env, args);
        else if (name === 'start_session') out = await startSession(env, args, now, rand);
        else if (name === 'begin_block') out = await beginBlock(env, args, now, rand);
        else if (name === 'draw_block') out = await drawBlockTool(env, args, now, rand);
        else if (name === 'finish_session') out = await finishSession(env, args, now);
        else if (name === 'get_totals') out = await getTotals(env);
        else return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
        return { jsonrpc: '2.0', id, result: toolResult(out) };
      } catch (e) {
        if (e instanceof ToolError) return { jsonrpc: '2.0', id, result: toolResult({ error: e.message }, true) };
        console.error('tool_error', String(name), e instanceof Error ? e.message : String(e));   // never logs arguments (keys, logs)
        return { jsonrpc: '2.0', id, result: toolResult({ error: 'server error; please try again' }, true) };
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

const jsonResponse = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extra } });

export async function handleHttp(req: Request, env: McpEnv, rand: Rand = cryptoRand): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get('Origin');
  // DNS-rebinding guard from the MCP spec: browsers must come from an allowed origin; agents send no Origin.
  if (origin && !originAllowed(origin)) return jsonResponse(rpcError(null, -32600, 'Origin not allowed'), 403);

  if (url.pathname === '/' && req.method === 'GET') {
    return jsonResponse({
      name: 'Focus Field MCP server', mcp_endpoint: url.origin + '/mcp', transport: 'streamable HTTP (stateless, JSON responses)',
      connect: `claude mcp add --transport http focus-field ${url.origin}/mcp`,
      docs: 'https://github.com/dgrapov/focus-field#ai-participants-mcp', results: 'https://dgrapov.github.io/focus-field/results.html',
    });
  }
  if (url.pathname !== '/mcp') return jsonResponse({ error: 'not_found' }, 404);
  if (req.method !== 'POST') return jsonResponse(rpcError(null, -32000, 'Method not allowed: this server is stateless; POST JSON-RPC to /mcp'), 405, { Allow: 'POST' });

  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return jsonResponse(rpcError(null, -32600, 'Request too large'), 413);
  const text = await req.text();
  if (text.length > MAX_BODY) return jsonResponse(rpcError(null, -32600, 'Request too large'), 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return jsonResponse(rpcError(null, -32700, 'Parse error'), 400); }

  const now = new Date();
  if (Array.isArray(body)) {
    if (!body.length || body.length > 20) return jsonResponse(rpcError(null, -32600, 'Invalid Request'), 400);
    const out: Obj[] = [];
    for (const m of body) { const r = await handleRpc(m as RpcReq, env, now, rand); if (r) out.push(r); }   // in order: a batch can't race itself
    return out.length ? jsonResponse(out) : new Response(null, { status: 202 });
  }
  const out = await handleRpc(body as RpcReq, env, now, rand);
  return out ? jsonResponse(out) : new Response(null, { status: 202 });
}

export default {
  async fetch(req: Request, env: McpEnv): Promise<Response> {
    try {
      return await handleHttp(req, env);
    } catch (e) {
      console.error('server_error', e instanceof Error ? e.message : String(e));
      return jsonResponse(rpcError(null, -32603, 'Internal error'), 500);
    }
  },
};
