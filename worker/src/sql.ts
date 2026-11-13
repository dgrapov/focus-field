// SQL for the summary tables. Kept in one place so the Worker and the tests (node:sqlite) run the same statements.
//
// Reads are what cost on D1 (5M rows/day free), so nothing a visitor triggers scans `sessions`:
// - each save also upserts three small summary tables (rows grow with people and days, not sessions);
// - an hourly cron rebuilds /api/totals and /api/results from those tables into `snapshots`;
// - GET endpoints read one snapshot row (and each Worker copy memoises it for a few minutes).

/** Session row + three summary upserts, run together in one D1 batch (a single transaction). */
export const INSERT_SESSION =
  `INSERT INTO sessions (id, received_at, participant_id, label, poles, seconds, block_size, app_version,
     per_second_counts, focus_marks, goal_n, goal_hits, goal_z, goal_p, base_chi2, base_p, flags)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`;

/** ?1 label, ?2 pid, ?3 poles, ?4 goal_n, ?5 goal_hits */
export const UPSERT_ID_POLES =
  `INSERT INTO agg_id_poles (label, pid, poles, sessions, n, hits) VALUES (?1, ?2, ?3, 1, ?4, ?5)
   ON CONFLICT (label, pid, poles) DO UPDATE SET sessions = sessions + 1, n = n + excluded.n, hits = hits + excluded.hits`;

/** ?1 label, ?2 day (YYYY-MM-DD), ?3 poles, ?4 goal_n, ?5 goal_hits, ?6 seconds */
export const UPSERT_DAY =
  `INSERT INTO agg_day (label, day, poles, sessions, seconds, n, hits) VALUES (?1, ?2, ?3, 1, ?6, ?4, ?5)
   ON CONFLICT (label, day, poles) DO UPDATE SET sessions = sessions + 1, seconds = seconds + excluded.seconds, n = n + excluded.n, hits = hits + excluded.hits`;

/** Only for runs that qualify (goal_n >= MIN_RUN_DRAWS, z not null). ?1 grp, ?2 pid, ?3 goal_z, ?4 received_at.
 *  In SQLite every SET expression sees the old row, so best_at compares against the old best_z. */
export const UPSERT_RUN =
  `INSERT INTO agg_runs (grp, pid, runs, best_z, best_at) VALUES (?1, ?2, 1, ?3, ?4)
   ON CONFLICT (grp, pid) DO UPDATE SET runs = runs + 1,
     best_at = CASE WHEN excluded.best_z > best_z THEN excluded.best_at ELSE best_at END,
     best_z = MAX(best_z, excluded.best_z)`;

export const READ_ID_POLES = `SELECT label, pid, poles, sessions, n, hits FROM agg_id_poles`;
export const READ_RUNS = `SELECT grp, pid, runs, best_z, best_at FROM agg_runs`;
export const READ_DAYS = `SELECT label, day, poles, sessions, seconds, n, hits FROM agg_day`;

export const READ_SNAPSHOT = `SELECT body FROM snapshots WHERE key = ?1`;
export const WRITE_SNAPSHOT =
  `INSERT INTO snapshots (key, body, built_at) VALUES (?1, ?2, ?3)
   ON CONFLICT (key) DO UPDATE SET body = excluded.body, built_at = excluded.built_at`;
