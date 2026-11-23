// /enroll: the optional owner route behind Cloudflare Access. Real RS256 JWTs (WebCrypto) against preloaded keys,
// real SQLite (node:sqlite) with the live schema + migrations; the public MCP path is checked to be unchanged.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleHttp, handleRpc, type D1Database, type McpEnv } from '../src/mcp';
import enrollWorker, { _setJwks, _setFetch, verifyAccess, enrollEnabled, makeSession, verifySession } from '../src/enroll';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const TEAM = 'https://ffteam.cloudflareaccess.com', AUD = 'aud-tag-123', ADMIN = 'owner@example.com', ORIGIN = 'https://mcp.test';

function d1(db: DatabaseSync): D1Database {
  return { prepare(sql: string) { let params: unknown[] = []; const st = () => db.prepare(sql); const p = {
    bind(...v: unknown[]) { params = v; return p; },
    async run() { const r = st().run(...(params as never[])); return { meta: { changes: Number(r.changes) } }; },
    async all<T>() { return { results: st().all(...(params as never[])) as T[] }; },
    async first<T>() { return ((st().get(...(params as never[])) as T) ?? null); } }; return p; } };
}
const b64url = (b: Uint8Array | string) => Buffer.from(typeof b === 'string' ? b : b).toString('base64url');
let priv: CryptoKey, otherPriv: CryptoKey;
async function jwt(claims: Record<string, unknown>, key = priv, kid = 'k1') {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid })), body = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body)));
  return `${head}.${body}.${b64url(sig)}`;
}
const good = (over: Record<string, unknown> = {}) => jwt({ iss: TEAM, aud: [AUD], email: ADMIN, exp: Math.floor(Date.now() / 1000) + 600, ...over });

let db: DatabaseSync, env: McpEnv & Record<string, any>, n = 0;
const req = async (path: string, init: { method?: string; token?: string | null; body?: unknown; origin?: string | null; cookie?: boolean } = {}) => {
  const h: Record<string, string> = {};
  const token = init.token === undefined ? await good() : init.token;
  if (token) { if (init.cookie) h.Cookie = `CF_Authorization=${token}`; else h['Cf-Access-Jwt-Assertion'] = token; }
  if (init.body !== undefined) h['content-type'] = 'application/json';
  if (init.origin !== null) h.Origin = init.origin ?? ORIGIN;
  return enrollWorker.fetch(new Request(ORIGIN + path, { method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers: h, body: init.body !== undefined ? JSON.stringify(init.body) : undefined }), env);
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await handleRpc({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }, env);
  const res = (r as any).result; return { ...res.structuredContent, isError: !!res.isError } as Record<string, any>;
};

beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const kp2 = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  priv = kp.privateKey; otherPriv = kp2.privateKey;
  _setJwks(TEAM, [{ ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' }]);
});
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(read('./fixtures/schema-3acfde9.sql')); db.exec(read('../migrations/0002-agents.sql')); db.exec(read('../migrations/0003-access-tiers.sql'));
  env = { DB: d1(db), ACCESS_TEAM_DOMAIN: TEAM + '/', ACCESS_AUD: AUD, ENROLL_ADMIN_EMAILS: ` ${ADMIN.toUpperCase()} , x@example.com` };
});

describe('Access JWT', () => {
  it('accepts a valid admin token and rejects everything else', async () => {
    expect(await verifyAccess(env, await good())).toBe(ADMIN);
    expect(await verifyAccess(env, await good({ email: 'stranger@example.com' }))).toBeNull();      // not an admin
    expect(await verifyAccess(env, await good({ aud: ['other-app'] }))).toBeNull();
    expect(await verifyAccess(env, await good({ iss: 'https://evil.cloudflareaccess.com' }))).toBeNull();
    expect(await verifyAccess(env, await good({ exp: Math.floor(Date.now() / 1000) - 5 }))).toBeNull();
    expect(await verifyAccess(env, await jwt({ iss: TEAM, aud: [AUD], email: ADMIN, exp: 9e9 }, otherPriv))).toBeNull();   // wrong signer, same kid
    const t = await good(); expect(await verifyAccess(env, t.slice(0, -4) + 'AAAA')).toBeNull();
    expect(await verifyAccess(env, 'not.a.jwt')).toBeNull();
    expect(await verifyAccess(env, null)).toBeNull();
    expect(await verifyAccess({ DB: env.DB }, await good())).toBeNull();                               // route not configured
  });
});

describe('/enroll is optional', () => {
  it('the MCP host has no /enroll route at all', async () => {
    expect((await handleHttp(new Request(ORIGIN + '/enroll'), env)).status).toBe(404);
  });
  it('is 404 when Access is not configured, and /mcp works as before', async () => {
    env = { DB: env.DB };
    expect(enrollEnabled(env)).toBe(false);
    expect((await req('/enroll')).status).toBe(404);
    expect((await req('/enroll/api/code', { body: { tier: 'owner' } })).status).toBe(404);
    const reg = await call('register', {});
    expect(reg).toMatchObject({ isError: false, tier: 'public', limits: { sessions_per_key: 10 } });
  });
  it('refuses requests without a valid Access token', async () => {
    expect((await req('/enroll', { token: null })).status).toBe(403);
    expect((await req('/enroll', { token: await good({ email: 'stranger@example.com' }) })).status).toBe(403);
    expect((await req('/enroll/api/code', { token: null, body: { tier: 'owner' } })).status).toBe(403);
  });
});

describe('/enroll page and API', () => {
  it('serves the page with a strict CSP, via header or cookie', async () => {
    for (const cookie of [false, true]) {
      const r = await req('/enroll', { cookie });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(await r.text()).toContain('Focus Field: enroll agents');
    }
  });
  it('state-changing calls need same-origin JSON', async () => {
    expect((await req('/enroll/api/code', { body: { tier: 'owner' }, origin: 'https://evil.example' })).status).toBe(403);
    expect((await req('/enroll/api/code', { body: { tier: 'owner' }, origin: null })).status).toBe(403);
  });
  it('mints a one-time owner code that an agent redeems once', async () => {
    const r = await (await req('/enroll/api/code', { body: { tier: 'owner', name: 'laptop' } })).json() as any;
    expect(r).toMatchObject({ tier: 'owner', name: 'laptop', uses: 1 });
    expect(r.code).toMatch(/^ffc_[0-9a-f]{32}$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM enroll_codes').all())).not.toContain(r.code);       // only the hash is stored
    expect(q('SELECT created_by FROM enroll_codes').created_by).toBe(ADMIN);
    const reg = await call('register', {});
    expect(await call('redeem_code', { key: reg.key, access_code: r.code })).toMatchObject({ tier: 'owner' });
    expect(q('SELECT tier, code_name, trusted FROM agent_keys')).toEqual({ tier: 'owner', code_name: 'laptop', trusted: 1 });
    expect((await call('start_session', { key: reg.key, method: 'intent' })).label).toBe('AI');
    expect((await call('register', { access_code: r.code })).error).toContain('not recognised');           // used up
  });
  it('codes expire, can be revoked, and verified codes can be used several times', async () => {
    const v = await (await req('/enroll/api/code', { body: { tier: 'verified', name: 'lab-a', uses: 2, ttl_minutes: 60 } })).json() as any;
    expect((await call('register', { access_code: v.code })).tier).toBe('verified');
    await req('/enroll/api/revoke-code', { body: { id: v.id } });
    expect((await call('register', { access_code: v.code })).error).toContain('not recognised');
    const o = await (await req('/enroll/api/code', { body: { tier: 'owner' } })).json() as any;
    db.prepare("UPDATE enroll_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(o.id);
    expect((await call('register', { access_code: o.code })).error).toContain('not recognised');
    expect((await (await req('/enroll/api/code', { body: { tier: 'owner', ttl_minutes: 99999 } })).json() as any).error).toContain('ttl_minutes');
    expect((await (await req('/enroll/api/code', { body: { tier: 'public' } })).json() as any).error).toContain('tier');
    expect((await (await req('/enroll/api/code', { body: { tier: 'verified' } })).json() as any).error).toContain('name');
  });
  it('lists keys and codes (never values), revokes keys and sets tiers', async () => {
    const reg = await call('register', { agent: 'claude-test' });
    const s = await (await req('/enroll/api/state')).json() as any;
    expect(s.you).toBe(ADMIN);
    expect(s.keys[0]).toMatchObject({ id: reg.key_id, agent: 'claude-test', tier: 'public', sessions: 0 });
    expect(JSON.stringify(s)).not.toContain('key_hash');
    await req('/enroll/api/key', { body: { key_id: reg.key_id, tier: 'verified' } });
    expect((await call('get_limits', { key: reg.key })).tier).toBe('verified');
    await req('/enroll/api/key', { body: { key_id: reg.key_id, revoked: true } });
    expect((await call('get_limits', { key: reg.key })).error).toContain('revoked');
    expect((await req('/enroll/api/key', { body: { key_id: reg.key_id, tier: 'admin' } })).status).toBe(400);
  });
});

const q = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as any;

describe('GitHub login', () => {
  const GH = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', ENROLL_GITHUB_USERS: 'DGrapov, id:999', ENROLL_SESSION_KEY: 'k'.repeat(40) };
  let ghUser: { login: string; id: number } | null, tokenOk: boolean, seen: { url: string; body?: string }[];
  beforeEach(() => {
    env = { DB: env.DB, ...GH };                                   // GitHub only, no Access
    ghUser = { login: 'dgrapov', id: 4242 }; tokenOk = true; seen = [];
    _setFetch((async (input: any, init?: any) => {
      const url = String(input); seen.push({ url, body: init?.body });
      if (url === 'https://github.com/login/oauth/access_token') return new Response(JSON.stringify(tokenOk ? { access_token: 'gho_x' } : { error: 'bad_verification_code' }), { headers: { 'content-type': 'application/json' } });
      if (url === 'https://api.github.com/user') return ghUser ? new Response(JSON.stringify(ghUser)) : new Response('{}', { status: 401 });
      return new Response('nope', { status: 404 });
    }) as typeof fetch);
  });
  const get = (path: string, cookie = '') => enrollWorker.fetch(new Request(ORIGIN + path, { headers: cookie ? { Cookie: cookie } : {} }), env);
  async function signIn() {
    const r = await get('/enroll/login');
    const state = new URL(r.headers.get('location')!).searchParams.get('state')!;
    const stateCookie = /ff_oauth_state=([^;]+)/.exec(r.headers.get('set-cookie')!)![1];
    return get(`/enroll/callback?code=abc&state=${state}`, `ff_oauth_state=${stateCookie}`);
  }
  const sessionOf = (r: Response) => /ff_enroll=([^;]+)/.exec((r.headers as any).getSetCookie().join('\n'))?.[1] ?? null;

  it('shows a sign-in page, and redirects to GitHub with a state and the right callback', async () => {
    expect(enrollEnabled(env)).toBe(true);
    const page = await get('/enroll');
    expect(page.status).toBe(401); expect(await page.text()).toContain('Sign in with GitHub');
    const r = await get('/enroll/login');
    const to = new URL(r.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(to.searchParams.get('client_id')).toBe('cid');
    expect(to.searchParams.get('redirect_uri')).toBe(ORIGIN + '/enroll/callback');
    expect(to.searchParams.get('state')!.length).toBeGreaterThan(20);
    expect(r.headers.get('set-cookie')).toMatch(/ff_oauth_state=.*HttpOnly; Secure; SameSite=Lax/);
  });

  it('an allowed user gets a session and can use the page and API', async () => {
    const cb = await signIn();
    expect(cb.status).toBe(302); expect(cb.headers.get('location')).toBe(ORIGIN + '/enroll');
    const sess = sessionOf(cb)!; expect(sess).toBeTruthy();
    expect(seen[0].body).toContain('"client_secret":"csecret"');
    expect((await get('/enroll', `ff_enroll=${sess}`)).status).toBe(200);
    const st = await (await get('/enroll/api/state', `ff_enroll=${sess}`)).json() as any;
    expect(st.you).toBe('github:dgrapov');
    const mint = await enrollWorker.fetch(new Request(ORIGIN + '/enroll/api/code', { method: 'POST', headers: { Cookie: `ff_enroll=${sess}`, Origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ tier: 'owner' }) }), env);
    const code = (await mint.json() as any).code; expect(code).toMatch(/^ffc_/);
    expect(q('SELECT created_by FROM enroll_codes').created_by).toBe('github:dgrapov');
    expect((await call('register', { access_code: code })).tier).toBe('owner');
    // cross-site POST with a valid cookie is still refused
    const evil = await enrollWorker.fetch(new Request(ORIGIN + '/enroll/api/code', { method: 'POST', headers: { Cookie: `ff_enroll=${sess}`, Origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"tier":"owner"}' }), env);
    expect(evil.status).toBe(403);
  });

  it('refuses other users, a mismatched state, and a failed token exchange', async () => {
    ghUser = { login: 'someone-else', id: 1 };
    let r = await signIn(); expect(r.status).toBe(403); expect(await r.text()).toContain('not allowed'); expect(sessionOf(r)).toBeNull();
    ghUser = { login: 'renamed-me', id: 999 };                    // allowed by numeric id
    expect((await signIn()).status).toBe(302);
    ghUser = { login: 'dgrapov', id: 4242 };
    r = await get('/enroll/callback?code=abc&state=forged', 'ff_oauth_state=real'); expect(r.status).toBe(403);
    r = await get('/enroll/callback?code=abc&state=x'); expect(r.status).toBe(403);
    tokenOk = false; r = await signIn(); expect(r.status).toBe(403); expect(await r.text()).toContain('did not confirm');
  });

  it('sessions are signed, expire, and stop working if the user leaves the allow list or the key changes', async () => {
    const t = Date.now(), s = await makeSession(env, 'dgrapov', 4242, t);
    expect(await verifySession(env, s, t)).toBe('github:dgrapov');
    expect(await verifySession(env, s, t + 9 * 3600_000)).toBeNull();                      // 8 h
    const [body, sig] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ login: 'dgrapov', id: 4242, exp: t + 1e9 })).toString('base64url') + '.' + sig;
    expect(await verifySession(env, forged, t)).toBeNull();
    expect(await verifySession(env, body + '.AAAA', t)).toBeNull();
    expect(await verifySession({ ...env, ENROLL_SESSION_KEY: 'z'.repeat(40) }, s, t)).toBeNull();
    expect(await verifySession({ ...env, ENROLL_GITHUB_USERS: 'id:999' }, s, t)).toBeNull();
    expect(await verifySession({ ...env, ENROLL_SESSION_KEY: 'short' }, s, t)).toBeNull();   // a weak key switches GitHub login off
    const out = await get('/enroll/logout', `ff_enroll=${s}`);
    expect(out.headers.get('set-cookie')).toContain('ff_enroll=; Path=/enroll; Max-Age=0');
  });

  it('stays off without all four GitHub secrets, and Access still works alongside it', async () => {
    env = { DB: env.DB, ...GH, GITHUB_CLIENT_SECRET: undefined } as any;
    expect((await get('/enroll')).status).toBe(404);
    expect((await get('/enroll/login')).status).toBe(404);
    env = { DB: env.DB, ...GH, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ENROLL_ADMIN_EMAILS: ADMIN };
    const r = await enrollWorker.fetch(new Request(ORIGIN + '/enroll/api/state', { headers: { 'Cf-Access-Jwt-Assertion': await good() } }), env);
    expect((await r.json() as any).you).toBe(ADMIN);
  });
});
