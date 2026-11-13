// Results page analysis: leaderboards, cumulative z by day, funnel points. Pure; unit-tested in test/results.test.ts.
// Input rows are sums made inside D1, so no session rows (counts, focus marks) ever leave the database.

import { phi } from './stats';

export const DRAWS_PER_SECOND = 500;
export const MIN_OVERALL_DRAWS = 30 * 60 * DRAWS_PER_SECOND;   // 30 minutes of focus data
export const MIN_RUN_DRAWS = 60 * DRAWS_PER_SECOND;            // a run counts from 60 seconds of focus
export const TOP_N = 10;
export const MAX_FUNNEL_POINTS = 1000;

/** Two boards are kept per group: participants (Human + Both) and the Control sessions, which show what luck looks like. */
export type Group = 'participants' | 'control';
export const groupOf = (label: string): Group => (label === 'Control' ? 'control' : 'participants');

/** Inverse standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
export function probit(p: number): number {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** One-sided upper p for z, computed as Φ(−z) so it stays accurate far out in the tail. */
const pUp = (z: number) => phi(-z);

/**
 * Luck line: the expected best z among `ids` independent scores under pure chance (Blom's approximation of the
 * expected maximum of N standard normals). 0 when there is at most one id.
 */
export function luckLine(ids: number): number {
  if (ids <= 1) return 0;
  return probit((ids - 0.375) / (ids + 0.25));
}

/**
 * Best single run corrected for the number of runs: p_adj = 1 − (1 − p_best)^runs, returned as a z.
 * Computed with log1p/expm1 so a tiny p over many runs keeps its precision.
 */
export function adjustedBestZ(bestZ: number, runs: number): number {
  const p = pUp(bestZ);
  if (runs <= 1) return bestZ;
  const pAdj = -Math.expm1(runs * Math.log1p(-p));
  return -probit(pAdj);
}

// Accumulator for Stouffer's Z across pole counts: num = Σ (H − N/K)/√(p(1−p)), den = Σ N.
interface Acc { num: number; den: number; excess: number; sessions: number }
const acc = (): Acc => ({ num: 0, den: 0, excess: 0, sessions: 0 });
function add(a: Acc, poles: number, n: number, hits: number, sessions = 0) {
  if (!(n > 0)) { a.sessions += sessions; return; }
  const p = 1 / poles;
  a.num += (hits - n * p) / Math.sqrt(p * (1 - p));
  a.excess += hits - n * p;
  a.den += n;
  a.sessions += sessions;
}
const zOf = (a: Acc) => (a.den > 0 ? a.num / Math.sqrt(a.den) : null);

export interface IdPolesRow { label: string; pid: string; poles: number; sessions: number; n: number; hits: number }
export interface RunRow { grp: Group; pid: string; runs: number; best_z: number; best_at: string }
export interface DayRow { label: string; day: string; poles: number; sessions: number; seconds?: number; n: number; hits: number }

export interface OverallEntry { tag: string; focus_hours: number; sessions: number; effect_per_10k: number; z: number; p: number }
export interface RunEntry { tag: string; best_z: number; runs: number; adjusted_z: number; adjusted_p: number; date: string }
export interface Board<T> { qualifying_ids: number; luck_z: number; top: T[] }

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** Overall board for one group: Stouffer z over all of an id's sessions, ids with at least MIN_OVERALL_DRAWS. */
export function overallBoard(rows: IdPolesRow[], grp: Group, tagOf: (pid: string) => string): { board: Board<OverallEntry>; funnel: { draws: number; z: number }[] } {
  const by = new Map<string, Acc>();
  for (const r of rows) {
    if (groupOf(r.label) !== grp) continue;
    let a = by.get(r.pid);
    if (!a) by.set(r.pid, (a = acc()));
    add(a, r.poles, Number(r.n), Number(r.hits), Number(r.sessions));
  }
  const all = [...by.entries()].filter(([, a]) => a.den > 0).map(([pid, a]) => ({ pid, a, z: zOf(a) as number }));
  const qual = all.filter(e => e.a.den >= MIN_OVERALL_DRAWS).sort((x, y) => y.z - x.z);
  const top = qual.slice(0, TOP_N).map(e => ({
    tag: tagOf(e.pid),
    focus_hours: round(e.a.den / DRAWS_PER_SECOND / 3600, 2),
    sessions: e.a.sessions,
    effect_per_10k: round((e.a.excess / e.a.den) * 1e4, 2),
    z: round(e.z, 3),
    p: pUp(e.z),
  }));
  const funnel = all.sort((x, y) => y.a.den - x.a.den).slice(0, MAX_FUNNEL_POINTS).map(e => ({ draws: e.a.den, z: round(e.z, 3) }));
  return { board: { qualifying_ids: qual.length, luck_z: round(luckLine(qual.length), 3), top }, funnel };
}

/** Single-run board for one group: each id's best run, corrected for how many runs it made. */
export function runBoard(rows: RunRow[], grp: Group, tagOf: (pid: string) => string): Board<RunEntry> {
  const qual = rows.filter(r => r.grp === grp && Number(r.runs) > 0 && Number.isFinite(Number(r.best_z)))
    .map(r => ({ r, adj: adjustedBestZ(Number(r.best_z), Number(r.runs)) }))
    .sort((x, y) => y.adj - x.adj);
  const top = qual.slice(0, TOP_N).map(({ r, adj }) => ({
    tag: tagOf(r.pid),
    best_z: round(Number(r.best_z), 3),
    runs: Number(r.runs),
    adjusted_z: round(adj, 3),
    adjusted_p: pUp(adj),
    date: String(r.best_at).slice(0, 10),
  }));
  return { qualifying_ids: qual.length, luck_z: round(luckLine(qual.length), 3), top };
}

/** Cumulative Stouffer z per label, one point per day with data, oldest first. */
export function cumulativeByDay(rows: DayRow[], labels: readonly string[]) {
  const out: Record<string, { day: string; sessions: number; draws: number; z: number | null }[]> = {};
  for (const label of labels) {
    const days = [...new Set(rows.filter(r => r.label === label).map(r => r.day))].sort();
    const a = acc();
    out[label] = days.map(day => {
      for (const r of rows) if (r.label === label && r.day === day) add(a, r.poles, Number(r.n), Number(r.hits), Number(r.sessions));
      const z = zOf(a);
      return { day, sessions: a.sessions, draws: a.den, z: z === null ? null : round(z, 3) };
    });
  }
  return out;
}

/** Public 6-character tag for an id: the first hex of SHA-256(id), so no part of the id itself is shown. */
export async function tagFor(pid: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pid));
  return [...new Uint8Array(h)].slice(0, 3).map(b => b.toString(16).padStart(2, '0')).join('');
}
