// Pure statistics for Focus Field sessions. No I/O; unit-tested in test/stats.test.ts.

/** Standard normal CDF, Abramowitz & Stegun 26.2.17 (absolute error < 7.5e-8). */
export function phi(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const q = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - q : q;
}

/** One-sided upper-tail p-value, P(Z >= z). */
export const pUpper = (z: number): number => 1 - phi(z);

/** ln Γ(x), Lanczos approximation (g = 7, n = 9). */
function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized upper incomplete gamma Q(a, x) (Numerical Recipes gser / gcf). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  const FPMIN = 1e-300;
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Chi-square survival function P(X >= x) with df degrees of freedom. */
export function chiSquareSf(x: number, df: number): number {
  if (df <= 0) return 1;
  return Math.min(1, Math.max(0, gammaQ(df / 2, x / 2)));
}

export interface SessionStats {
  goal_n: number;
  goal_hits: number;
  goal_z: number | null;
  goal_p: number | null;
  base_n: number;
  base_chi2: number | null;
  base_p: number | null;
}

/**
 * Score a session with K poles. counts[i] are the per-pole draws in second i, marks[i] the focus pole
 * at that second (-1 = no focus). Focus seconds count toward the goal they had at the time; no-focus
 * seconds are pooled and tested against uniform.
 */
export function sessionStats(K: number, counts: number[][], marks: number[]): SessionStats {
  const p = 1 / K;
  let n = 0, hits = 0, baseN = 0;
  const base = new Array<number>(K).fill(0);
  for (let i = 0; i < counts.length; i++) {
    const row = counts[i], f = marks[i];
    let tot = 0;
    for (let k = 0; k < K; k++) tot += row[k];
    if (f >= 0) { n += tot; hits += row[f]; }
    else { baseN += tot; for (let k = 0; k < K; k++) base[k] += row[k]; }
  }
  let goal_z: number | null = null, goal_p: number | null = null;
  if (n > 0) { goal_z = (hits - n * p) / Math.sqrt(n * p * (1 - p)); goal_p = pUpper(goal_z); }
  let base_chi2: number | null = null, base_p: number | null = null;
  if (baseN > 0) {
    const e = baseN * p;
    let chi = 0;
    for (let k = 0; k < K; k++) chi += (base[k] - e) ** 2 / e;
    base_chi2 = chi; base_p = chiSquareSf(chi, K - 1);
  }
  return { goal_n: n, goal_hits: hits, goal_z, goal_p, base_n: baseN, base_chi2, base_p };
}

/**
 * Stouffer's Z weighted by draws, Z = Σ z_i·√n_i / √Σ n_i, over sessions with n_i > 0.
 * Takes per-session (z, n) pairs.
 */
export function stouffer(items: { z: number; n: number }[]): { z: number | null; p: number | null } {
  let num = 0, den = 0;
  for (const { z, n } of items) if (n > 0 && Number.isFinite(z)) { num += z * Math.sqrt(n); den += n; }
  if (den <= 0) return { z: null, p: null };
  const Z = num / Math.sqrt(den);
  return { z: Z, p: pUpper(Z) };
}

/**
 * The same Stouffer Z from aggregated sums, so the database can add up rows instead of returning them.
 * Since z_i·√n_i = (h_i − n_i/K)/√(p(1−p)), sessions with the same K can be summed first:
 * Z = Σ_K (H_K − N_K/K)/√(p_K(1−p_K)) / √Σ N_K. groups: one entry per pole count with summed hits and draws.
 */
export function stoufferFromGroups(groups: { poles: number; n: number; hits: number }[]): { z: number | null; p: number | null } {
  let num = 0, den = 0;
  for (const g of groups) {
    if (!(g.n > 0)) continue;
    const p = 1 / g.poles;
    num += (g.hits - g.n * p) / Math.sqrt(p * (1 - p));
    den += g.n;
  }
  if (den <= 0) return { z: null, p: null };
  const Z = num / Math.sqrt(den);
  return { z: Z, p: pUpper(Z) };
}
