// Input validation for POST /api/session. Pure; unit-tested in test/validate.test.ts.

export const LABELS = ['Human', 'Both', 'Control'] as const;
export type Label = (typeof LABELS)[number];

export const MAX_SECONDS = 36_000;
export const MAX_PER_SECOND = 2_000;
export const NORMAL_MIN = 450, NORMAL_MAX = 550;

export interface SessionInput {
  turnstile_token: string;
  participant_id: string;
  label: Label;
  poles: number;
  block_size: number | null;
  app_version: string | null;
  per_second_counts: number[][];
  focus_marks: number[];
}

export type Validated = { ok: true; value: SessionInput; flags: string[] } | { ok: false; reason: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const PID = /^[A-Za-z0-9-]{8,64}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,32}$/;

/** Check shape and ranges. `reason` is for logs only; the client just sees `bad_input`. */
export function validateSession(body: unknown): Validated {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'not an object' };
  const b = body as Record<string, unknown>;

  const token = b.turnstile_token;
  if (typeof token !== 'string' || token.length < 1 || token.length > 2048) return { ok: false, reason: 'turnstile_token' };

  const pid = b.participant_id;
  if (typeof pid !== 'string' || !PID.test(pid)) return { ok: false, reason: 'participant_id' };

  const label = b.label;
  if (typeof label !== 'string' || !(LABELS as readonly string[]).includes(label)) return { ok: false, reason: 'label' };

  const K = b.poles;
  if (!isInt(K) || K < 2 || K > 8) return { ok: false, reason: 'poles' };

  let block: number | null = null;
  if (b.block_size !== undefined && b.block_size !== null) {
    if (!isInt(b.block_size) || b.block_size < 1 || b.block_size > 100_000) return { ok: false, reason: 'block_size' };
    block = b.block_size;
  }

  let ver: string | null = null;
  if (b.app_version !== undefined && b.app_version !== null) {
    if (typeof b.app_version !== 'string' || !VERSION.test(b.app_version)) return { ok: false, reason: 'app_version' };
    ver = b.app_version;
  }

  const counts = b.per_second_counts, marks = b.focus_marks;
  if (!Array.isArray(counts) || !Array.isArray(marks)) return { ok: false, reason: 'arrays' };
  if (counts.length !== marks.length) return { ok: false, reason: 'length mismatch' };
  if (counts.length < 1 || counts.length > MAX_SECONDS) return { ok: false, reason: 'seconds' };

  let offRate = 0;
  for (let i = 0; i < counts.length; i++) {
    const row = counts[i];
    if (!Array.isArray(row) || row.length !== K) return { ok: false, reason: `row ${i} length` };
    let sum = 0;
    for (let k = 0; k < K; k++) {
      const v = row[k];
      if (!isInt(v) || v < 0) return { ok: false, reason: `row ${i} value` };
      sum += v;
    }
    if (sum > MAX_PER_SECOND) return { ok: false, reason: `row ${i} sum` };
    if (sum < NORMAL_MIN || sum > NORMAL_MAX) offRate++;
    const f = marks[i];
    if (!isInt(f) || f < -1 || f > K - 1) return { ok: false, reason: `mark ${i}` };
  }

  const flags: string[] = [];
  if (offRate) flags.push(`rate_outside_${NORMAL_MIN}_${NORMAL_MAX}:${offRate}`);

  return {
    ok: true,
    flags,
    value: {
      turnstile_token: token, participant_id: pid, label: label as Label, poles: K, block_size: block, app_version: ver,
      per_second_counts: counts as number[][], focus_marks: marks as number[],
    },
  };
}

/** Allowed browser origins: the GitHub Pages site and any localhost port (for testing). */
export function originAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return origin === 'https://dgrapov.github.io' || /^http:\/\/localhost(:\d{1,5})?$/.test(origin);
}

/** Cloudflare's published Turnstile test secrets. They must never verify a request from the real site. */
export const TEST_SECRETS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);
