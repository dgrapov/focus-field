# Handoff: Focus Field backend, phase 1 (for the WSL Claude Code agent)

**From:** Claude (cloud session) · **For:** Claude Code on Harold's WSL Ubuntu · **Date:** 2026-11-11
**Plan doc (human-readable, may not be reachable from WSL):** https://claude.ai/artifact/FuPDW1sLrkzkERYM86kWNY
Everything you need is in this file; the plan doc is background.

## 1. What this is

Focus Field is a static two-page site that runs a live random stream (500 draws/s from `crypto.getRandomValues`) split between 2 and 8 poles. A person focuses on one pole and the page measures drift against chance. It tests the (unproven) idea that attention can nudge randomness.

- **Repo:** https://github.com/dgrapov/focus-field (branch `main`)
- **Live site:** https://dgrapov.github.io/focus-field/ (GitHub Pages, deploys from `main`, repo root)
- **Files:** `index.html` (the tool, one self-contained file), `about.html`, `assets/`, `README.md`, `marketing/`

## 2. Your job: phase 1, shared data

Build and deploy a Cloudflare Worker with a D1 (SQLite) database so sessions and trials from any browser are stored in one place, then wire the page to it.

**Out of scope now:** the `/mcp` server, the AI runner (phase 2), and server-generated random bits (phase 3). Structure the code so `/mcp` can be added to the same Worker later.

## 3. What Harold has already done

- Cloudflare account created.
- workers.dev subdomain: **`dgrapov`**. So the Worker named `focus-field-api` will be served at **`https://focus-field-api.dgrapov.workers.dev`**.

Harold must do these himself (browser or secrets); ask him in the terminal when you reach them:
- `npx wrangler login` (browser OAuth). In WSL, if no browser opens, give him the printed URL to paste into Windows Chrome.
- `npx wrangler secret put ADMIN_TOKEN`. **He types the value**; don't generate, echo, log or commit it.

## 4. Files to create

```
worker/
  package.json          # wrangler as devDependency; scripts: dev, deploy, db:local, db:remote
  wrangler.jsonc        # name focus-field-api, main src/index.ts, d1 binding DB -> focus-field-db
  schema.sql            # three tables below + indexes
  src/index.ts          # router, CORS, handlers, stats
  src/stats.ts          # z, p, Stouffer; pure functions, unit-tested
  test/stats.test.ts    # vitest, small
  README.md             # how to run and deploy
```

`wrangler.jsonc` essentials: `"name": "focus-field-api"`, `"main": "src/index.ts"`, a current `"compatibility_date"`, `"observability": {"enabled": true}`, and:

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "focus-field-db", "database_id": "<from wrangler d1 create>" }]
```

## 5. Schema (`schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- uuid issued at start
  participant_id TEXT NOT NULL,      -- random id per browser/agent, no PII
  label TEXT NOT NULL CHECK (label IN ('Human','AI','Both','Control')),
  poles INTEGER NOT NULL CHECK (poles IN (2,3,4,5,6,8)),
  app_version TEXT,
  rng_source TEXT NOT NULL DEFAULT 'browser-crypto',
  started_at TEXT NOT NULL,          -- server time at /start
  finished_at TEXT,                  -- server time at /finish; NULL = abandoned
  seconds INTEGER,
  per_second_counts TEXT,            -- JSON [[c0..cK-1], ...]
  focus_marks TEXT,                  -- JSON [f, ...], -1 = no focus, else pole index
  block_size INTEGER,
  block_votes TEXT,                  -- JSON {"n":..,"w":..,"ties":..} (client tally, informational)
  client_seed TEXT,                  -- the page's SHA-256 session seed
  complete INTEGER NOT NULL DEFAULT 0,
  goal_n INTEGER, goal_hits INTEGER, goal_z REAL, goal_p REAL,   -- recomputed by the Worker
  base_n INTEGER, base_chi2 REAL, base_p REAL,                    -- no-focus seconds, recomputed
  flags TEXT                         -- JSON list of plausibility warnings
);
CREATE TABLE IF NOT EXISTS trial_targets (
  id TEXT PRIMARY KEY, participant_id TEXT NOT NULL, label TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('random','one','zero','control')),
  target INTEGER,                    -- 1 or 0; for control: drawn but never sent to the client
  salt TEXT NOT NULL, commit_hash TEXT NOT NULL,   -- sha256(target + ':' + salt), hex
  issued_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL UNIQUE REFERENCES trial_targets(id),
  participant_id TEXT NOT NULL, label TEXT NOT NULL,
  length_s INTEGER NOT NULL, feedback TEXT NOT NULL CHECK (feedback IN ('live','hidden')),
  n INTEGER NOT NULL, ones INTEGER NOT NULL, hits INTEGER NOT NULL, z REAL NOT NULL,
  submitted_at TEXT NOT NULL, flags TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_label ON sessions(label, complete);
CREATE INDEX IF NOT EXISTS idx_sessions_participant ON sessions(participant_id, started_at);
CREATE INDEX IF NOT EXISTS idx_trials_label ON trials(label);
```

## 6. API contract

All JSON. CORS: allow origins `https://dgrapov.github.io` and `http://localhost:*`, methods GET/POST/OPTIONS, header `content-type`. Reject bodies over 2 MB.

| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/session/start` | `{participant_id, label, poles, app_version}` → `{session_id, started_at}`. Records the start immediately, so abandoned sessions are visible. |
| POST | `/api/session/finish` | `{session_id, participant_id, per_second_counts, focus_marks, block_size, block_votes, client_seed, complete}` → `{accepted, stats:{goal_n, goal_hits, goal_z, goal_p, base_chi2, base_p}, flags}`. One finish per session id. |
| POST | `/api/trial/target` | `{participant_id, label, mode}` → `{target_id, target, commit, issued_at}`. `target` is `null` when mode is `control`. Random targets use `crypto.getRandomValues` in the Worker. |
| POST | `/api/trial/result` | `{target_id, participant_id, length_s, feedback, n, ones}` → `{accepted, hits, z, target, salt}` (the reveal). Hits computed by the Worker from `ones`, `n` and the stored target; for control, hits = ones. One result per target. |
| GET | `/api/totals` | Per label: sessions (complete / abandoned), focus seconds, goal draws, goal hits, combined z and p; trials: count, bits, z. Cache 60 s (Cache API). |
| GET | `/api/export?format=json\|csv&table=sessions\|trials` | All rows. Never expose `salt` or `target` of an **unused** trial target. |
| GET | `/api/health` | `{ok:true, version}` |

## 7. Statistics (recompute server-side, never trust client numbers)

- Per session with K poles, p = 1/K. For each second i with focus f ≥ 0: goal_n += sum(counts_i), goal_hits += counts_i[f]. Then `z = (hits − n·p) / sqrt(n·p·(1−p))`, one-sided `p = 1 − Φ(z)`.
- Baseline: seconds with f = −1, pooled counts per pole, chi-square vs uniform, df = K − 1.
- Trials: p = 1/2, `z = (hits − n/2) / sqrt(n/4)`.
- Totals across sessions (mixed K): Stouffer weighted by draws, `Z = Σ z_i·√n_i / √Σ n_i`, over **complete** sessions with goal_n > 0. Report abandoned counts separately; never drop them silently.
- Put these in `src/stats.ts` with tests: a known count gives a known z, and Φ is accurate to about 1e-6 (erf approximation is fine).

## 8. Plausibility checks (flag, and reject only the gross ones)

- Each second's counts sum to about 500: flag outside 450–550; reject if any second is outside 0–2000.
- `seconds ≤ (finish − start) + 10 s`, else reject.
- `per_second_counts.length === focus_marks.length`; poles match the start record; marks in −1..K−1.
- Trial `n` within ±15 % of `length_s × 500`; result arrives no sooner than `length_s` after the target was issued, else reject.
- Rate limit: at most 60 session starts and 600 trial targets per participant per hour (count in D1); return 429 when over.

## 9. Page changes (`index.html`)

Keep the existing look, layout and randomizer exactly as they are. Add:

1. `const API_BASE = 'https://focus-field-api.dgrapov.workers.dev';` near the top of the script.
2. A random `participant_id` made once and kept in localStorage (`focusfield.pid`), wrapped in try/catch like the existing storage helpers.
3. A **"Share my sessions"** switch in the Focus panel, **off by default**, remembered in localStorage. When off, nothing is sent. A one-line note beside it: what is shared (counts, focus marks, random id) and a link to About.
4. When sharing is on:
   - **Start** (first start of a session) calls `/api/session/start` and keeps the `session_id`.
   - **Finish & analyse** calls `/api/session/finish` with the full per-second rows and marks (the page already has `sess.sec`; rows are `[c0..cK-1, focus]`). Show the server's z and p beside the local report.
   - **Discard** of a started shared session calls finish with `complete:false`.
   - **Trials:** each trial gets its target from `/api/trial/target` instead of picking locally, and posts `/api/trial/result` after. Show the commit hash during the trial and the reveal after.
5. A participant label picker beside the share switch: Human (default) · Both · Control. AI comes only from the runner in phase 2.
6. Offline-safe: if the API fails, keep the session locally, mark it unsent, retry on the next load, and say so in `fMsg`.
7. A new plot card, **"Everyone"**, in the plot grid (same pattern as the others: `.plot` section, `data-act` buttons, registered in `PNAME`/`P0`/`redrawFor`). It shows combined z per label from `/api/totals` against ±1.96, refreshed every 60 s.
8. About page: add a short "Data and privacy" section matching the switch's wording.

Bump an `APP_VERSION` constant and send it as `app_version`.

## 10. Deploy steps

```bash
cd ~/focus-field && git pull            # clone first if needed
cd worker && npm install
npx wrangler login                      # Harold: browser auth
npx wrangler whoami
npx wrangler d1 create focus-field-db   # put the database_id in wrangler.jsonc
npx wrangler d1 execute focus-field-db --local  --file=./schema.sql
npx wrangler d1 execute focus-field-db --remote --file=./schema.sql
npx wrangler secret put ADMIN_TOKEN     # Harold types it
npx wrangler dev                        # test against http://localhost:8787
npx wrangler deploy                     # -> https://focus-field-api.dgrapov.workers.dev
```

## 11. Verify before you report done

- [ ] `npx vitest run` passes for `src/stats.ts`.
- [ ] Health: `curl https://focus-field-api.dgrapov.workers.dev/api/health` returns `ok`.
- [ ] A scripted session (start → finish with 30 synthetic seconds) is accepted, and `/api/totals` reflects it. **Label test rows `Control` with participant_id `test-…`** and delete them after: `npx wrangler d1 execute focus-field-db --remote --command "DELETE FROM sessions WHERE participant_id LIKE 'test-%'"` (same for trials and trial_targets).
- [ ] A trial round trip: target → result → reveal, and `sha256(target:salt)` matches the commit.
- [ ] Rejection cases return 4xx: a second finish, a future-dated trial, bad poles.
- [ ] CORS: the live page (after push) can call the API with sharing on; a request from another origin is refused.
- [ ] The page with sharing **off** sends nothing (check the network tab in DevTools).

## 12. Rules

- Don't change the randomizer, the stats shown locally, or the layout beyond the additions above.
- No secrets or account ids in the repo except `database_id`, which is not secret.
- Commit to `main` in small commits. GitHub Pages redeploys on push; check the live site after.
- If something in this brief turns out wrong (a Wrangler flag, a limit), do the sensible thing and note it in your report rather than stopping.

## 13. Report back

Append a short note to this file under "## Done", and tell Harold in the terminal:
- the Worker URL and the commit hashes;
- what you tested and the results;
- anything left for him or for the cloud Claude session (for example, phase 2).
