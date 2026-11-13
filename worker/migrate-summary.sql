-- One-off migration: create the summary tables and fill them from the existing sessions.
-- Safe to re-run: it rebuilds the summaries from scratch.
-- npx wrangler d1 execute focus-field-db --remote --file=./migrate-summary.sql
CREATE TABLE IF NOT EXISTS agg_id_poles (label TEXT NOT NULL, pid TEXT NOT NULL, poles INTEGER NOT NULL, sessions INTEGER NOT NULL, n INTEGER NOT NULL, hits INTEGER NOT NULL, PRIMARY KEY (label, pid, poles));
CREATE TABLE IF NOT EXISTS agg_day (label TEXT NOT NULL, day TEXT NOT NULL, poles INTEGER NOT NULL, sessions INTEGER NOT NULL, seconds INTEGER NOT NULL, n INTEGER NOT NULL, hits INTEGER NOT NULL, PRIMARY KEY (label, day, poles));
CREATE TABLE IF NOT EXISTS agg_runs (grp TEXT NOT NULL, pid TEXT NOT NULL, runs INTEGER NOT NULL, best_z REAL NOT NULL, best_at TEXT NOT NULL, PRIMARY KEY (grp, pid));
CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, body TEXT NOT NULL, built_at TEXT NOT NULL);
DELETE FROM agg_id_poles; DELETE FROM agg_day; DELETE FROM agg_runs; DELETE FROM snapshots;
INSERT INTO agg_id_poles (label, pid, poles, sessions, n, hits)
  SELECT label, participant_id, poles, COUNT(*), SUM(COALESCE(goal_n, 0)), SUM(COALESCE(goal_hits, 0)) FROM sessions GROUP BY label, participant_id, poles;
INSERT INTO agg_day (label, day, poles, sessions, seconds, n, hits)
  SELECT label, substr(received_at, 1, 10), poles, COUNT(*), SUM(seconds), SUM(COALESCE(goal_n, 0)), SUM(COALESCE(goal_hits, 0)) FROM sessions GROUP BY label, substr(received_at, 1, 10), poles;
INSERT INTO agg_runs (grp, pid, runs, best_z, best_at)
  SELECT CASE WHEN label = 'Control' THEN 'control' ELSE 'participants' END AS g, participant_id, COUNT(*), MAX(goal_z), received_at
    FROM sessions WHERE goal_n >= 30000 AND goal_z IS NOT NULL GROUP BY g, participant_id;
DROP INDEX IF EXISTS idx_sessions_pid;
