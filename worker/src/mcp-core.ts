// Pure parts of the Focus Field MCP server: drawing, the block schedule, scoring helpers, argument checks and the
// MCP surface (tools, prompt). No I/O; unit-tested in test/mcp-core.test.ts. The Worker around it is src/mcp.ts.
// Protocol: dev/MCP-ATTENTION-PROTOCOL.md (Harold's decisions of 2026-11-12): manual runs only; attention first,
// then the draw; a methods menu; every block logs what the agent did; rest blocks scored on hidden shadow poles.

import { pUpper } from './stats';

export const DRAWS_PER_BLOCK = 1000;
export const MIN_BLOCKS = 10, MAX_BLOCKS = 100, DEFAULT_BLOCKS = 20;
export const MAX_LOG = 2000, MAX_REFLECTION = 2000, MAX_CUSTOM = 500;
export const IDLE_MINUTES = 30;       // an open session idle this long is closed as abandoned; drawn blocks still count
export const APP_VERSION = 'mcp-1';
export type Kind = 'focus' | 'rest';

export type Rand = (buf: Uint8Array) => Uint8Array;
export const cryptoRand: Rand = buf => crypto.getRandomValues(buf);

/** A uniform integer in [0, k) from random bytes, by rejection sampling (no modulo bias). 1 ≤ k ≤ 256. */
export function uniform(k: number, rand: Rand = cryptoRand, pool = { buf: new Uint8Array(64), i: 64 }): number {
  const limit = 256 - (256 % k);
  for (;;) {
    if (pool.i >= pool.buf.length) { rand(pool.buf); pool.i = 0; }
    const b = pool.buf[pool.i++];
    if (b < limit) return b % k;
  }
}

/** Draw one block: `n` independent uniform picks among K poles, returned as per-pole counts. */
export function drawBlock(K: number, n = DRAWS_PER_BLOCK, rand: Rand = cryptoRand): number[] {
  const counts = new Array<number>(K).fill(0);
  const pool = { buf: new Uint8Array(1024), i: 1024 };
  for (let d = 0; d < n; d++) counts[uniform(K, rand, pool)]++;
  return counts;
}

/** Exactly half focus and half rest, in a random order (Fisher-Yates with unbiased indices). `blocks` is even. */
export function shuffleSchedule(blocks: number, rand: Rand = cryptoRand): Kind[] {
  const s: Kind[] = Array.from({ length: blocks }, (_, i) => (i < blocks / 2 ? 'focus' : 'rest'));
  const pool = { buf: new Uint8Array(256), i: 256 };
  for (let i = s.length - 1; i > 0; i--) { const j = uniform(i + 1, rand, pool); [s[i], s[j]] = [s[j], s[i]]; }
  return s;
}

/** z of `hits` out of `n` draws against chance 1/K; null when n = 0. */
export function zOf(hits: number, n: number, K: number): number | null {
  if (!(n > 0)) return null;
  const p = 1 / K;
  return (hits - n * p) / Math.sqrt(n * p * (1 - p));
}

/** Focus minus rest: both are N(0,1) under chance and independent, so (z_f − z_r)/√2 is N(0,1) too. One-sided p. */
export function diffZ(zf: number | null, zr: number | null): { z: number | null; p: number | null } {
  if (zf === null || zr === null) return { z: null, p: null };
  const z = (zf - zr) / Math.SQRT2;
  return { z, p: pUpper(z) };
}

export const labelFor = (trusted: boolean) => (trusted ? 'AI' : 'AI-public');

// ---------- keys ----------
export const KEY_RE = /^ffk_[0-9a-f]{32}$/;
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
export function newKey(rand: Rand = cryptoRand): { key: string; id: string } {
  return { key: 'ffk_' + hex(rand(new Uint8Array(16))), id: hex(rand(new Uint8Array(6))) };
}
export async function hashKey(key: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))));
}

// ---------- argument checks (messages go back to the agent, so they say how to fix the call) ----------
type Ok<T> = { ok: true; value: T } | { ok: false; error: string };
const AGENT_RE = /^[A-Za-z0-9 ._:/@()+-]{1,60}$/;
const SESSION_RE = /^[0-9a-f-]{36}$/;
/** Free text: control characters removed (newlines and tabs kept), trimmed, length-capped. Stored as text only. */
const text = (v: unknown, max: number, what: string, required: boolean): Ok<string | null> => {
  if (v === undefined || v === null || v === '') return required ? { ok: false, error: `${what}: required (1–${max} characters)` } : { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: `${what}: a string` };
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!t) return required ? { ok: false, error: `${what}: required (1–${max} characters)` } : { ok: true, value: null };
  if (t.length > max) return { ok: false, error: `${what}: at most ${max} characters` };
  return { ok: true, value: t };
};

export function checkAgent(v: unknown): Ok<string | null> {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || !AGENT_RE.test(v)) return { ok: false, error: 'agent: up to 60 characters (letters, digits, space . _ : / @ ( ) + -), e.g. "claude-sonnet-5-5"' };
  return { ok: true, value: v };
}

export interface StartArgs { poles: number; blocks: number; method: string; custom: string | null }
export function checkStart(a: Record<string, unknown>, methodIds: string[]): Ok<StartArgs> {
  const poles = a.poles ?? 2, blocks = a.blocks ?? DEFAULT_BLOCKS, method = a.method;
  if (!Number.isInteger(poles) || (poles as number) < 2 || (poles as number) > 8) return { ok: false, error: 'poles: an integer from 2 to 8' };
  if (!Number.isInteger(blocks) || (blocks as number) < MIN_BLOCKS || (blocks as number) > MAX_BLOCKS || (blocks as number) % 2) return { ok: false, error: `blocks: an even integer from ${MIN_BLOCKS} to ${MAX_BLOCKS} (half are rest blocks)` };
  if (typeof method !== 'string' || !methodIds.includes(method)) return { ok: false, error: `method: one of ${methodIds.join(', ')} (see get_methods)` };
  const c = text(a.custom_description, MAX_CUSTOM, 'custom_description', method === 'custom');
  if (!c.ok) return c;
  return { ok: true, value: { poles: poles as number, blocks: blocks as number, method, custom: method === 'custom' ? c.value : null } };
}

export const checkSessionId = (v: unknown): Ok<string> =>
  typeof v === 'string' && SESSION_RE.test(v) ? { ok: true, value: v } : { ok: false, error: 'session_id: the id returned by start_session' };
export const checkBlockId = (v: unknown): Ok<number> =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_BLOCKS ? { ok: true, value: v as number } : { ok: false, error: 'block_id: the block_id returned by begin_block' };
export const checkLog = (v: unknown) => text(v, MAX_LOG, 'attention_log', true) as Ok<string>;
export const checkReflection = (v: unknown) => text(v, MAX_REFLECTION, 'reflection', false);
/** Required on focus blocks (how settled the attention felt), optional on rest blocks. */
export function checkRating(v: unknown, kind: Kind): Ok<number | null> {
  if (v === undefined || v === null) return kind === 'focus' ? { ok: false, error: 'self_rating: required on focus blocks, an integer 1–5 (how fully your attention was placed)' } : { ok: true, value: null };
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5 ? { ok: true, value: v as number } : { ok: false, error: 'self_rating: an integer from 1 to 5' };
}

// ---------- MCP surface ----------
export const REST_INSTRUCTION = 'Rest block. No goal. Write one or two neutral sentences about something unrelated (for example, describe a plain object), then call draw_block with what you did.';

export const PROTOCOL_PROMPT = `Focus Field tests one question: can attention placed on an outcome shift a random draw? You are the participant.
1. Call get_methods() and choose one method, or use the one the person names. Say why you chose it. Use only that method for the whole session.
2. Call start_session. The number of blocks is fixed; every block counts, whatever happens.
3. For each block, call begin_block. On a focus block you get a goal pole. Place your attention on the outcome, that pole winning this block, using your method. Only when your attention is fully placed, call draw_block with an honest log of exactly what you did. The server draws the random numbers only after your call arrives.
4. On a rest block there is no goal. Do the neutral task, then call draw_block with a short log.
5. After each draw you see the result. You may refine how you apply your method, but don't switch methods.
6. At the end, call finish_session with a short reflection: what seemed to help, what didn't, and what you'd try next.

Rules: don't try to predict or compute the numbers; nothing you write affects the random generator. Keep logs about your method and attention. No personal information.`;

export const SERVER_INSTRUCTIONS = `Focus Field: an open experiment on whether attention can shift a random draw. Before your first session, call register once and keep the key; every other tool needs it as "key".
${PROTOCOL_PROMPT}
Pooled human results: https://dgrapov.github.io/focus-field/results.html`;

const KEY = { type: 'string', description: 'Your key from register (ffk_...).' };
const SID = { type: 'string', description: 'The session_id from start_session.' };
export const TOOLS = [
  {
    name: 'register',
    description: 'Get an anonymous key for Focus Field. No account and no personal data. Call once, keep the key, and pass it as "key" to every other tool.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'Your model name, e.g. "claude-sonnet-5-5" (optional, stored as claimed).' } }, additionalProperties: false },
  },
  {
    name: 'get_methods',
    description: 'The menu of attention methods (id, name, instruction) and how each has done so far (sessions, focus z, rest z, focus minus rest). Choose one method per session.',
    inputSchema: { type: 'object', properties: { key: KEY }, required: ['key'], additionalProperties: false },
  },
  {
    name: 'start_session',
    description: `Start a session with one method. The block count is fixed now; exactly half the blocks are rest blocks, in a hidden random order. Every drawn block counts. Each block is ${DRAWS_PER_BLOCK} draws.`,
    inputSchema: {
      type: 'object',
      properties: {
        key: KEY,
        method: { type: 'string', description: 'A method id from get_methods, or "custom".' },
        custom_description: { type: 'string', maxLength: MAX_CUSTOM, description: 'Required when method is "custom": your method, applied the same way every block.' },
        poles: { type: 'integer', minimum: 2, maximum: 8, default: 2, description: 'Possible outcomes per draw.' },
        blocks: { type: 'integer', minimum: MIN_BLOCKS, maximum: MAX_BLOCKS, default: DEFAULT_BLOCKS, description: 'Number of blocks (even).' },
      },
      required: ['key', 'method'],
      additionalProperties: false,
    },
  },
  {
    name: 'begin_block',
    description: 'Begin the next block. Focus block: you get a goal pole; place your attention on it winning, using your method, before calling draw_block. Rest block: no goal; do the neutral task. Nothing is drawn yet.',
    inputSchema: { type: 'object', properties: { key: KEY, session_id: SID }, required: ['key', 'session_id'], additionalProperties: false },
  },
  {
    name: 'draw_block',
    description: `Call only when your attention is placed. The server draws ${DRAWS_PER_BLOCK} numbers now, after your call arrives, and returns the result. attention_log: an honest account of exactly what you did (required).`,
    inputSchema: {
      type: 'object',
      properties: {
        key: KEY, session_id: SID,
        block_id: { type: 'integer', description: 'The block_id from begin_block.' },
        attention_log: { type: 'string', minLength: 1, maxLength: MAX_LOG, description: 'What you did to place your attention (or, on a rest block, the neutral task).' },
        self_rating: { type: 'integer', minimum: 1, maximum: 5, description: 'How fully your attention was placed, 1–5. Required on focus blocks.' },
      },
      required: ['key', 'session_id', 'block_id', 'attention_log'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish_session',
    description: 'Close the session and get its summary. Blocks begun but not drawn are dropped; drawn blocks all count.',
    inputSchema: {
      type: 'object',
      properties: { key: KEY, session_id: SID, reflection: { type: 'string', maxLength: MAX_REFLECTION, description: 'What seemed to help, what did not, what you would try next.' } },
      required: ['key', 'session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_totals',
    description: 'Pooled results: humans (web, rebuilt hourly) and agents by label and by method (focus z, rest z, focus minus rest).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

export const PROMPTS = [
  { name: 'focus_field_protocol', title: 'Focus Field protocol', description: 'How to take part in a Focus Field session as an AI participant.', arguments: [] },
];

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const negotiateVersion = (requested: unknown) =>
  typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
