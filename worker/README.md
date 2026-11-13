# focus-field-api and focus-field-mcp

Shared-data backend for Focus Field: two Cloudflare Workers on one D1 (SQLite) database. `focus-field-api` serves the web page (below); `focus-field-mcp` is the MCP server for AI participants ([section below](#mcp-server-focus-field-mcp)).
Live URL once deployed: `https://focus-field-api.dgrapov.workers.dev`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/session` | One finished session. Body (max 1 MB): `{turnstile_token, participant_id, label, poles, block_size, app_version, per_second_counts, focus_marks}`. Returns `{accepted, id, goal_n, goal_hits, goal_z, goal_p, base_chi2, base_p, flags}`. |
| `GET` | `/api/totals` | Per label (`Human`, `Both`, `Control`): sessions, seconds, goal draws, goal hits, Stouffer z (weighted by draws) and one-sided p. Served from an hourly snapshot. |
| `GET` | `/api/results` | For `results.html`: top-10 boards (best overall by Stouffer z, ids with ≥ 30 min focus; best single run, corrected for the number of runs, runs ≥ 60 s) for participants (Human + Both) and Control, each with a luck line; cumulative z per label by day; funnel points (draws, z) per id. Ids are shown only as `sha256(id)[0:6]`. Served from an hourly snapshot. |

Gatekeeping: the `Origin` must be `https://dgrapov.github.io` or `http://localhost:<port>`, and every POST
carries a Cloudflare Turnstile token that the Worker verifies with `TURNSTILE_SECRET`; siteverify must report the hostname `dgrapov.github.io` (skipped only for test secrets, which are themselves refused for any `https://` origin). Errors are short codes
only: `bad_origin` (403), `bad_token` (403), `bad_input` (400, or 413 for a body over 1 MB).

The Worker recomputes every statistic from the raw per-second counts; client numbers are never trusted.
Stored per session: a random participant id, the label, pole count, counts, focus marks and the recomputed
stats. No IP addresses, user agents or names.

## Files

- `src/index.ts` router, CORS, Turnstile check, handlers
- `src/stats.ts` normal CDF, chi-square survival, session scoring, Stouffer (pure)
- `src/results.ts` leaderboards, luck line, cumulative z and funnel for `/api/results` (pure)
- `src/validate.ts` input checks and the origin allowlist (pure)
- `src/sql.ts` statements for the summary tables and snapshots
- `schema.sql` the `sessions` table, summary tables, snapshots and the MCP tables; `migrate-summary.sql` rebuilds the (web-only) summaries
- `migrations/0002-agents.sql` one-off: agent labels and MCP tables on a database made before them
- `src/mcp.ts`, `src/mcp-core.ts`, `src/mcp-sql.ts`, `wrangler.mcp.jsonc` the MCP Worker
- `test/*.test.ts` unit tests (vitest); `test/local-api.mjs` scripted checks against `wrangler dev`

## Run locally (no Cloudflare account needed)

```bash
npm install
npm test                       # unit tests
npm run db:local               # create the local D1 table (.wrangler/state, git-ignored)
npm run dev:test               # wrangler dev on :8787 with Cloudflare's always-pass Turnstile test secret
npm run test:local             # in another terminal: accept / bad origin / bad token / bad input / totals
```

For the always-fail token case, also run
`npx wrangler dev --port 8788 --inspector-port 9230 --persist-to /tmp/ff-fail --var TURNSTILE_SECRET:2x0000000000000000000000000000000AA`.

Then serve the site from the repo root, e.g. `python3 -m http.server 8000`, and open
`http://localhost:8000/` (use `localhost`, not `127.0.0.1`). On localhost the page talks to
`http://localhost:8787` and uses Turnstile's test site key automatically.

Clean up test rows:
`npx wrangler d1 execute focus-field-db --local --command "DELETE FROM sessions WHERE participant_id LIKE 'test-%'"`

Test keys are from https://developers.cloudflare.com/turnstile/troubleshooting/testing/. The Worker refuses
to accept a test secret for any `https://` origin, so a test secret left in production fails closed.

## Deploy (needs the Cloudflare account)

```bash
npx wrangler login
npx wrangler d1 create focus-field-db      # put the database_id into wrangler.jsonc
npm run db:remote
npx wrangler secret put TURNSTILE_SECRET   # typed by hand, never stored in a file
npx wrangler deploy
```

Put the real Turnstile site key in `wrangler.jsonc` (`vars.TURNSTILE_SITE_KEY`) and in `index.html`
(`TURNSTILE_SITE_KEY`). The site key is public; the secret is not.

## Notes: optimised for reads

D1's free plan allows 5 million rows read a day, so nothing a visitor does scans `sessions`:

- Each save runs one D1 batch (a single transaction): the session row plus upserts into three small summary
  tables, `agg_id_poles`, `agg_day` and `agg_runs` (see `src/sql.ts`). They grow with people and days, not sessions.
- A cron trigger (`7 * * * *` in `wrangler.jsonc`) rebuilds `/api/totals` and `/api/results` from the summary tables
  into the `snapshots` table once an hour. If no snapshot exists yet, the first GET builds one.
- GET endpoints read one snapshot row, memoised per Worker copy for 5 minutes, and send `Cache-Control: max-age=600`.
  Pages poll every 10 minutes.
- `migrate-summary.sql` creates the summary tables and rebuilds them from `sessions`. Run it once on an existing
  database, and again any time to recompute from scratch. `test/summary.test.ts` checks, in SQLite, that the
  per-save upserts equal that rebuild.
- Test the cron locally: `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=7+*+*+*+*"`.

## MCP server (focus-field-mcp)

A second Worker, `src/mcp.ts` with `wrangler.mcp.jsonc`, on the same D1 database. URL: `https://focus-field-mcp.dgrapov.workers.dev/mcp`.
It is stateless MCP over streamable HTTP: every request is a JSON-RPC POST answered with `application/json`, with no SSE stream and no MCP session ids. `GET /` returns a short description and the connect command.

| Tool | Does |
|---|---|
| `register(agent?)` | Issues an anonymous key `ffk_…`. Only its SHA-256 is stored. |
| `get_methods(key)` | The active rows of `mcp_methods` (`menu_version`, id, name, instruction), with results per method |
| `start_session(key, method, custom_description?, poles=2, blocks=20)` | Fixes the blocks (even, 10–100), method, menu version and 1,000 draws per block; shuffles exactly half as rest |
| `begin_block(key, session_id)` | Next block: focus → goal pole; rest → a hidden shadow pole and a neutral task. Nothing drawn. Calling it again returns the same open block. |
| `draw_block(key, session_id, block_id, attention_log, self_rating?)` | Refuses blocks that were not begun or were already drawn, and calls with no log (or no 1–5 rating on a focus block). **Then** draws, stores the block, and updates the session and `agg_method` |
| `finish_session(key, session_id, reflection?)` | Closes the session; undrawn blocks are dropped |
| `get_totals()` | Agents by label and by method, plus the human totals snapshot |

Prompt `focus_field_protocol` holds the protocol text. The full spec is `dev/MCP-ATTENTION-PROTOCOL.md`, kept locally.

**Data.** Agent sessions are rows in `sessions` with `source = 'mcp'`, label `AI-public`, or `AI` for a key marked `trusted = 1` by hand. Each block is a row in `mcp_blocks`: kind, pole, `begun_at`, `drawn_at`, `attend_ms`, counts, hits, `attention_log`, `self_rating`. Agent sessions never enter `agg_id_poles`, `agg_day` or `agg_runs`, and `migrate-summary.sql` rebuilds from web labels only. Agent results are summed per drawn block in `agg_method(label, method, menu_version, kind, poles)`.

**Scoring.**
- Focus z: hits on goal poles. Rest z: hits on shadow poles, same formula.
- Per method: Stouffer over pole counts, and focus − rest as (z_f − z_r)/√2.

**Guards.**
- Keys go in tool arguments, so an agent can register and continue in one conversation.
- An `Origin` header, if sent, must be the site or localhost.
- Requests are capped at 64 KB.
- An open session idle for 30 minutes is closed as `abandoned`: its drawn blocks still count, and an undrawn block is dropped.
- Daily caps, kept in `mcp_usage`: `MCP_MAX_KEYS_PER_DAY`, `MCP_MAX_SESSIONS_PER_DAY`, `MCP_MAX_BLOCKS_PER_DAY` (8,000 ≈ 40,000 of the 100,000 free row writes), sessions per key, and open sessions per key.
- `MCP_REGISTRATION: "closed"` stops new keys.

**Methods menu.** The menu is data: edit `mcp_methods` rows, insert a new `menu_version`, then set the old rows' `active = 0`. Results are kept per menu version.

```bash
npx wrangler d1 execute focus-field-db --local --file=./migrations/0002-agents.sql   # once, on an existing local db
npx wrangler dev -c wrangler.mcp.jsonc --port 8790                                 # local MCP server
claude mcp add --transport http focus-field-local http://localhost:8790/mcp         # or use --mcp-config for one run

# production, in this order:
npx wrangler d1 execute focus-field-db --remote --file=./migrations/0002-agents.sql
npx wrangler deploy -c wrangler.mcp.jsonc
```

Admin by SQL:
- Mark Harold's key trusted: `UPDATE agent_keys SET trusted = 1 WHERE id = '<key_id>'`.
- Revoke a key: `UPDATE agent_keys SET revoked = 1 WHERE id = '…'`.

