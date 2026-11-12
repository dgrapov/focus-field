import { describe, it, expect } from 'vitest';
import { validateSession, originAllowed } from '../src/validate';

const good = () => ({
  turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX', participant_id: 'test-0123456789', label: 'Control', poles: 2,
  block_size: 25, app_version: '1.1.0', per_second_counts: [[250, 250], [260, 240]], focus_marks: [0, -1],
});

describe('validateSession', () => {
  it('accepts a good body', () => { const v = validateSession(good()); expect(v.ok).toBe(true); if (v.ok) expect(v.flags).toEqual([]); });
  it('optional fields may be missing', () => { const b: any = good(); delete b.block_size; delete b.app_version; expect(validateSession(b).ok).toBe(true); });
  const bad: [string, (b: any) => void][] = [
    ['poles 1', b => (b.poles = 1)], ['poles 9', b => (b.poles = 9)], ['poles float', b => (b.poles = 2.5)],
    ['label AI', b => (b.label = 'AI')], ['short pid', b => (b.participant_id = 'abc')], ['pid chars', b => (b.participant_id = 'abc def ghi')],
    ['no token', b => delete b.turnstile_token], ['length mismatch', b => b.focus_marks.push(0)],
    ['empty', b => { b.per_second_counts = []; b.focus_marks = []; }], ['row width', b => (b.per_second_counts[0] = [500])],
    ['negative count', b => (b.per_second_counts[0] = [-1, 501])], ['float count', b => (b.per_second_counts[0] = [250.5, 249.5])],
    ['sum > 2000', b => (b.per_second_counts[0] = [1500, 501])], ['mark too high', b => (b.focus_marks[0] = 2)],
    ['mark < -1', b => (b.focus_marks[0] = -2)], ['bad version', b => (b.app_version = '<script>')], ['array body', b => Object.setPrototypeOf(b, Array.prototype)],
  ];
  for (const [name, mut] of bad) it(`rejects ${name}`, () => { const b: any = good(); mut(b); expect(validateSession(name === 'array body' ? [] : b).ok).toBe(false); });
  it('rejects > 36,000 seconds', () => { const b: any = good(); b.per_second_counts = Array(36001).fill([250, 250]); b.focus_marks = Array(36001).fill(-1); expect(validateSession(b).ok).toBe(false); });
  it('flags seconds outside 450–550 without rejecting', () => {
    const b: any = good(); b.per_second_counts = [[300, 100], [1000, 1000], [250, 250]]; b.focus_marks = [0, 0, 0];
    const v = validateSession(b); expect(v.ok).toBe(true); if (v.ok) expect(v.flags).toEqual(['rate_outside_450_550:2']);
  });
});

describe('originAllowed', () => {
  it('allows the site and localhost', () => {
    for (const o of ['https://dgrapov.github.io', 'http://localhost', 'http://localhost:8000']) expect(originAllowed(o)).toBe(true);
  });
  it('refuses others', () => {
    for (const o of [null, '', 'https://evil.example', 'https://dgrapov.github.io.evil.example', 'http://dgrapov.github.io', 'https://localhost:8000', 'http://localhost.evil.example', 'http://127.0.0.1:8000', 'null'])
      expect(originAllowed(o)).toBe(false);
  });
});
