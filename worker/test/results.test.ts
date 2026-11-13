import { describe, it, expect } from 'vitest';
import { probit, luckLine, adjustedBestZ, overallBoard, runBoard, cumulativeByDay, tagFor, MIN_OVERALL_DRAWS, TOP_N } from '../src/results';
import { phi, stoufferFromGroups } from '../src/stats';

describe('probit', () => {
  // phi itself is accurate to ~1e-7 absolute, so compare absolutely
  for (const p of [1e-6, 0.001, 0.025, 0.2, 0.5, 0.8, 0.975, 0.999]) {
    it(`phi(probit(${p})) ≈ ${p}`, () => expect(Math.abs(phi(probit(p)) - p)).toBeLessThan(2e-7));
  }
  it('deep tail matches the known quantile', () => expect(probit(1e-10)).toBeCloseTo(-6.361341, 4));
  it('known quantiles', () => {
    expect(probit(0.975)).toBeCloseTo(1.959964, 5);
    expect(probit(0.5)).toBeCloseTo(0, 9);
  });
});

describe('luckLine', () => {
  it('is 0 for one id and grows slowly', () => {
    expect(luckLine(1)).toBe(0);
    expect(luckLine(10)).toBeCloseTo(1.54, 1);     // expected max of 10 normals ≈ 1.539
    expect(luckLine(100)).toBeCloseTo(2.51, 1);    // ≈ 2.508
    expect(luckLine(1000)).toBeGreaterThan(luckLine(100));
  });
});

describe('adjustedBestZ', () => {
  it('one run is unchanged', () => expect(adjustedBestZ(3, 1)).toBe(3));
  it('the same best run counts for less when picked from more runs', () => {
    const one = adjustedBestZ(3, 1), ten = adjustedBestZ(3, 10), hundred = adjustedBestZ(3, 100);
    expect(ten).toBeLessThan(one);
    expect(hundred).toBeLessThan(ten);
    // p = 0.00135; over 100 runs p_adj = 1 − (1 − p)^100 ≈ 0.1265 → z ≈ 1.14
    expect(hundred).toBeCloseTo(1.14, 1);
  });
  it('stays finite far in the tail', () => expect(Number.isFinite(adjustedBestZ(9, 1000))).toBe(true));
});

const rows = (pid: string, n: number, hits: number, label = 'Human', poles = 2, sessions = 1) => ({ label, pid, poles, sessions, n, hits });

describe('overallBoard', () => {
  it('matches stoufferFromGroups and applies the minimum', () => {
    const N = MIN_OVERALL_DRAWS;
    const data = [
      rows('a', N, N / 2 + 1500),                 // z ≈ +3.16
      rows('b', N / 2, N / 4 + 600), rows('b', N / 2, N / 6 + 300, 'Both', 3),   // mixed poles, combined
      rows('c', N - 1, N / 2 + 5000),             // below the minimum: not on the board, still in the funnel
      rows('d', N, N / 2 + 9000, 'Control'),      // other group
    ];
    const { board, funnel } = overallBoard(data, 'participants', p => p);
    expect(board.qualifying_ids).toBe(2);
    expect(board.top.map(e => e.tag)).toEqual(['a', 'b']);
    const zb = stoufferFromGroups([{ poles: 2, n: N / 2, hits: N / 4 + 600 }, { poles: 3, n: N / 2, hits: N / 6 + 300 }]).z!;
    expect(board.top[1].z).toBeCloseTo(zb, 3);
    expect(board.top[1].sessions).toBe(2);
    expect(board.top[0].focus_hours).toBeCloseTo(0.5, 5);
    expect(board.top[0].effect_per_10k).toBeCloseTo(1500 / N * 1e4, 2);
    expect(funnel).toHaveLength(3);
    expect(overallBoard(data, 'control', p => p).board.top[0].tag).toBe('d');
  });
  it('keeps only the top 10', () => {
    const data = Array.from({ length: 25 }, (_, i) => rows('p' + i, MIN_OVERALL_DRAWS, MIN_OVERALL_DRAWS / 2 + i * 10));
    const { board } = overallBoard(data, 'participants', p => p);
    expect(board.top).toHaveLength(TOP_N);
    expect(board.top[0].tag).toBe('p24');
    expect(board.qualifying_ids).toBe(25);
  });
});

describe('runBoard', () => {
  it('one great run beats the same run picked from many', () => {
    const r = [
      { grp: 'participants' as const, pid: 'once', runs: 1, best_z: 2.8, best_at: '2026-11-12T10:00:00Z' },
      { grp: 'participants' as const, pid: 'often', runs: 200, best_z: 3.3, best_at: '2026-11-11T10:00:00Z' },
      { grp: 'control' as const, pid: 'ctl', runs: 1, best_z: 4, best_at: '2026-11-10T10:00:00Z' },
    ];
    const b = runBoard(r, 'participants', p => p);
    expect(b.top.map(e => e.tag)).toEqual(['once', 'often']);
    expect(b.top[0].date).toBe('2026-11-12');
    expect(b.top[1].adjusted_z).toBeLessThan(b.top[1].best_z);
    expect(runBoard(r, 'control', p => p).top[0].tag).toBe('ctl');
  });
});

describe('cumulativeByDay', () => {
  it('accumulates in day order', () => {
    const d = [
      { label: 'Human', day: '2026-11-13', poles: 2, sessions: 1, n: 1000, hits: 520 },
      { label: 'Human', day: '2026-11-12', poles: 2, sessions: 2, n: 1000, hits: 510 },
    ];
    const out = cumulativeByDay(d, ['Human', 'Both']);
    expect(out.Human.map(x => x.day)).toEqual(['2026-11-12', '2026-11-13']);
    expect(out.Human[1].sessions).toBe(3);
    expect(out.Human[1].z).toBeCloseTo(stoufferFromGroups([{ poles: 2, n: 2000, hits: 1030 }]).z!, 3);
    expect(out.Both).toEqual([]);
  });
});

describe('tagFor', () => {
  it('is 6 hex, stable, and not part of the id', async () => {
    const id = 'f3b2c1d0-0000-4000-8000-000000000000';
    const t = await tagFor(id);
    expect(t).toMatch(/^[0-9a-f]{6}$/);
    expect(await tagFor(id)).toBe(t);
    expect(id.startsWith(t)).toBe(false);
  });
});
