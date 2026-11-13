// The MCP Worker end to end over real SQLite (node:sqlite): the migration from the live schema, the attention protocol
// (begin -> attend -> draw), scoring on goal and shadow poles, caps, idle closing, concurrency, and that agent sessions
// never reach the human summary tables or leaderboards.
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleHttp, handleRpc, type D1Database, type McpEnv } from '../src/mcp';
import * as WEB from '../src/sql';
import { sessionStats } from '../src/stats';
import { zOf } from '../src/mcp-core';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const phase1 = read('./fixtures/schema-3acfde9.sql');
const migration = read('../migrations/0002-agents.sql');
const schema = read('../schema.sql');
const summarySql = read('../migrate-summary.sql');

function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const st = () => db.prepare(sql);
      const p = {
        bind(...v: unknown[]) { params = v; return p; },
        async run() { const r = st().run(...(params as never[])); return { meta: { changes: Number(r.changes) } }; },
        async all<T>() { return { results: st().all(...(params as never[])) as T[] }; },
        async first<T>() { return ((st().get(...(params as never[])) as T) ?? null); },
      };
      return p;
    },
  };
}

let db: DatabaseSync, env: McpEnv, n = 0;
const call = async (name: string, args: Record<string, unknown> = {}, e = env, now?: Date) => {
  const r = await handleRpc({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }, e, now);
  const res = (r as { result: { structuredContent: Record<string, any>; isError?: boolean } }).result;
  return { ...res.structuredContent, isError: !!res.isError } as Record<string, any>;
};
const post = (body: unknown, headers: Record<string, string> = {}) =>
  handleHttp(new Request('https://mcp.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env);
const q = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as any;

function webSession(label: string, pid: string) {
  const counts = Array.from({ length: 80 }, () => [260, 240]), marks = counts.map(() => 0);
  const st = sessionStats(2, counts, marks);
  db.prepare(WEB.INSERT_SESSION).run(crypto.randomUUID(), '2026-11-12T10:00:00.000Z', pid, label, 2, 80, 25, '1.1.0', JSON.stringify(counts), JSON.stringify(marks), st.goal_n, st.goal_hits, st.goal_z, st.goal_p, null, null, '[]');
  db.prepare(WEB.UPSERT_ID_POLES).run(label, pid, 2, st.goal_n, st.goal_hits);
  db.prepare(WEB.UPSERT_DAY).run(label, '2026-11-12', 2, st.goal_n, st.goal_hits, 80);
}

/** Run one block the way an agent should: begin, then draw with a log (and a rating on focus blocks). */
async function block(key: string, sid: string, e = env, now?: Date) {
  const b = await call('begin_block', { key, session_id: sid }, e, now);
  if (b.isError) return { begin: b, draw: null };
  const d = await call('draw_block', { key, session_id: sid, block_id: b.block_id, attention_log: b.kind === 'focus' ? `held pole ${b.goal} winning` : 'described a grey mug', ...(b.kind === 'focus' ? { self_rating: 4 } : {}) }, e, now);
  return { begin: b, draw: d };
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(phase1);
  webSession('Human', 'web-aaaaaaaa');
  db.exec(migration);
  env = { DB: d1(db) };
});

describe('migration 0002', () => {
  it('keeps every web row, marks it web/closed and leaves the summaries alone', () => {
    expect(db.prepare(`SELECT label, source, status, goal_n FROM sessions`).all()).toEqual([{ label: 'Human', source: 'web', status: 'closed', goal_n: 40000 }]);
    expect(q('SELECT COUNT(*) AS c FROM agg_day').c).toBe(1);
  });

  it('gives the same tables as a fresh schema.sql, with the methods menu v1', () => {
    const fresh = new DatabaseSync(':memory:'); fresh.exec(schema);
    const cols = (d: DatabaseSync, t: string) => (d.prepare(`PRAGMA table_info(${t})`).all() as any[]).map(c => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`);
    for (const t of ['sessions', 'agent_keys', 'mcp_blocks', 'mcp_methods', 'agg_method', 'mcp_usage', 'agg_day', 'agg_id_poles', 'agg_runs', 'snapshots']) expect(cols(db, t)).toEqual(cols(fresh, t));
    expect((db.prepare('SELECT id FROM mcp_methods ORDER BY sort').all() as any[]).map(r => r.id)).toEqual(['intent', 'sustain', 'visualize', 'mantra', 'feel', 'stillness', 'custom']);
    expect(q("SELECT DISTINCT menu_version AS v FROM mcp_methods").v).toBe('2026-11-12.1');
    expect(q("SELECT instruction FROM mcp_methods WHERE id = 'mantra'").instruction).toContain("goal pole's name 21 times");
  });

  it('accepts agent labels and still rejects unknown ones', () => {
    const ins = (l: string) => () => db.prepare(`INSERT INTO sessions (id, received_at, participant_id, label, poles, seconds, per_second_counts, focus_marks) VALUES (?, 't', 'p', ?, 2, 0, '[]', '[]')`).run(l, l);
    expect(ins('AI-public')).not.toThrow();
    expect(ins('AI')).not.toThrow();
    expect(ins('Robot')).toThrow();
  });
});

describe('protocol', () => {
  it('initializes with tools and prompts, lists both, answers ping and batches', async () => {
    let r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const j = await r.json() as any;
    expect(j.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {} } });
    expect(j.result.instructions).toContain('begin_block');
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect(((await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as any).result.tools).toHaveLength(7);
    const pr = ((await (await post({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'focus_field_protocol' } })).json()) as any).result;
    expect(pr.messages[0].content.text).toContain('Call get_methods()');
    expect(await (await post([{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])).json()).toEqual([{ jsonrpc: '2.0', id: 4, result: {} }]);
  });

  it('returns JSON-RPC errors for bad input', async () => {
    expect(((await (await handleHttp(new Request('https://mcp.test/mcp', { method: 'POST', body: '{nope' }), env)).json()) as any).error.code).toBe(-32700);
    expect(((await (await post({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).json()) as any).error.code).toBe(-32601);
    expect(((await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } })).json()) as any).error.code).toBe(-32602);
    expect(((await (await post({ id: 1, method: 'ping' })).json()) as any).error.code).toBe(-32600);
  });

  it('refuses other browser origins, GET on /mcp and oversized bodies', async () => {
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://localhost:6274' })).status).toBe(200);
    expect((await handleHttp(new Request('https://mcp.test/mcp'), env)).status).toBe(405);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70_000) } })).status).toBe(413);
    const info = await (await handleHttp(new Request('https://mcp.test/'), env)).json() as any;
    expect(info.connect).toBe('claude mcp add --transport http focus-field https://mcp.test/mcp');
  });
});

describe('a whole session', () => {
  it('runs get_methods → start → begin/draw ×20 → finish, scoring goal and shadow poles', async () => {
    const reg = await call('register', { agent: 'claude-test' });
    expect(reg.key).toMatch(/^ffk_[0-9a-f]{32}$/);
    expect(q('SELECT key_hash, agent, trusted FROM agent_keys')).toMatchObject({ agent: 'claude-test', trusted: 0 });
    expect(q('SELECT key_hash FROM agent_keys').key_hash).not.toContain(reg.key.slice(4));

    const m = await call('get_methods', { key: reg.key });
    expect(m.menu_version).toBe('2026-11-12.1');
    expect(m.methods).toHaveLength(7);
    expect(m.methods[0]).toMatchObject({ id: 'intent', name: 'Clear intention', results: { sessions: 0 } });

    const s = await call('start_session', { key: reg.key, method: 'visualize', poles: 3 });
    expect(s).toMatchObject({ label: 'AI-public', blocks: 20, draws_per_block: 1000, method: 'visualize', menu_version: '2026-11-12.1', isError: false });
    expect(JSON.stringify(s)).not.toMatch(/rest","focus|schedule/);              // the schedule is never sent

    const kinds: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const { begin, draw } = await block(reg.key, s.session_id);
      expect(begin).toMatchObject({ block_id: i, of: 20 });
      kinds.push(begin.kind);
      if (begin.kind === 'focus') {
        expect(begin.goal).toBeGreaterThanOrEqual(0); expect(begin.goal).toBeLessThan(3);
        expect(begin.instruction).toContain('Visualisation');
        expect(draw!.goal).toBe(begin.goal);
      } else {
        expect(begin.goal).toBeUndefined();                                        // no shadow pole before the draw
        expect(JSON.stringify(begin)).not.toMatch(/shadow|pole \d/);
        expect(begin.instruction).toMatch(/^Rest block/);
        expect(draw!.shadow_pole).toBeGreaterThanOrEqual(0);                      // revealed after the draw
      }
      expect(draw!.counts.reduce((a: number, b: number) => a + b, 0)).toBe(1000);
      expect(draw!.blocks_left).toBe(20 - i);
    }
    expect(kinds.filter(k => k === 'rest')).toHaveLength(10);
    expect((await call('begin_block', { key: reg.key, session_id: s.session_id })).error).toContain('finish_session');

    // Stored blocks: logs, ratings, timings; session sums = sums of the blocks
    const blocks = db.prepare('SELECT * FROM mcp_blocks WHERE session_id = ? ORDER BY idx').all(s.session_id) as any[];
    expect(blocks).toHaveLength(20);
    for (const b of blocks) {
      expect(b.hits).toBe(JSON.parse(b.counts)[b.pole]);
      expect(b.attention_log).toBeTruthy();
      expect(b.attend_ms).toBeGreaterThanOrEqual(0);
      expect(b.self_rating).toBe(b.kind === 'focus' ? 4 : null);
    }
    const sum = (k: string, f: string) => blocks.filter(b => b.kind === k).reduce((a, b) => a + b[f], 0);
    const row = q('SELECT * FROM sessions WHERE id = ?', s.session_id);
    expect(row).toMatchObject({ source: 'mcp', status: 'open', seconds: 20, goal_n: 10000, rest_n: 10000, goal_hits: sum('focus', 'hits'), rest_hits: sum('rest', 'hits'), agent: 'claude-test' });
    expect(row.goal_z).toBeCloseTo(zOf(row.goal_hits, 10000, 3)!, 10);
    expect(row.rest_z).toBeCloseTo(zOf(row.rest_hits, 10000, 3)!, 10);

    const f = await call('finish_session', { key: reg.key, session_id: s.session_id, reflection: 'Vivid images felt easier than words.' });
    expect(f).toMatchObject({ status: 'closed', blocks_drawn: 20, focus: { draws: 10000 }, rest: { draws: 10000 } });
    expect(f.focus_minus_rest.z).toBeCloseTo((row.goal_z - row.rest_z) / Math.SQRT2, 3);
    expect(q('SELECT status, reflection FROM sessions WHERE id = ?', s.session_id)).toEqual({ status: 'closed', reflection: 'Vivid images felt easier than words.' });

    // Per-method summary and totals
    expect(db.prepare('SELECT kind, sessions, n FROM agg_method ORDER BY kind').all()).toEqual([{ kind: 'focus', sessions: 1, n: 10000 }, { kind: 'rest', sessions: 1, n: 10000 }]);
    const m2 = await call('get_methods', { key: reg.key });
    expect(m2.methods.find((x: any) => x.id === 'visualize').results).toMatchObject({ sessions: 1, focus: { draws: 10000 }, rest: { draws: 10000 } });
    const t = await call('get_totals');
    expect(t.agents.labels.find((l: any) => l.label === 'AI-public')).toMatchObject({ sessions: 1, focus: { draws: 10000 } });
    expect(t.agents.by_method).toEqual([expect.objectContaining({ method: 'visualize', menu_version: '2026-11-12.1', sessions: 1 })]);
    expect(t.humans).toBeNull();                                                   // no snapshot built in this test db
  });

  it('keeps agent sessions out of the human summaries and leaderboards, also after a full rebuild', async () => {
    const reg = await call('register', {});
    const s = await call('start_session', { key: reg.key, method: 'intent', blocks: 10 });
    for (let i = 0; i < 10; i++) await block(reg.key, s.session_id);
    const labels = (t: string) => (db.prepare(`SELECT DISTINCT label FROM ${t}`).all() as any[]).map(r => r.label);
    expect(labels('agg_day')).toEqual(['Human']);
    db.exec(summarySql);
    expect(labels('agg_day')).toEqual(['Human']);
    expect(labels('agg_id_poles')).toEqual(['Human']);
    expect(q(`SELECT COUNT(*) AS c FROM agg_runs WHERE pid LIKE 'key-%'`).c).toBe(0);
  });
});

describe('attention first, then the draw', () => {
  it('refuses to draw a block that was not begun, twice, or without a log or focus rating', async () => {
    const reg = await call('register', {});
    const s = await call('start_session', { key: reg.key, method: 'custom', custom_description: 'count breaths, then name the pole' });
    expect((await call('draw_block', { key: reg.key, session_id: s.session_id, block_id: 1, attention_log: 'x', self_rating: 3 })).error).toContain('not been begun');
    const b = await call('begin_block', { key: reg.key, session_id: s.session_id });
    expect((await call('draw_block', { key: reg.key, session_id: s.session_id, block_id: b.block_id })).error).toContain('attention_log');
    if (b.kind === 'focus') {
      expect(b.instruction).toContain('count breaths');
      expect((await call('draw_block', { key: reg.key, session_id: s.session_id, block_id: b.block_id, attention_log: 'x' })).error).toContain('self_rating');
    }
    expect(q('SELECT COUNT(*) AS c FROM mcp_blocks WHERE drawn_at IS NOT NULL').c).toBe(0);    // nothing drawn by refused calls
    const ok = await call('draw_block', { key: reg.key, session_id: s.session_id, block_id: b.block_id, attention_log: 'did it', self_rating: 3 });
    expect(ok.isError).toBe(false);
    expect((await call('draw_block', { key: reg.key, session_id: s.session_id, block_id: b.block_id, attention_log: 'again', self_rating: 3 })).error).toContain('already drawn');
  });

  it('returns the same open block when begin_block is called twice', async () => {
    const reg = await call('register', {});
    const s = await call('start_session', { key: reg.key, method: 'mantra' });
    const a = await call('begin_block', { key: reg.key, session_id: s.session_id });
    const b = await call('begin_block', { key: reg.key, session_id: s.session_id });
    expect(b).toMatchObject({ block_id: a.block_id, kind: a.kind, ...(a.kind === 'focus' ? { goal: a.goal } : {}), note: expect.stringContaining('already begun') });
    expect(q('SELECT COUNT(*) AS c FROM mcp_blocks').c).toBe(1);
  });

  it('records attend_ms as the time between begin and draw', async () => {
    const reg = await call('register', {});
    const t0 = new Date('2026-11-13T10:00:00.000Z');
    const s = await call('start_session', { key: reg.key, method: 'stillness' }, env, t0);
    const b = await call('begin_block', { key: reg.key, session_id: s.session_id }, env, t0);
    await call('draw_block', { key: reg.key, session_id: s.session_id, block_id: b.block_id, attention_log: 'held it', self_rating: 2 }, env, new Date(t0.getTime() + 4321));
    expect(q('SELECT attend_ms FROM mcp_blocks').attend_ms).toBe(4321);
  });

  it('finishing early drops undrawn blocks and keeps drawn ones', async () => {
    const reg = await call('register', {});
    const s = await call('start_session', { key: reg.key, method: 'feel' });
    await block(reg.key, s.session_id); await block(reg.key, s.session_id);
    await call('begin_block', { key: reg.key, session_id: s.session_id });
    const f = await call('finish_session', { key: reg.key, session_id: s.session_id });
    expect(f).toMatchObject({ status: 'closed', blocks_drawn: 2, blocks_planned: 20 });
    expect(q('SELECT COUNT(*) AS c FROM mcp_blocks').c).toBe(2);
    expect((await call('begin_block', { key: reg.key, session_id: s.session_id })).error).toContain('finished');
  });
});

describe('keys, caps, idle', () => {
  it('rejects bad, unknown and revoked keys, and other keys\' sessions', async () => {
    expect((await call('get_methods', { key: 'nope' })).error).toContain('register');
    expect((await call('get_methods', { key: 'ffk_' + '0'.repeat(32) })).error).toContain('unknown');
    const a = await call('register', {}), b = await call('register', {});
    const s = await call('start_session', { key: a.key, method: 'intent' });
    expect((await call('begin_block', { key: b.key, session_id: s.session_id })).error).toContain('no such session');
    db.prepare('UPDATE agent_keys SET revoked = 1').run();
    expect((await call('start_session', { key: a.key, method: 'intent' })).error).toContain('revoked');
  });

  it('labels a trusted key AI', async () => {
    const reg = await call('register', {});
    db.prepare('UPDATE agent_keys SET trusted = 1').run();
    expect((await call('start_session', { key: reg.key, method: 'intent' })).label).toBe('AI');
  });

  it('can close registration', async () => {
    expect((await call('register', {}, { ...env, MCP_REGISTRATION: 'closed' })).error).toContain('not being issued');
  });

  it('enforces caps: open sessions, sessions per key, keys and blocks per day', async () => {
    const reg = await call('register', {});
    for (let i = 0; i < 2; i++) expect((await call('start_session', { key: reg.key, method: 'intent' })).isError).toBe(false);
    expect((await call('start_session', { key: reg.key, method: 'intent' })).error).toContain('open session');

    const small: McpEnv = { DB: env.DB, MCP_MAX_SESSIONS_PER_KEY_PER_DAY: '1', MCP_MAX_KEYS_PER_DAY: '1', MCP_MAX_BLOCKS_PER_DAY: '1', MCP_MAX_OPEN_PER_KEY: '9' };
    expect((await call('register', {}, small)).error).toContain('daily limit');
    expect((await call('start_session', { key: reg.key, method: 'intent' }, small)).error).toContain('daily limit of 1');
    const sid = q(`SELECT id FROM sessions WHERE source = 'mcp' LIMIT 1`).id;
    expect((await block(reg.key, sid, small)).draw!.isError).toBe(false);
    expect((await block(reg.key, sid, small)).draw!.error).toContain('daily limit for agent blocks');
    expect(q('SELECT blocks FROM mcp_usage').blocks).toBe(1);
  });

  it('closes idle sessions as abandoned: drawn blocks stay, undrawn are dropped', async () => {
    const reg = await call('register', {});
    const t0 = new Date('2026-11-13T10:00:00.000Z'), later = new Date(t0.getTime() + 31 * 60_000);
    const s = await call('start_session', { key: reg.key, method: 'sustain' }, env, t0);
    await block(reg.key, s.session_id, env, t0);
    await call('begin_block', { key: reg.key, session_id: s.session_id }, env, t0);
    const r = await call('begin_block', { key: reg.key, session_id: s.session_id }, env, later);
    expect(r.error).toContain('idle');
    expect(q('SELECT status, seconds FROM sessions WHERE id = ?', s.session_id)).toEqual({ status: 'abandoned', seconds: 1 });
    expect(q('SELECT COUNT(*) AS c FROM mcp_blocks').c).toBe(1);
    expect(q("SELECT n FROM agg_method").n).toBe(1000);                            // the drawn block still counts
  });

  it('a block begun recently keeps the session open past the idle limit of the session row', async () => {
    const reg = await call('register', {});
    const t0 = new Date('2026-11-13T10:00:00.000Z');
    const s = await call('start_session', { key: reg.key, method: 'sustain' }, env, t0);
    const b = await call('begin_block', { key: reg.key, session_id: s.session_id }, env, new Date(t0.getTime() + 25 * 60_000));
    const d = await call('draw_block', { key: reg.key, session_id: s.session_id, block_id: b.block_id, attention_log: 'long attention', self_rating: 5 }, env, new Date(t0.getTime() + 45 * 60_000));
    expect(d.isError).toBe(false);
  });
});
