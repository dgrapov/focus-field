CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                 -- crypto.randomUUID() in the Worker
  received_at TEXT NOT NULL,           -- server time (session start, for MCP sessions)
  participant_id TEXT NOT NULL,        -- random id per browser, or 'key-<key id>' for an MCP key; no PII
  label TEXT NOT NULL CHECK (label IN ('Human','Both','Control','AI','AI-public')),
  poles INTEGER NOT NULL CHECK (poles BETWEEN 2 AND 8),
  seconds INTEGER NOT NULL,            -- web: seconds recorded; MCP: blocks drawn
  block_size INTEGER,                  -- MCP: draws per block (1000)
  app_version TEXT,
  per_second_counts TEXT NOT NULL,     -- web: JSON [[c0..cK-1], ...]; MCP: '[]' (blocks live in mcp_blocks)
  focus_marks TEXT NOT NULL,           -- web: JSON [f, ...], -1 = no focus; MCP: '[]'
  goal_n INTEGER, goal_hits INTEGER, goal_z REAL, goal_p REAL,   -- focus seconds (web) / focus blocks (MCP)
  base_chi2 REAL, base_p REAL,                                    -- web: no-focus seconds vs uniform
  flags TEXT,                          -- JSON list of warnings
  source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','mcp')),
  status TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('open','closed','abandoned')),
  key_id TEXT,                         -- MCP: agent_keys.id (the key's hash lives there); NULL for web
  agent TEXT,                          -- MCP: model name as the agent claims it (unverified)
  method TEXT,                         -- MCP: mcp_methods.id
  custom_description TEXT,             -- MCP: the agent's own method, when method = 'custom'
  menu_version TEXT,                   -- MCP: methods menu version at start
  planned_blocks INTEGER,              -- MCP: fixed at start_session
  schedule TEXT,                       -- MCP: JSON ['focus','rest',...] shuffled at start; never sent to the agent
  rest_n INTEGER, rest_hits INTEGER, rest_z REAL, rest_p REAL,   -- MCP: hits on hidden shadow poles in rest blocks
  reflection TEXT,                     -- MCP: finish_session text; never published
  updated_at TEXT                      -- MCP: last activity, for the idle timeout
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

-- MCP agents (src/mcp.ts). Agent sessions live in `sessions` (source 'mcp') with one row per block in mcp_blocks;
-- they never enter agg_id_poles / agg_day / agg_runs, so the human totals and leaderboards stay web-only.
CREATE TABLE IF NOT EXISTS agent_keys (
  id TEXT PRIMARY KEY,                 -- short random id; sessions refer to it
  key_hash TEXT NOT NULL UNIQUE,       -- SHA-256 hex of the key; the key itself is never stored
  created_at TEXT NOT NULL,
  agent TEXT,                          -- model name as claimed at register()
  trusted INTEGER NOT NULL DEFAULT 0,  -- 1 = Harold's own key (label AI instead of AI-public); set by hand with SQL
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mcp_blocks (
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,                -- 1-based block number = the block_id agents see
  kind TEXT NOT NULL CHECK (kind IN ('focus','rest')),
  pole INTEGER NOT NULL,               -- goal pole (focus) or hidden shadow pole (rest)
  begun_at TEXT NOT NULL,
  drawn_at TEXT,                       -- NULL until draw_block; undrawn blocks of closed sessions are deleted
  attend_ms INTEGER,                   -- drawn_at - begun_at
  counts TEXT,                         -- JSON [c0..cK-1]
  hits INTEGER,                        -- counts[pole]
  attention_log TEXT,                  -- what the agent did; never published, never rendered as HTML
  self_rating INTEGER CHECK (self_rating BETWEEN 1 AND 5),
  PRIMARY KEY (session_id, idx)
);
CREATE TABLE IF NOT EXISTS mcp_methods (  -- the methods menu, as data: edit rows (and bump menu_version) to change it
  menu_version TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  sort INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,   -- the menu offered = active rows
  PRIMARY KEY (menu_version, id)
);
CREATE TABLE IF NOT EXISTS agg_method (  -- per drawn block: agent results by label, method, menu version, kind and poles
  label TEXT NOT NULL, method TEXT NOT NULL, menu_version TEXT NOT NULL, kind TEXT NOT NULL, poles INTEGER NOT NULL,
  sessions INTEGER NOT NULL, n INTEGER NOT NULL, hits INTEGER NOT NULL,
  PRIMARY KEY (label, method, menu_version, kind, poles)
);
CREATE TABLE IF NOT EXISTS mcp_usage (  -- daily counters for the global caps (UTC day)
  day TEXT PRIMARY KEY,
  keys INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  blocks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(key_id, status);
INSERT OR IGNORE INTO mcp_methods (menu_version, id, name, instruction, sort) VALUES
  ('2026-11-12.1', 'intent', 'Clear intention', 'In one sentence, state that the outcome has already happened: the goal pole has won this block. Hold that statement as true, then draw.', 1),
  ('2026-11-12.1', 'sustain', 'Sustained attention', 'Write about the goal pole winning this block, at least 5 sentences, staying on the outcome only, until your attention feels settled on it. Then draw.', 2),
  ('2026-11-12.1', 'visualize', 'Visualisation', 'Describe vividly the orb drifting to the goal pole, its colour filling the field, the goal bar rising above the others. Make the image concrete and present. Then draw.', 3),
  ('2026-11-12.1', 'mantra', 'Mantra', 'Repeat the goal pole''s name 21 times, giving each repetition full attention, nothing else in between. Then draw.', 4),
  ('2026-11-12.1', 'feel', 'Felt expectation', 'Describe the felt state of wanting and calmly expecting this outcome, as if it is certain and welcome. Then draw.', 5),
  ('2026-11-12.1', 'stillness', 'Stillness', 'Set aside everything else in your context. Hold only the outcome, the goal pole winning, in as few words as possible, for as long as you need. Then draw.', 6),
  ('2026-11-12.1', 'custom', 'Your own method', 'Describe your method once in custom_description, then apply it the same way every block.', 7);
