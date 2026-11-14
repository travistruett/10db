import { mintId, TRUST_DEFAULTS, YourMcpSource, yourMcpServerKey } from '@10db/contracts';
import { createTestStore, setAppSetting } from '@10db/db';
import { describe, expect, it, vi } from 'vitest';
import {
  approveMcpServer,
  appTrustSwitches,
  mcpApprovals,
  projectTrustOverrides,
  setAppTrustSwitches,
  setProjectTrustOverrides,
  trustSwitchesFor,
} from './trust-switches';

// Project ids only key a setting here; no project row is read.
const one = mintId('Project');
const two = mintId('Project');

const ignore = (): void => undefined;
const github = yourMcpServerKey(YourMcpSource.ClaudeJson, 'github');
const hash = 'a'.repeat(64);

describe('trust switches', () => {
  it('starts with every switch on', () => {
    const test = createTestStore();
    expect(appTrustSwitches(test.store.db, ignore)).toEqual(TRUST_DEFAULTS);
    expect(trustSwitchesFor(test.store.db, one, ignore)).toEqual(TRUST_DEFAULTS);
    test.close();
  });

  it('keeps what the builder sets', () => {
    const test = createTestStore();
    const set = {
      ...TRUST_DEFAULTS,
      web: false,
      plugins: { 'p@m': false },
      yourMcpServers: false,
      mcpServers: { [github]: false },
    };
    test.store.write((ctx) => {
      setAppTrustSwitches(ctx, set);
    });
    expect(appTrustSwitches(test.store.db, ignore)).toEqual(set);
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
    expect(appTrustSwitches(test.store.db, ignore)).toEqual({
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
      yourMcpServers: false,
      mcpServers: {},
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
    expect(projectTrustOverrides(test.store.db, one, ignore)).toEqual({
      web: false,
      plugins: { 'p@m': false },
    });
    expect(projectTrustOverrides(test.store.db, two, ignore)).toEqual({});
    expect(trustSwitchesFor(test.store.db, one, ignore)).toEqual({
      ...TRUST_DEFAULTS,
      web: false,
      plugins: { 'p@m': false },
    });
    expect(trustSwitchesFor(test.store.db, two, ignore)).toEqual({
      ...TRUST_DEFAULTS,
      plugins: { 'p@m': true },
    });
    test.close();
  });

  it('a stored server switch whose key is not a server key is dropped and named', () => {
    const test = createTestStore();
    test.store.write((ctx) => {
      setAppSetting(ctx, 'trust', { mcpServers: { [github]: false, __proto__x: true } });
    });
    const onInvalid = vi.fn();
    expect(appTrustSwitches(test.store.db, onInvalid).mcpServers).toEqual({ [github]: false });
    expect(onInvalid).toHaveBeenCalledWith('mcpServers.__proto__x', true);
    test.close();
  });
});

describe('mcp approvals', () => {
  it('no approvals at first', () => {
    const test = createTestStore();
    expect(mcpApprovals(test.store.db).size).toBe(0);
    test.close();
  });

  it('keeps an approval and reads it back', () => {
    const test = createTestStore();
    test.store.write((ctx) => {
      approveMcpServer(ctx, github, hash);
    });
    expect([...mcpApprovals(test.store.db)]).toEqual([[github, hash]]);
    test.close();
  });

  it('an approvals value that is not the shape is empty, and says so', () => {
    const test = createTestStore();
    test.store.write((ctx) => {
      setAppSetting(ctx, 'trust.mcp-approvals', { [github]: 'not-a-hash' });
    });
    const onInvalid = vi.fn();
    expect(mcpApprovals(test.store.db, onInvalid).size).toBe(0);
    expect(onInvalid).toHaveBeenCalledWith({ [github]: 'not-a-hash' });
    test.close();
  });
});
