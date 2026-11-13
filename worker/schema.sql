CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                 -- crypto.randomUUID() in the Worker
  received_at TEXT NOT NULL,           -- server time
  participant_id TEXT NOT NULL,        -- random id per browser, no PII
  label TEXT NOT NULL CHECK (label IN ('Human','Both','Control')),
  poles INTEGER NOT NULL CHECK (poles BETWEEN 2 AND 8),
  seconds INTEGER NOT NULL,
  block_size INTEGER,
  app_version TEXT,
  per_second_counts TEXT NOT NULL,     -- JSON [[c0..cK-1], ...]
  focus_marks TEXT NOT NULL,           -- JSON [f, ...]; -1 = no focus, else pole index
  goal_n INTEGER, goal_hits INTEGER, goal_z REAL, goal_p REAL,   -- recomputed by the Worker
  base_chi2 REAL, base_p REAL,                                    -- no-focus seconds vs uniform
  flags TEXT                           -- JSON list of warnings
);
CREATE INDEX IF NOT EXISTS idx_sessions_label ON sessions(label);

-- Summary tables, kept up to date on every save (see src/sql.ts). Reads never scan `sessions`.
CREATE TABLE IF NOT EXISTS agg_id_poles (       -- per id, label and pole count: overall boards, funnel
  label TEXT NOT NULL, pid TEXT NOT NULL, poles INTEGER NOT NULL,
  sessions INTEGER NOT NULL, n INTEGER NOT NULL, hits INTEGER NOT NULL,
  PRIMARY KEY (label, pid, poles)
);
CREATE TABLE IF NOT EXISTS agg_day (            -- per label, day and pole count: totals, running z
  label TEXT NOT NULL, day TEXT NOT NULL, poles INTEGER NOT NULL,
  sessions INTEGER NOT NULL, seconds INTEGER NOT NULL, n INTEGER NOT NULL, hits INTEGER NOT NULL,
  PRIMARY KEY (label, day, poles)
);
CREATE TABLE IF NOT EXISTS agg_runs (           -- per group and id: qualifying runs (>= 60 s focus) and the best one
  grp TEXT NOT NULL, pid TEXT NOT NULL, runs INTEGER NOT NULL, best_z REAL NOT NULL, best_at TEXT NOT NULL,
  PRIMARY KEY (grp, pid)
);
CREATE TABLE IF NOT EXISTS snapshots (          -- hourly-built JSON for /api/totals and /api/results
  key TEXT PRIMARY KEY, body TEXT NOT NULL, built_at TEXT NOT NULL
);
