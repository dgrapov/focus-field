import { describe, it, expect } from 'vitest';
import { phi, pUpper, chiSquareSf, sessionStats, stouffer, stoufferFromGroups } from '../src/stats';

describe('phi (standard normal CDF)', () => {
  // reference values to 10 digits
  const ref: [number, number][] = [
    [0, 0.5], [1, 0.8413447461], [-1, 0.1586552539], [1.644853627, 0.95], [1.959963985, 0.975],
    [2.326347874, 0.99], [3, 0.9986501020], [-3, 0.0013498980], [0.5, 0.6914624613], [-2.5, 0.0062096653],
  ];
  for (const [z, p] of ref) it(`phi(${z}) ≈ ${p}`, () => expect(Math.abs(phi(z) - p)).toBeLessThan(1e-6));
  it('is symmetric', () => { for (const z of [0.1, 0.7, 1.3, 2.2, 4]) expect(phi(z) + phi(-z)).toBeCloseTo(1, 7); });
  it('handles infinities', () => { expect(phi(Infinity)).toBe(1); expect(phi(-Infinity)).toBe(0); });
  it('pUpper is one-sided', () => expect(pUpper(1.959963985)).toBeCloseTo(0.025, 6));
});

describe('chiSquareSf', () => {
  const ref: [number, number, number][] = [
    [3.841458821, 1, 0.05], [6.634896601, 1, 0.01], [5.991464547, 2, 0.05], [7.814727903, 3, 0.05],
    [11.07049769, 5, 0.05], [14.06714045, 7, 0.05], [2, 2, Math.exp(-1)], [1, 1, 0.3173105079], [10, 4, 0.0404276819],
  ];
  for (const [x, df, p] of ref) it(`sf(${x}, ${df}) ≈ ${p}`, () => expect(Math.abs(chiSquareSf(x, df) - p)).toBeLessThan(1e-7));
  it('sf(0) = 1', () => expect(chiSquareSf(0, 3)).toBe(1));
  it('df <= 0 gives 1', () => expect(chiSquareSf(5, 0)).toBe(1));
});

describe('sessionStats', () => {
  it('known counts give a known z (K = 2)', () => {
    // two focus seconds on pole 0 (500 draws each) and one no-focus second
    const counts = [[270, 230], [260, 240], [250, 250]];
    const marks = [0, 0, -1];
    const s = sessionStats(2, counts, marks);
    expect(s.goal_n).toBe(1000);
    expect(s.goal_hits).toBe(530);
    // z = (530 − 500)/√(1000·¼) = 30/15.8114 = 1.897367
    expect(s.goal_z!).toBeCloseTo(1.8973666, 6);
    expect(s.goal_p!).toBeCloseTo(0.0288897, 5);
    expect(s.base_n).toBe(500);
    expect(s.base_chi2).toBe(0);
    expect(s.base_p).toBe(1);
  });
  it('known counts give a known z (K = 4), switching goals', () => {
    const counts = [[150, 120, 115, 115], [100, 160, 120, 120], [125, 125, 125, 125]];
    const marks = [0, 1, 2];
    const s = sessionStats(4, counts, marks);
    expect(s.goal_n).toBe(1500);
    expect(s.goal_hits).toBe(150 + 160 + 125);
    // p = ¼: z = (435 − 375)/√(1500·¼·¾) = 60/16.7705 = 3.577709
    expect(s.goal_z!).toBeCloseTo(3.5777088, 6);
    expect(s.base_chi2).toBeNull();
    expect(s.base_p).toBeNull();
  });
  it('baseline chi-square vs uniform', () => {
    const s = sessionStats(3, [[200, 150, 150], [180, 160, 160]], [-1, -1]);
    // pooled 380,310,310 of 1000, e = 333.33: chi = (46.67² + 23.33² + 23.33²)/333.33 = 9.8
    expect(s.base_chi2!).toBeCloseTo(9.8, 9);
    expect(s.base_p!).toBeCloseTo(Math.exp(-4.9), 9);   // df = 2: sf = e^(−x/2)
    expect(s.goal_z).toBeNull();
    expect(s.goal_n).toBe(0);
  });
});

describe('stouffer', () => {
  it('weights by draws', () => {
    const r = stouffer([{ z: 1, n: 100 }, { z: 2, n: 400 }, { z: 5, n: 0 }]);
    // (1·10 + 2·20)/√500 = 50/22.3607 = 2.236068
    expect(r.z!).toBeCloseTo(2.2360680, 6);
    expect(r.p!).toBeCloseTo(pUpper(2.236068), 6);
  });
  it('empty gives null', () => expect(stouffer([])).toEqual({ z: null, p: null }));
  it('grouped sums equal the per-session formula', () => {
    const sessions = [
      { K: 2, counts: [[270, 230], [240, 260]], marks: [0, 1] },
      { K: 2, counts: [[255, 245]], marks: [1] },
      { K: 4, counts: [[150, 120, 115, 115], [125, 125, 125, 125]], marks: [0, -1] },
      { K: 6, counts: [[90, 82, 82, 82, 82, 82]], marks: [0] },
      { K: 3, counts: [[170, 165, 165]], marks: [-1] },
    ];
    const per = sessions.map(s => sessionStats(s.K, s.counts, s.marks));
    const direct = stouffer(per.map(s => ({ z: s.goal_z ?? 0, n: s.goal_n })));
    const g = new Map<number, { poles: number; n: number; hits: number }>();
    sessions.forEach((s, i) => { const e = g.get(s.K) || { poles: s.K, n: 0, hits: 0 }; e.n += per[i].goal_n; e.hits += per[i].goal_hits; g.set(s.K, e); });
    const grouped = stoufferFromGroups([...g.values()]);
    expect(grouped.z!).toBeCloseTo(direct.z!, 10);
    expect(grouped.p!).toBeCloseTo(direct.p!, 10);
  });
});
