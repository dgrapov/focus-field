// Scripted checks against a local `wrangler dev` (handoff step 4). No Cloudflare account needed.
//   terminal 1: npm run dev:test                       (always-pass Turnstile test secret, port 8787)
//   terminal 2: npx wrangler dev --port 8788 --var TURNSTILE_SECRET:2x0000000000000000000000000000000AA
//               (always-fail test secret, for the bad-token case; optional, skipped if not running)
//   terminal 3: npm run test:local
// Test rows use label Control and participant_id test-…; delete them afterwards, then rebuild the summaries:
//   npx wrangler d1 execute focus-field-db --local --command "DELETE FROM sessions WHERE participant_id LIKE 'test-%'"
//   npx wrangler d1 execute focus-field-db --local --file=./migrate-summary.sql

const BASE = process.env.API || 'http://localhost:8787';
const FAIL_BASE = process.env.API_FAIL || 'http://localhost:8788';
const ORIGIN = 'http://localhost:8000';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';   // Cloudflare's dummy token, what the test site keys hand out

let pass = 0, failN = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log('  ok   ' + name); } else { failN++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); } };

function session(over = {}) {
  // 30 synthetic seconds at 2 poles: 20 focus seconds on pole 0 leaning +10, 10 no-focus seconds even
  const counts = [], marks = [];
  for (let i = 0; i < 30; i++) { if (i < 20) { counts.push([260, 240]); marks.push(0); } else { counts.push([250, 250]); marks.push(-1); } }
  return { turnstile_token: TOKEN, participant_id: 'test-' + Math.random().toString(36).slice(2, 12), label: 'Control', poles: 2,
    block_size: 25, app_version: 'test', per_second_counts: counts, focus_marks: marks, ...over };
}
const post = (body, origin = ORIGIN, base = BASE) => fetch(base + '/api/session', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const totals = (origin) => fetch(BASE + '/api/totals', { headers: origin ? { Origin: origin } : {} });
const control = t => t.labels.find(l => l.label === 'Control');

console.log('Focus Field API, local checks against ' + BASE);

// totals before
let r = await totals(ORIGIN); const t0 = await r.json();
ok(r.status === 200 && Array.isArray(t0.labels) && t0.labels.length === 3, 'GET /api/totals returns three labels');
ok(r.headers.get('access-control-allow-origin') === ORIGIN, 'totals echoes an allowed Origin');

// accept
r = await post(session()); let j = await r.json();
const expectZ = (20 * 260 - 20 * 500 / 2) / Math.sqrt(20 * 500 / 4);   // 200/50 = 4
ok(r.status === 200 && j.accepted === true && typeof j.id === 'string', 'accepts a valid session', JSON.stringify(j));
ok(j.goal_n === 10000 && j.goal_hits === 5200 && Math.abs(j.goal_z - expectZ) < 1e-9, 'server recomputes goal n/hits/z', `z=${j.goal_z}`);
ok(j.base_chi2 === 0 && j.base_p === 1, 'server recomputes baseline chi-square');
ok(Array.isArray(j.flags) && j.flags.length === 0, 'no flags for 500 draws/s');
ok(r.headers.get('access-control-allow-origin') === ORIGIN, 'POST echoes an allowed Origin');

// flags without rejection
r = await post(session({ per_second_counts: Array(30).fill([300, 300]) })); j = await r.json();
ok(r.status === 200 && j.flags && j.flags[0] === 'rate_outside_450_550:30', 'odd rates are flagged, not rejected', JSON.stringify(j));

// totals are rebuilt hourly by cron; trigger that rebuild now (needs `wrangler dev --test-scheduled`, which dev:test passes)
r = await totals(); const tBefore = await r.json();
ok(tBefore.updated_at === t0.updated_at, 'totals do not change on save (served from the hourly snapshot)');
r = await fetch(BASE + '/__scheduled?cron=7+*+*+*+*');
ok(r.status === 200, 'scheduled rebuild runs');
await new Promise(res => setTimeout(res, 500));
r = await totals(); const t1 = await r.json();
ok(control(t1).sessions === control(t0).sessions + 2, 'totals counts the new sessions', `${control(t0).sessions} -> ${control(t1).sessions}`);
ok(control(t1).goal_n === control(t0).goal_n + 10000 + 12000, 'totals adds goal draws (20 s × 500 + 20 s × 600)');
ok(typeof control(t1).z === 'number' && typeof control(t1).p === 'number', 'totals has a combined z and p');
r = await totals(); const t2 = await r.json();
ok(t2.updated_at === t1.updated_at, 'a second read is served from the same snapshot');
r = await fetch(BASE + '/api/results', { headers: { Origin: ORIGIN } }); j = await r.json();
ok(r.status === 200 && j.overall && j.single_run && j.cumulative, 'GET /api/results returns boards and the running total');

// bad origin
r = await post(session(), 'https://evil.example'); j = await r.json();
ok(r.status === 403 && j.error === 'bad_origin' && !r.headers.get('access-control-allow-origin'), 'other origin → 403 bad_origin, no CORS header');
r = await post(session(), null); j = await r.json();
ok(r.status === 403 && j.error === 'bad_origin', 'missing Origin → 403 bad_origin');
r = await post(session(), 'https://dgrapov.github.io.evil.example'); j = await r.json();
ok(r.status === 403 && j.error === 'bad_origin', 'look-alike origin → 403');
r = await totals('https://evil.example');
ok(r.status === 403, 'totals from another origin → 403');
r = await fetch(BASE + '/api/session', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
ok(r.status === 204 && r.headers.get('access-control-allow-origin') === ORIGIN && /POST/.test(r.headers.get('access-control-allow-methods') || ''), 'preflight from allowed origin → 204');
r = await fetch(BASE + '/api/session', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
ok(r.status === 403 && !r.headers.get('access-control-allow-origin'), 'preflight from other origin → 403');

// bad token
r = await post(session(), 'https://dgrapov.github.io'); j = await r.json();
ok(r.status === 403 && j.error === 'bad_token', 'a test secret never verifies the real site (https origin) → bad_token');
try {
  r = await post(session(), ORIGIN, FAIL_BASE); j = await r.json();
  ok(r.status === 403 && j.error === 'bad_token', 'always-fail test secret → 403 bad_token');
} catch { console.log('  skip always-fail secret check (nothing on ' + FAIL_BASE + ')'); }

// bad input
const badCases = [
  ['poles 9', session({ poles: 9 })], ['label AI', session({ label: 'AI' })], ['short participant id', session({ participant_id: 'x' })],
  ['length mismatch', session({ focus_marks: [0] })], ['row width ≠ poles', session({ poles: 3 })], ['second sums > 2000', session({ per_second_counts: Array(30).fill([1500, 501]) })],
  ['mark out of range', session({ focus_marks: Array(30).fill(2) })], ['negative count', session({ per_second_counts: Array(30).fill([-1, 501]) })],
  ['empty token', session({ turnstile_token: '' })], ['not JSON', '{nope'],
];
for (const [name, body] of badCases) { r = await post(body); j = await r.json(); ok(r.status === 400 && j.error === 'bad_input' && Object.keys(j).length === 2, 'bad input: ' + name + ' → 400 bad_input'); }
const big = JSON.stringify(session({ app_version: 'x', pad: 'y'.repeat(1_000_001) }));
r = await post(big); j = await r.json();
ok(r.status === 413 && j.error === 'bad_input', 'body over 1 MB → 413 bad_input');

// routing
r = await fetch(BASE + '/api/session', { headers: { Origin: ORIGIN } }); ok(r.status === 405, 'GET /api/session → 405');
r = await fetch(BASE + '/nope'); ok(r.status === 404, 'unknown path → 404');

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
