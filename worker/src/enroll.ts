// /enroll: an OPTIONAL owner Worker (wrangler.enroll.jsonc, focus-field-enroll.dgrapov.workers.dev) on the same D1,
// for minting access codes from anywhere. It is a separate Worker so Cloudflare Access can cover its whole hostname
// without touching the public MCP host. It answers 404 unless ACCESS_TEAM_DOMAIN, ACCESS_AUD and ENROLL_ADMIN_EMAILS
// (Worker secrets) are all set. Cloudflare Access
// (Zero Trust, One-time PIN by email) sits in front of /enroll; this file re-checks Access's signed JWT on every
// request, so a request that skipped Access (or a forged header) gets nothing. The public /mcp endpoint and its
// limits do not change: codes only ever raise a key's tier through register(access_code) or redeem_code.
//
// Page:  GET  /enroll                       one self-contained HTML page (no external resources)
// API:   GET  /enroll/api/state             keys and codes (never code values or hashes)
//        POST /enroll/api/code              {tier, name, ttl_minutes, uses} -> {code} shown once
//        POST /enroll/api/revoke-code       {id}
//        POST /enroll/api/key               {key_id, revoked?: boolean, tier?: 'public'|'verified'|'owner'}

import type { D1Database } from './mcp';
import * as SQL from './mcp-sql';
import { hashKey, type Tier } from './mcp-core';

export interface EnrollEnv {
  DB: D1Database;
  ACCESS_TEAM_DOMAIN?: string;     // e.g. "https://<team>.cloudflareaccess.com"
  ACCESS_AUD?: string;             // the Access application's Audience (AUD) tag
  ENROLL_ADMIN_EMAILS?: string;    // comma-separated; must also be allowed by the Access policy
}

export const enrollEnabled = (env: EnrollEnv) => !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.ENROLL_ADMIN_EMAILS);

// ---------- Cloudflare Access JWT (RS256) ----------
type Jwk = JsonWebKey & { kid?: string };
let jwksCache: { team: string; at: number; keys: Jwk[] } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;
/** Tests only: preload the signing keys for a team domain. */
export function _setJwks(team: string, keys: Jwk[]) { jwksCache = { team, at: Date.now(), keys }; }

const teamOf = (env: EnrollEnv) => (env.ACCESS_TEAM_DOMAIN || '').replace(/\/+$/, '');
async function signingKeys(team: string, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.team === team && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const r = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('access certs ' + r.status);
  const keys = ((await r.json()) as { keys?: Jwk[] }).keys || [];
  jwksCache = { team, at: Date.now(), keys };
  return keys;
}
const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** The verified email of an Access JWT, or null. Checks signature, issuer, audience, expiry and the admin list. */
export async function verifyAccess(env: EnrollEnv, token: string | null, now = Date.now()): Promise<string | null> {
  if (!token || !enrollEnabled(env)) return null;
  const parts = token.split('.'); if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string }, claims: { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string };
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { return null; }
  if (header.alg !== 'RS256') return null;
  const team = teamOf(env);
  const verify = async (keys: Jwk[]) => {
    const jwk = keys.find(k => k.kid === header.kid); if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  };
  let ok = false;
  try { ok = await verify(await signingKeys(team)); if (!ok && !(jwksCache?.keys || []).some(k => k.kid === header.kid)) ok = await verify(await signingKeys(team, true)); }   // key rotation
  catch { return null; }
  if (!ok) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== team || !aud.includes(env.ACCESS_AUD) || typeof claims.exp !== 'number' || claims.exp * 1000 < now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 > now + 60_000) return null;
  const email = (claims.email || '').toLowerCase();
  const admins = (env.ENROLL_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return email && admins.includes(email) ? email : null;
}
const accessToken = (req: Request) => {
  const h = req.headers.get('Cf-Access-Jwt-Assertion'); if (h) return h;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get('Cookie') || ''); return m ? m[1] : null;
};

// ---------- codes stored in D1 ----------
export const OWNER_TTL_MAX = 24 * 60, VERIFIED_TTL_MAX = 90 * 24 * 60, USES_MAX = 100;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

/** Spend one use of a /enroll code. Returns its tier and name, or null (unknown, used up, expired or revoked). */
export async function spendEnrollCode(db: D1Database, code: string, now: Date): Promise<{ tier: Exclude<Tier, 'public'>; name: string } | null> {
  const h = await hashKey(code.trim());
  const res = await db.prepare(SQL.SPEND_ENROLL_CODE).bind(h, now.toISOString()).run();
  if (!res.meta || res.meta.changes !== 1) return null;
  return db.prepare(SQL.GET_ENROLL_CODE).bind(h).first<{ tier: 'verified' | 'owner'; name: string }>();
}

// ---------- HTTP ----------
type Obj = Record<string, unknown>;
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SEC } });
const notFound = () => json({ error: 'not_found' }, 404);

export async function handleEnroll(req: Request, env: EnrollEnv, now = new Date()): Promise<Response> {
  if (!enrollEnabled(env)) return notFound();                                     // the route is off unless configured
  const url = new URL(req.url);
  const email = await verifyAccess(env, accessToken(req), now.getTime());
  if (!email) return json({ error: 'forbidden: open /enroll through Cloudflare Access with an admin email' }, 403);

  if (req.method === 'GET' && url.pathname === '/enroll') return page();
  if (req.method === 'GET' && url.pathname === '/enroll/api/state') return json(await state(env, email));
  if (req.method !== 'POST') return notFound();
  // State-changing calls: same origin only, JSON only (no form posts from other sites).
  const origin = req.headers.get('Origin');
  if (origin !== url.origin || !(req.headers.get('content-type') || '').startsWith('application/json')) return json({ error: 'bad_origin' }, 403);
  let a: Obj; try { a = (await req.json()) as Obj; } catch { return json({ error: 'bad_json' }, 400); }
  if (!a || typeof a !== 'object') return json({ error: 'bad_json' }, 400);

  if (url.pathname === '/enroll/api/code') {
    const tier = a.tier === 'owner' ? 'owner' : a.tier === 'verified' ? 'verified' : null;
    if (!tier) return json({ error: 'tier: owner or verified' }, 400);
    const name = typeof a.name === 'string' && a.name ? a.name.trim().toLowerCase() : tier === 'owner' ? 'owner-' + now.toISOString().slice(0, 10) : '';
    if (!NAME_RE.test(name)) return json({ error: 'name: lowercase letters, digits and -, up to 32 characters' }, 400);
    const maxTtl = tier === 'owner' ? OWNER_TTL_MAX : VERIFIED_TTL_MAX;
    const ttl = a.ttl_minutes === undefined ? (tier === 'owner' ? 15 : 7 * 24 * 60) : Number(a.ttl_minutes);
    const uses = a.uses === undefined ? 1 : Number(a.uses);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > maxTtl) return json({ error: `ttl_minutes: 1 to ${maxTtl}` }, 400);
    if (!Number.isInteger(uses) || uses < 1 || uses > USES_MAX) return json({ error: `uses: 1 to ${USES_MAX}` }, 400);
    const code = 'ffc_' + hex(crypto.getRandomValues(new Uint8Array(16))), id = hex(crypto.getRandomValues(new Uint8Array(6)));
    const expires = new Date(now.getTime() + ttl * 60_000).toISOString();
    await env.DB.prepare(SQL.INSERT_ENROLL_CODE).bind(id, await hashKey(code), tier, name, email, now.toISOString(), expires, uses).run();
    return json({ code, id, tier, name, expires_at: expires, uses, how: 'Give the agent this code once: register(access_code) for a new key, or redeem_code(key, access_code) for an existing one.' });
  }
  if (url.pathname === '/enroll/api/revoke-code') {
    if (typeof a.id !== 'string' || !/^[0-9a-f]{12}$/.test(a.id)) return json({ error: 'id' }, 400);
    await env.DB.prepare(SQL.REVOKE_ENROLL_CODE).bind(a.id).run();
    return json({ ok: true });
  }
  if (url.pathname === '/enroll/api/key') {
    if (typeof a.key_id !== 'string' || !/^[0-9a-f]{12}$/.test(a.key_id)) return json({ error: 'key_id' }, 400);
    if (typeof a.revoked === 'boolean') await env.DB.prepare(SQL.SET_KEY_REVOKED).bind(a.key_id, a.revoked ? 1 : 0).run();
    if (a.tier !== undefined) {
      if (a.tier !== 'public' && a.tier !== 'verified' && a.tier !== 'owner') return json({ error: 'tier' }, 400);
      await env.DB.prepare(SQL.SET_TIER_ONLY).bind(a.key_id, a.tier, a.tier === 'owner' ? 1 : 0).run();
    }
    return json({ ok: true });
  }
  return notFound();
}

async function state(env: EnrollEnv, email: string) {
  const keys = (await env.DB.prepare(SQL.LIST_KEYS).all<Obj>()).results;
  const codes = (await env.DB.prepare(SQL.LIST_ENROLL_CODES).all<Obj>()).results;
  return { you: email, keys, codes };
}

function page(): Response {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Focus Field enroll</title><style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#fafaf7;--fg:#1d1d1b;--mut:#6b6b66;--line:#ddd;--acc:#2d6cdf}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ececea;--mut:#9a9a94;--line:#333;--acc:#7aa7ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:980px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}.mut{color:var(--mut)}
fieldset{border:1px solid var(--line);border-radius:8px;padding:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:end}
label{display:flex;flex-direction:column;font-size:13px;color:var(--mut)}input,select,button{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg)}
button{cursor:pointer;border-color:var(--acc);color:var(--acc)}#out{margin-top:10px;padding:10px;border:1px dashed var(--acc);border-radius:6px;display:none;word-break:break-all}
code{font:13px ui-monospace,monospace}.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
</style></head><body><main>
<h1>Focus Field: enroll agents</h1><p class="mut">Signed in as <b id="you">…</b>. Codes are shown once; only their hash is stored. Public agents are unaffected.</p>
<h2>New access code</h2><fieldset>
<label>Tier<select id="tier"><option value="owner">owner (label AI)</option><option value="verified">verified (AI-public, higher limits)</option></select></label>
<label>Name<input id="name" placeholder="laptop, lab-a" maxlength="32"></label>
<label>Expires in (minutes)<input id="ttl" type="number" min="1" value="15"></label>
<label>Uses<input id="uses" type="number" min="1" max="100" value="1"></label>
<button id="mint" type="button">Make code</button></fieldset>
<div id="out"></div>
<h2>Codes</h2><div class="tw" id="codes"></div>
<h2>Keys</h2><div class="tw" id="keys"></div>
</main><script nonce="${nonce}">
const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function post(p,b){const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json();}
$('tier').onchange=()=>{$('ttl').value=$('tier').value==='owner'?15:10080;};
$('mint').onclick=async()=>{const r=await post('/enroll/api/code',{tier:$('tier').value,name:$('name').value||undefined,ttl_minutes:+$('ttl').value,uses:+$('uses').value});
 const o=$('out');o.style.display='block';o.innerHTML=r.code?'<b>Code (copy now, shown once):</b><br><code>'+esc(r.code)+'</code><br><span class="mut">'+esc(r.tier)+' · '+esc(r.name)+' · '+r.uses+' use(s) · expires '+esc(r.expires_at)+'</span><br><span class="mut">Tell the agent: “Call redeem_code with access_code '+esc(r.code)+'” (or register with it).</span>':esc(r.error);load();};
async function load(){const s=await (await fetch('/enroll/api/state')).json();if(s.error){$('you').textContent='(not signed in)';return;}$('you').textContent=s.you;
 $('codes').innerHTML='<table><tr><th>Name</th><th>Tier</th><th>Uses left</th><th>Expires</th><th>By</th><th></th></tr>'+s.codes.map(c=>'<tr><td>'+esc(c.name)+'</td><td>'+esc(c.tier)+'</td><td>'+c.uses_left+'</td><td>'+esc(c.expires_at)+'</td><td>'+esc(c.created_by)+'</td><td>'+(c.revoked?'revoked':'<button data-rc="'+esc(c.id)+'">Revoke</button>')+'</td></tr>').join('')+'</table>';
 $('keys').innerHTML='<table><tr><th>Key</th><th>Agent</th><th>Tier</th><th>Code</th><th>Sessions</th><th>Last active</th><th>Status</th><th></th></tr>'+s.keys.map(k=>'<tr><td><code>'+esc(k.id)+'</code></td><td>'+esc(k.agent)+'</td><td><select data-tier="'+esc(k.id)+'">'+['public','verified','owner'].map(t=>'<option'+(t===k.tier?' selected':'')+'>'+t+'</option>').join('')+'</select></td><td>'+esc(k.code_name)+'</td><td>'+k.sessions+'</td><td>'+esc(k.last_active||k.created_at)+'</td><td>'+(k.revoked?'revoked':'active')+'</td><td><button data-rk="'+esc(k.id)+'" data-v="'+(k.revoked?0:1)+'">'+(k.revoked?'Restore':'Revoke')+'</button></td></tr>').join('')+'</table>';}
document.addEventListener('click',async e=>{const t=e.target;if(t.dataset.rc){await post('/enroll/api/revoke-code',{id:t.dataset.rc});load();}if(t.dataset.rk){await post('/enroll/api/key',{key_id:t.dataset.rk,revoked:t.dataset.v==='1'});load();}});
document.addEventListener('change',async e=>{const t=e.target;if(t.dataset.tier){await post('/enroll/api/key',{key_id:t.dataset.tier,tier:t.value});load();}});
load();
</script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...SEC, 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` } });
}

export default {
  async fetch(req: Request, env: EnrollEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/') return Response.redirect(url.origin + '/enroll', 302);
    if (url.pathname !== '/enroll' && !url.pathname.startsWith('/enroll/')) return notFound();
    try { return await handleEnroll(req, env); }
    catch (e) { console.error('enroll_error', e instanceof Error ? e.message : String(e)); return json({ error: 'server error' }, 500); }
  },
};
