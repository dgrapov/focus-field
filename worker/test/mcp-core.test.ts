import { describe, it, expect } from 'vitest';
import {
  drawBlock, shuffleSchedule, uniform, zOf, diffZ, labelFor, newKey, hashKey, KEY_RE, checkStart, checkLog, checkRating,
  checkReflection, checkAgent, checkSessionId, checkBlockId, negotiateVersion, TOOLS, PROMPTS, PROTOCOL_PROMPT, DRAWS_PER_BLOCK, type Rand,
} from '../src/mcp-core';
import { chiSquareSf } from '../src/stats';

const IDS = ['intent', 'sustain', 'visualize', 'mantra', 'feel', 'stillness', 'custom'];
function bytes(seed: number): Rand {
  let x = seed >>> 0;
  return buf => { for (let i = 0; i < buf.length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; buf[i] = x >>> 24; } return buf; };
}

describe('drawBlock', () => {
  it('returns K counts summing to 1,000 draws', () => {
    expect(DRAWS_PER_BLOCK).toBe(1000);
    for (const K of [2, 3, 5, 8]) {
      const c = drawBlock(K);
      expect(c).toHaveLength(K);
      expect(c.reduce((a, b) => a + b, 0)).toBe(1000);
    }
  });

  it('is uniform for every K (chi-square over 1,000 blocks, crypto source)', () => {
    for (const K of [2, 3, 5, 7, 8]) {
      const tot = new Array(K).fill(0);
      for (let i = 0; i < 1000; i++) drawBlock(K).forEach((v, k) => (tot[k] += v));
      const n = 1000 * DRAWS_PER_BLOCK, e = n / K;
      expect(chiSquareSf(tot.reduce((a, o) => a + (o - e) ** 2 / e, 0), K - 1)).toBeGreaterThan(1e-4);
    }
  });

  it('rejects bytes that would bias the result (K = 3: byte 255 is never used)', () => {
    let flip = 0;
    const src: Rand = buf => { for (let i = 0; i < buf.length; i++) buf[i] = flip++ % 2 ? 1 : 255; return buf; };
    expect(drawBlock(3, 100, src)).toEqual([0, 100, 0]);
  });

  it('draws a block of 1,000 in well under 10 ms', () => {
    const t = performance.now();
    for (let i = 0; i < 100; i++) drawBlock(8);
    expect((performance.now() - t) / 100).toBeLessThan(2);
  });
});

describe('schedule and poles', () => {
  it('has exactly half rest blocks in a varying order', () => {
    const orders = new Set<string>();
    for (let seed = 1; seed < 300; seed++) {
      const s = shuffleSchedule(20, bytes(seed));
      expect(s.filter(k => k === 'rest')).toHaveLength(10);
      orders.add(s.join(','));
    }
    expect(orders.size).toBeGreaterThan(250);
  });

  it('puts focus at each position about half the time', () => {
    const atFirst = Array.from({ length: 2000 }, () => shuffleSchedule(10)[0] === 'focus').filter(Boolean).length;
    expect(atFirst).toBeGreaterThan(880); expect(atFirst).toBeLessThan(1120);
  });

  it('picks every pole uniformly', () => {
    const c = new Array(5).fill(0);
    for (let i = 0; i < 5000; i++) c[uniform(5)]++;
    expect(chiSquareSf(c.reduce((a, o) => a + (o - 1000) ** 2 / 1000, 0), 4)).toBeGreaterThan(1e-4);
  });
});

describe('scoring', () => {
  it('computes z against 1/K and the focus − rest difference', () => {
    expect(zOf(550, 1000, 2)).toBeCloseTo(50 / Math.sqrt(250), 10);
    expect(zOf(0, 0, 2)).toBeNull();
    expect(diffZ(2, 0).z).toBeCloseTo(Math.SQRT2, 10);
    expect(diffZ(1, 1)).toEqual({ z: 0, p: expect.closeTo(0.5, 6) });
    expect(diffZ(null, 1)).toEqual({ z: null, p: null });
  });

  it('labels trusted keys AI and the rest AI-public', () => {
    expect(labelFor(true)).toBe('AI');
    expect(labelFor(false)).toBe('AI-public');
  });

  it('makes well-formed keys and stable hashes', async () => {
    const { key, id } = newKey();
    expect(key).toMatch(KEY_RE); expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(await hashKey(key)).toBe(await hashKey(key));
    expect(newKey().key).not.toBe(key);
  });
});

describe('argument checks', () => {
  it('fills defaults: 2 poles, 20 blocks', () => {
    expect(checkStart({ method: 'intent' }, IDS)).toEqual({ ok: true, value: { poles: 2, blocks: 20, method: 'intent', custom: null } });
  });

  it.each([
    [{ poles: 1 }], [{ poles: 9 }], [{ blocks: 8 }], [{ blocks: 102 }], [{ blocks: 21 }], [{ method: 'pray' }], [{ method: 'custom' }],
    [{ method: 'custom', custom_description: 'x'.repeat(501) }],
  ])('rejects %j', over => expect(checkStart({ method: 'intent', ...over }, IDS).ok).toBe(false));

  it('takes a custom method with its description', () => {
    expect(checkStart({ method: 'custom', custom_description: ' breathe, then picture it ' }, IDS)).toEqual({ ok: true, value: { poles: 2, blocks: 20, method: 'custom', custom: 'breathe, then picture it' } });
  });

  it('requires an attention log of 1–2,000 characters, keeping newlines and dropping control characters', () => {
    expect(checkLog('').ok).toBe(false);
    expect(checkLog('   ').ok).toBe(false);
    expect(checkLog('x'.repeat(2001)).ok).toBe(false);
    expect(checkLog('line 1\nline 2\u0007')).toEqual({ ok: true, value: 'line 1\nline 2' });
  });

  it('requires a 1–5 self rating on focus blocks only', () => {
    expect(checkRating(undefined, 'focus').ok).toBe(false);
    expect(checkRating(undefined, 'rest')).toEqual({ ok: true, value: null });
    expect(checkRating(5, 'focus')).toEqual({ ok: true, value: 5 });
    expect(checkRating(6, 'rest').ok).toBe(false);
    expect(checkRating(2.5, 'focus').ok).toBe(false);
  });

  it('checks reflections, agents, session and block ids', () => {
    expect(checkReflection(undefined)).toEqual({ ok: true, value: null });
    expect(checkReflection('x'.repeat(2001)).ok).toBe(false);
    expect(checkAgent('claude-sonnet-5-5').ok).toBe(true);
    expect(checkAgent('a\nb').ok).toBe(false);
    expect(checkSessionId(crypto.randomUUID()).ok).toBe(true);
    expect(checkSessionId("x' OR 1=1").ok).toBe(false);
    expect(checkBlockId(1).ok).toBe(true);
    expect(checkBlockId(0).ok).toBe(false);
    expect(checkBlockId('1').ok).toBe(false);
  });
});

describe('MCP surface', () => {
  it('negotiates the protocol version', () => {
    expect(negotiateVersion('2025-06-18')).toBe('2025-06-18');
    expect(negotiateVersion('1999-01-01')).toBe('2025-11-25');
  });

  it('lists the protocol tools in flow order, with object schemas', () => {
    expect(TOOLS.map(t => t.name)).toEqual(['register', 'get_methods', 'start_session', 'begin_block', 'draw_block', 'finish_session', 'get_totals']);
    for (const t of TOOLS) expect(t.inputSchema.type).toBe('object');
    const draw = TOOLS.find(t => t.name === 'draw_block')!;
    expect(draw.inputSchema.required).toEqual(['key', 'session_id', 'block_id', 'attention_log']);
  });

  it('offers the protocol as a prompt', () => {
    expect(PROMPTS.map(p => p.name)).toEqual(['focus_field_protocol']);
    expect(PROTOCOL_PROMPT).toContain("don't try to predict or compute the numbers");
  });
});
