// Runs the real SQL (schema.sql, src/sql.ts, migrate-summary.sql) in SQLite: summaries kept up to date on each
// save must equal summaries rebuilt from scratch, and the leaderboard must match a direct scan of sessions.
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import * as SQL from '../src/sql';
import { overallBoard, runBoard, groupOf, MIN_RUN_DRAWS } from '../src/results';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const migrate = readFileSync(new URL('../migrate-summary.sql', import.meta.url), 'utf8');
const sqlite = (s: string) => s.replace(/\?(\d+)/g, '?$1');   // node:sqlite accepts ?NNN numbered params as-is

function seeded(seed: number) { let x = seed; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; }

function fill(db: DatabaseSync, count: number) {
  const r = seeded(42);
  const labels = ['Human', 'Both', 'Control'];
  for (let i = 0; i < count; i++) {
    const pid = 'pid-' + Math.floor(r() * 25).toString().padStart(4, '0');
    const label = labels[Math.floor(r() * 3)], poles = 2 + Math.floor(r() * 4);
    const n = [0, 10000, 30000, 60000, 300000][Math.floor(r() * 5)];
    const p = 1 / poles, hits = Math.round(n * p + (r() - 0.5) * 2 * Math.sqrt(n * p * (1 - p)) * 2);
    const z = n > 0 ? (hits - n * p) / Math.sqrt(n * p * (1 - p)) : null;
    const at = `2026-11-${String(10 + Math.floor(r() * 5)).padStart(2, '0')}T${String(Math.floor(r() * 24)).padStart(2, '0')}:00:00.000Z`;
    const seconds = Math.max(1, Math.round(n / 500) + 10);
    db.prepare(sqlite(SQL.INSERT_SESSION)).run(`s${i}`, at, pid, label, poles, seconds, 100, '1.1.0', '[]', '[]', n, hits, z, 0.5, null, null, '[]');
    db.prepare(sqlite(SQL.UPSERT_ID_POLES)).run(label, pid, poles, n, hits);
    db.prepare(sqlite(SQL.UPSERT_DAY)).run(label, at.slice(0, 10), poles, n, hits, seconds);
    if (n >= MIN_RUN_DRAWS && z !== null) db.prepare(sqlite(SQL.UPSERT_RUN)).run(groupOf(label), pid, z, at);
  }
}

const dump = (db: DatabaseSync) => ({
  id: db.prepare('SELECT * FROM agg_id_poles ORDER BY label, pid, poles').all(),
  day: db.prepare('SELECT * FROM agg_day ORDER BY label, day, poles').all(),
  runs: db.prepare('SELECT grp, pid, runs, round(best_z, 9) AS best_z FROM agg_runs ORDER BY grp, pid').all(),
});

describe('summary tables', () => {
  it('upserts on each save equal a rebuild from sessions', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    fill(db, 400);
    const live = dump(db);
    db.exec(migrate);                         // wipes and rebuilds the summaries from `sessions`
    const rebuilt = dump(db);
    expect(live.id.length).toBeGreaterThan(20);
    expect(live).toEqual(rebuilt);
  });

  it('best_at follows the best run', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    const up = db.prepare(sqlite(SQL.UPSERT_RUN));
    up.run('participants', 'x', 1.0, 'A'); up.run('participants', 'x', 2.5, 'B'); up.run('participants', 'x', 0.3, 'C');
    expect(db.prepare('SELECT runs, best_z, best_at FROM agg_runs').get()).toEqual({ runs: 3, best_z: 2.5, best_at: 'B' });
  });

  it('leaderboards from summaries match a direct scan', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    fill(db, 400);
    const id = (p: string) => p;
    const fromAgg = overallBoard(db.prepare(SQL.READ_ID_POLES).all() as never, 'participants', id).board;
    const direct = overallBoard(db.prepare(`SELECT label, participant_id AS pid, poles, COUNT(*) AS sessions, SUM(goal_n) AS n, SUM(goal_hits) AS hits FROM sessions GROUP BY label, participant_id, poles`).all() as never, 'participants', id).board;
    // same rows summed in a different order: equal to 10 significant figures
    const tidy = (b: unknown) => JSON.parse(JSON.stringify(b, (_k, v) => typeof v === 'number' ? Number(v.toPrecision(10)) : v));
    expect(tidy(fromAgg)).toEqual(tidy(direct));
    const runsAgg = runBoard(db.prepare(SQL.READ_RUNS).all() as never, 'participants', id);
    const runsDirect = runBoard(db.prepare(`SELECT CASE WHEN label = 'Control' THEN 'control' ELSE 'participants' END AS grp, participant_id AS pid, COUNT(*) AS runs, MAX(goal_z) AS best_z, received_at AS best_at FROM sessions WHERE goal_n >= ${MIN_RUN_DRAWS} AND goal_z IS NOT NULL GROUP BY grp, participant_id`).all() as never, 'participants', id);
    expect(tidy(runsAgg)).toEqual(tidy(runsDirect));
  });
});
