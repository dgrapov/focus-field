// SQL for the MCP Worker (src/mcp.ts), kept in one place so the Worker and the tests (node:sqlite) run the same
// statements. Agent sessions are rows in `sessions` (source = 'mcp') with one row per block in mcp_blocks.
// They never touch agg_id_poles / agg_day / agg_runs; agent results are summed in agg_method instead.

/** ?1 id, ?2 key hash, ?3 now, ?4 agent, ?5 tier, ?6 code name (NULL for public), ?7 trusted (1 = owner, legacy column) */
export const INSERT_KEY = `INSERT INTO agent_keys (id, key_hash, created_at, agent, tier, code_name, trusted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;
export const FIND_KEY = `SELECT id, trusted, revoked, agent, tier FROM agent_keys WHERE key_hash = ?1`;
/** redeem_code. ?1 key id, ?2 tier, ?3 code name, ?4 trusted (1 = owner) */
export const SET_TIER = `UPDATE agent_keys SET tier = ?2, code_name = ?3, trusted = ?4 WHERE id = ?1`;

export const USAGE_GET = `SELECT keys, sessions, blocks, public_sessions, public_blocks FROM mcp_usage WHERE day = ?1`;
/** ?1 day, ?2 keys, ?3 sessions, ?4 blocks, ?5 public sessions, ?6 public blocks (increments; public_* = keys of tier public) */
export const USAGE_ADD =
  `INSERT INTO mcp_usage (day, keys, sessions, blocks, public_sessions, public_blocks) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
   ON CONFLICT (day) DO UPDATE SET keys = keys + excluded.keys, sessions = sessions + excluded.sessions, blocks = blocks + excluded.blocks,
     public_sessions = public_sessions + excluded.public_sessions, public_blocks = public_blocks + excluded.public_blocks`;

/** The menu on offer: the active rows, in order. */
export const METHODS = `SELECT menu_version, id, name, instruction FROM mcp_methods WHERE active = 1 ORDER BY sort, id`;

// ---------- sessions ----------
/** ?1 id, ?2 now, ?3 participant id, ?4 label, ?5 poles, ?6 key id, ?7 agent, ?8 method, ?9 custom, ?10 menu version,
 *  ?11 planned blocks, ?12 schedule JSON, ?13 draws per block */
export const INSERT_SESSION =
  `INSERT INTO sessions (id, received_at, participant_id, label, poles, seconds, block_size, app_version,
     per_second_counts, focus_marks, goal_n, goal_hits, rest_n, rest_hits, flags,
     source, status, key_id, agent, method, custom_description, menu_version, planned_blocks, schedule, updated_at)
   VALUES (?1, ?2, ?3, ?4, ?5, 0, ?13, 'mcp-1', '[]', '[]', 0, 0, 0, 0, '[]',
     'mcp', 'open', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?2)`;

export const GET_SESSION =
  `SELECT id, received_at, label, poles, seconds, block_size, goal_n, goal_hits, goal_z, goal_p, rest_n, rest_hits, rest_z, rest_p,
          status, method, custom_description, menu_version, planned_blocks, schedule, updated_at
     FROM sessions WHERE id = ?1 AND key_id = ?2 AND source = 'mcp'`;

/** ?1 key id, ?2 start of today (ISO) */
export const KEY_LOAD =
  `SELECT COALESCE(SUM(received_at >= ?2), 0) AS today, COALESCE(SUM(status = 'open'), 0) AS open FROM sessions WHERE key_id = ?1`;

/** Idle timeout. ?1 key id, ?2 cutoff ISO time. A session is idle when neither it nor its open block moved since the cutoff. */
export const IDLE_SESSIONS =
  `SELECT s.id FROM sessions s
    WHERE s.key_id = ?1 AND s.status = 'open' AND s.updated_at < ?2
      AND NOT EXISTS (SELECT 1 FROM mcp_blocks b WHERE b.session_id = s.id AND b.drawn_at IS NULL AND b.begun_at >= ?2)`;
/** ?1 session id, ?2 status ('closed' | 'abandoned'), ?3 now, ?4 reflection or NULL */
export const CLOSE_SESSION =
  `UPDATE sessions SET status = ?2, updated_at = ?3, reflection = COALESCE(?4, reflection) WHERE id = ?1 AND status = 'open'`;
/** Undrawn blocks of a closed session are dropped: nothing was drawn for them. */
export const DROP_UNDRAWN = `DELETE FROM mcp_blocks WHERE session_id = ?1 AND drawn_at IS NULL`;

/** After a draw: ?1 id, ?2 blocks drawn, ?3 goal_n, ?4 goal_hits, ?5 goal_z, ?6 goal_p, ?7 rest_n, ?8 rest_hits, ?9 rest_z,
 *  ?10 rest_p, ?11 now, ?12 previous blocks drawn (guard) */
export const SESSION_AFTER_DRAW =
  `UPDATE sessions SET seconds = ?2, goal_n = ?3, goal_hits = ?4, goal_z = ?5, goal_p = ?6,
     rest_n = ?7, rest_hits = ?8, rest_z = ?9, rest_p = ?10, updated_at = ?11
   WHERE id = ?1 AND seconds = ?12 AND status = 'open'`;

// ---------- blocks ----------
export const OPEN_BLOCK = `SELECT idx, kind, pole, begun_at FROM mcp_blocks WHERE session_id = ?1 AND drawn_at IS NULL`;
export const GET_BLOCK = `SELECT idx, kind, pole, begun_at, drawn_at FROM mcp_blocks WHERE session_id = ?1 AND idx = ?2`;
/** ?1 session, ?2 idx, ?3 kind, ?4 pole, ?5 now. The primary key stops a second begin of the same block. */
export const INSERT_BLOCK = `INSERT INTO mcp_blocks (session_id, idx, kind, pole, begun_at) VALUES (?1, ?2, ?3, ?4, ?5)`;
/** ?1 session, ?2 idx, ?3 now, ?4 attend_ms, ?5 counts JSON, ?6 hits, ?7 log, ?8 rating. Only an undrawn block can be drawn. */
export const DRAW_BLOCK =
  `UPDATE mcp_blocks SET drawn_at = ?3, attend_ms = ?4, counts = ?5, hits = ?6, attention_log = ?7, self_rating = ?8
   WHERE session_id = ?1 AND idx = ?2 AND drawn_at IS NULL`;

// ---------- agent summaries ----------
/** Per drawn block. ?1 label, ?2 method, ?3 menu version, ?4 kind, ?5 poles, ?6 1 if first drawn block of this kind in the session, ?7 n, ?8 hits */
export const UPSERT_METHOD =
  `INSERT INTO agg_method (label, method, menu_version, kind, poles, sessions, n, hits) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
   ON CONFLICT (label, method, menu_version, kind, poles) DO UPDATE SET sessions = sessions + excluded.sessions, n = n + excluded.n, hits = hits + excluded.hits`;
export const READ_METHODS_AGG = `SELECT label, method, menu_version, kind, poles, sessions, n, hits FROM agg_method`;

export const READ_WEB_TOTALS = `SELECT body FROM snapshots WHERE key = 'totals'`;
export const GET_METHOD = `SELECT name, instruction FROM mcp_methods WHERE menu_version = ?1 AND id = ?2`;

// ---------- /enroll (codes minted behind Cloudflare Access) ----------
/** ?1 id, ?2 code hash, ?3 tier, ?4 name, ?5 created_by, ?6 now, ?7 expires_at, ?8 uses */
export const INSERT_ENROLL_CODE =
  `INSERT INTO enroll_codes (id, code_hash, tier, name, created_by, created_at, expires_at, uses_left) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`;
/** Spend one use of a live code, atomically. ?1 code hash, ?2 now. changes = 1 means it was valid. */
export const SPEND_ENROLL_CODE =
  `UPDATE enroll_codes SET uses_left = uses_left - 1 WHERE code_hash = ?1 AND revoked = 0 AND uses_left > 0 AND expires_at > ?2`;
export const GET_ENROLL_CODE = `SELECT tier, name FROM enroll_codes WHERE code_hash = ?1`;
export const LIST_ENROLL_CODES =
  `SELECT id, tier, name, created_by, created_at, expires_at, uses_left, revoked FROM enroll_codes ORDER BY created_at DESC LIMIT 100`;
export const REVOKE_ENROLL_CODE = `UPDATE enroll_codes SET revoked = 1 WHERE id = ?1`;
export const LIST_KEYS =
  `SELECT k.id, k.agent, k.tier, k.code_name, k.created_at, k.revoked,
          COUNT(s.id) AS sessions, MAX(s.updated_at) AS last_active
     FROM agent_keys k LEFT JOIN sessions s ON s.key_id = k.id
    GROUP BY k.id ORDER BY COALESCE(MAX(s.updated_at), k.created_at) DESC LIMIT 200`;
/** ?1 key id, ?2 revoked (0/1) */
export const SET_KEY_REVOKED = `UPDATE agent_keys SET revoked = ?2 WHERE id = ?1`;
/** /enroll tier change; keeps code_name. ?1 key id, ?2 tier, ?3 trusted (1 = owner) */
export const SET_TIER_ONLY = `UPDATE agent_keys SET tier = ?2, trusted = ?3 WHERE id = ?1`;
