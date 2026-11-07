import { describe, expect, it } from 'vitest';
import { strongerDefault } from './role-defaults';
import { label, unscoredCatalogue } from './test-catalogue';

describe('strongerDefault', () => {
  const profiles = unscoredCatalogue({}, ['small', 'mid', 'big', 'peak']);
  const at = (l: string, pool = profiles) => {
    const p = pool.find((x) => label(x) === l);
    if (!p) throw new Error(l);
    return p;
  };
  it.each([
    { name: 'the next dearer model at the same effort', from: 'small@medium', want: 'mid@medium' },
    { name: 'a tier up from the top of its own', from: 'mid@high', want: 'big@high' },
    { name: 'the top of the tier from its cheaper model', from: 'big@high', want: 'peak@high' },
    { name: 'the next effort on the dearest model', from: 'peak@high', want: 'peak@xhigh' },
    { name: 'nothing above the top', from: 'peak@max', want: null },
  ])('moves to $name', ({ from, want }) => {
    const next = strongerDefault(at(from), profiles);
    expect(next ? label(next) : null).toBe(want);
  });

  it('skips a model the account does not offer', () => {
    const offered = unscoredCatalogue({}, ['small', 'big']);
    const next = strongerDefault(at('small@low', offered), offered);
    expect(next ? label(next) : null).toBe('big@low');
  });

  it('never moves to a model routing may not pick, so the next effort is all that is left', () => {
    const off = unscoredCatalogue({}, ['small', 'mid']).map((p) =>
      p.model === 'mid' ? { ...p, enabled: false } : p,
    );
    const next = strongerDefault(at('small@low', off), off);
    expect(next ? label(next) : null).toBe('small@medium');
  });
});
