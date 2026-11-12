import { mintId, TRUST_DEFAULTS } from '@10db/contracts';
import { createTestStore, setAppSetting } from '@10db/db';
import { describe, expect, it, vi } from 'vitest';
import {
  appTrustSwitches,
  projectTrustOverrides,
  setAppTrustSwitches,
  setProjectTrustOverrides,
  trustSwitchesFor,
} from './trust-switches';

// Project ids only key a setting here; no project row is read.
const one = mintId('Project');
const two = mintId('Project');

describe('trust switches', () => {
  it('starts with every switch on', () => {
    const test = createTestStore();
    expect(appTrustSwitches(test.store.db)).toEqual(TRUST_DEFAULTS);
    expect(trustSwitchesFor(test.store.db, one)).toEqual(TRUST_DEFAULTS);
    test.close();
  });

  it('keeps what the builder sets', () => {
    const test = createTestStore();
    const set = { ...TRUST_DEFAULTS, web: false, plugins: { 'p@m': false } };
    test.store.write((ctx) => {
      setAppTrustSwitches(ctx, set);
    });
    expect(appTrustSwitches(test.store.db)).toEqual(set);
    test.close();
  });

  it('a stored object missing a key gives that key its default', () => {
    const test = createTestStore();
    const stored = {
      web: true,
      projectInstructions: true,
      yourInstructions: true,
      yourSkills: false,
      yourPlugins: true,
      plugins: {},
    };
    test.store.write((ctx) => {
      setAppSetting(ctx, 'trust', stored);
    });
    expect(appTrustSwitches(test.store.db)).toEqual({
      ...TRUST_DEFAULTS,
      yourSkills: false,
      projectSkills: true,
    });
    test.close();
  });

  it('a key of the wrong type is off and named', () => {
    const test = createTestStore();
    test.store.write((ctx) => {
      setAppSetting(ctx, 'trust', { ...TRUST_DEFAULTS, yourPlugins: false, web: 'yes' });
    });
    const onInvalid = vi.fn();
    expect(appTrustSwitches(test.store.db, onInvalid)).toEqual({
      ...TRUST_DEFAULTS,
      yourPlugins: false,
      web: false,
    });
    expect(onInvalid).toHaveBeenCalledWith('web', 'yes');
    expect(onInvalid).toHaveBeenCalledOnce();
    test.close();
  });

  it('a stored value that is not an object turns every switch off', () => {
    const test = createTestStore();
    test.store.write((ctx) => {
      setAppSetting(ctx, 'trust', 'on');
    });
    const onInvalid = vi.fn();
    expect(appTrustSwitches(test.store.db, onInvalid)).toEqual({
      web: false,
      projectInstructions: false,
      yourInstructions: false,
      yourSkills: false,
      yourPlugins: false,
      projectSkills: false,
      plugins: {},
    });
    expect(onInvalid).toHaveBeenCalledWith('trust', 'on');
    test.close();
  });

  it('a project’s overrides apply to it alone', () => {
    const test = createTestStore();
    test.store.write((ctx) => {
      setAppTrustSwitches(ctx, { ...TRUST_DEFAULTS, plugins: { 'p@m': true } });
      setProjectTrustOverrides(ctx, one, { web: false, plugins: { 'p@m': false } });
    });
    expect(projectTrustOverrides(test.store.db, one)).toEqual({
      web: false,
      plugins: { 'p@m': false },
    });
    expect(projectTrustOverrides(test.store.db, two)).toEqual({});
    expect(trustSwitchesFor(test.store.db, one)).toEqual({
      ...TRUST_DEFAULTS,
      web: false,
      plugins: { 'p@m': false },
    });
    expect(trustSwitchesFor(test.store.db, two)).toEqual({
      ...TRUST_DEFAULTS,
      plugins: { 'p@m': true },
    });
    test.close();
  });
});
