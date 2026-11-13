# focus-field-api

Shared-data backend for Focus Field: one Cloudflare Worker and one D1 (SQLite) table.
Live URL once deployed: `https://focus-field-api.dgrapov.workers.dev`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/session` | One finished session. Body (max 1 MB): `{turnstile_token, participant_id, label, poles, block_size, app_version, per_second_counts, focus_marks}`. Returns `{accepted, id, goal_n, goal_hits, goal_z, goal_p, base_chi2, base_p, flags}`. |
| `GET` | `/api/totals` | Per label (`Human`, `Both`, `Control`): sessions, seconds, goal draws, goal hits, Stouffer z (weighted by draws) and one-sided p. Cached 60 s. |
| `GET` | `/api/results` | For `results.html`: top-10 boards (best overall by Stouffer z, ids with ≥ 30 min focus; best single run, corrected for the number of runs, runs ≥ 60 s) for participants (Human + Both) and Control, each with a luck line; cumulative z per label by day; funnel points (draws, z) per id. Ids are shown only as `sha256(id)[0:6]`. Cached 60 s. |

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
- `schema.sql` the `sessions` table
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

## Notes

- `/api/totals` sums per (label, poles) inside D1 and combines with `stoufferFromGroups`, so no session rows
  leave the database. The query still scans the table; D1 bills rows read, so the 60 s cache matters.
- The Cache API does nothing on `*.workers.dev`, so totals are also memoised per isolate for 60 s and sent
  with `Cache-Control: max-age=60`.
