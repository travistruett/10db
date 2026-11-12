import { describe, expect, it } from 'vitest';
import { effectiveTrust, TRUST_DEFAULTS, type TrustOverrides, type TrustSwitches } from './trust';

const app: TrustSwitches = {
  ...TRUST_DEFAULTS,
  yourSkills: false,
  plugins: { 'a@m': true, 'b@m': false },
};

describe('effectiveTrust', () => {
  it.each<[string, TrustOverrides, TrustSwitches]>([
    ['no overrides is the app’s', {}, app],
    ['an override wins one field', { web: false }, { ...app, web: false }],
    [
      'plugins merge key by key, the override’s winning',
      { plugins: { 'b@m': true, 'c@m': false } },
      { ...app, plugins: { 'a@m': true, 'b@m': true, 'c@m': false } },
    ],
    ['an empty plugins override keeps the app’s', { plugins: {} }, app],
  ])('%s', (_name, overrides, expected) => {
    expect(effectiveTrust(app, overrides)).toEqual(expected);
  });
});
