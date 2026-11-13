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
CREATE INDEX IF NOT EXISTS idx_sessions_pid ON sessions(participant_id);
