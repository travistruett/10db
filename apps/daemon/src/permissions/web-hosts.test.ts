import { EventType, InvalidError, NotFoundError } from '@10db/contracts';
import {
  createTestStore,
  listEventsAfter,
  listPermissionRules,
  seedProject,
  setAppSetting,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import {
  addWebHost,
  allowNetworkHost,
  checkWebHost,
  listNetworkHosts,
  listWebHosts,
  matchPermissionRule,
  removeWebHost,
  setWebSearch,
  startWebHosts,
  storableRule,
  unlistedWebHosts,
  WEB_HOST_TOOL,
  webHostsStarted,
  webPageHost,
  webSearchOn,
} from './index';

let close: () => void;
let store: Store;
let state: StateStore;
beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
});
afterEach(() => {
  close();
});

describe('webPageHost', () => {
  it.each<[string, unknown, string | null]>([
    ['an https page', 'https://github.com/cli/cli/issues/1', 'github.com'],
    ['the default port spelled out', 'https://github.com:443/', 'github.com'],
    ['capitals in the host', 'https://GitHub.com/', 'github.com'],
    ['a query and fragment', 'https://docs.rs/x?y=1#z', 'docs.rs'],
    [
      'a name that begins like a listed host',
      'https://github.com.example.net/',
      'github.com.example.net',
    ],
    ['a login in front of the host', 'https://github.com@example.net/', null],
    ['a login and password', 'https://a:b@github.com/', null],
    ['http', 'http://github.com/', null],
    ['another port', 'https://github.com:8443/', null],
    ['an IPv4 address', 'https://140.82.112.4/', null],
    ['an address as one number', 'https://2130706433/', null],
    ['an IPv6 address', 'https://[::1]/', null],
    ['no dot', 'https://intranet/', null],
    ['localhost', 'https://localhost/', null],
    ['a .localhost name', 'https://app.localhost/', null],
    ['a .local name', 'https://printer.local/', null],
    ['a .internal name', 'https://db.internal/', null],
    ['a .home.arpa name', 'https://nas.home.arpa/', null],
    ['a trailing dot', 'https://github.com./', null],
    ['a backslash', 'https://example.net\\@github.com/', null],
    ['a tab', 'https://git\thub.com/', null],
    ['a newline', 'https://github.com\n.example.net/', null],
    ['a space', 'https://github.com /', null],
    ['a wildcard', 'https://*.github.com/', null],
    ['not a URL', 'github.com', null],
    ['over the length limit', `https://github.com/${'x'.repeat(2001)}`, null],
    ['not text', 7, null],
    ['nothing', undefined, null],
  ])('%s', (_name, url, expected) => {
    expect(webPageHost(url)).toBe(expected);
  });
});

describe('checkWebHost', () => {
  it.each([
    ['*.github.com', 'pattern'],
    ['localhost', 'this machine'],
    ['127.0.0.1', 'this machine'],
    ['140.82.112.4', 'public'],
    ['intranet', 'too broad'],
    ['nas.home.arpa', 'public'],
    ['', 'Enter a host'],
    ['https://github.com/', "can't be listed"],
  ])('refuses %s', (raw, words) => {
    expect(() => checkWebHost(raw)).toThrow(InvalidError);
    expect(() => checkWebHost(raw)).toThrow(words);
  });

  it('folds a name to the form a rule stores', () => {
    expect(checkWebHost('  Docs.RS ')).toBe('docs.rs');
  });
});

describe('the read-list rule', () => {
  const rule = (pattern: string | null) => ({
    id: 'r' as never,
    projectId: 'p' as never,
    workstreamId: null,
    toolName: WEB_HOST_TOOL,
    pattern,
    sourceInboxId: null,
    foundIn: null,
    createdAt: '2026-11-03T00:00:00.000Z',
  });
  const covers = (host: string, pattern: string | null): boolean =>
    matchPermissionRule({ toolName: WEB_HOST_TOOL, input: { host } }, [rule(pattern)]) !==
    undefined;

  it.each<[string, string, string | null, boolean]>([
    ['its own host', 'github.com', 'github.com', true],
    ['another host', 'example.net', 'github.com', false],
    ['a subdomain', 'gist.github.com', 'github.com', false],
    ['a wildcard, which a list never holds', 'gist.github.com', '*.github.com', false],
    ['a rule with no host', 'example.net', null, false],
  ])('covers %s only as stored', (_name, host, pattern, expected) => {
    expect(covers(host, pattern)).toBe(expected);
  });

  it('is never a rule with no host, which would open every host', () => {
    expect(storableRule(WEB_HOST_TOOL, 'example.net')).toEqual({
      toolName: WEB_HOST_TOOL,
      pattern: 'example.net',
    });
    expect(storableRule(WEB_HOST_TOOL, '{"url":"https://example.net"}')).toBeUndefined();
    expect(storableRule(WEB_HOST_TOOL, '*.example.net')).toBeUndefined();
  });
});

describe('a project read list', () => {
  it('starts with github.com and the found hosts, each with its source', () => {
    const project = seedProject(store);
    startWebHosts(state, project.id, [{ host: 'docs.rs', file: 'Cargo.toml' }]);
    expect(listWebHosts(state.db, project.id).map((h) => [h.host, h.source])).toEqual([
      ['github.com', { kind: 'start' }],
      ['docs.rs', { kind: 'file', file: 'Cargo.toml' }],
    ]);
    expect(webHostsStarted(state.db, project.id)).toBe(true);
  });

  it('starts once, so a host the builder removed stays out', () => {
    const project = seedProject(store);
    startWebHosts(state, project.id, []);
    removeWebHost(state, project.id, 'github.com');
    startWebHosts(state, project.id, [{ host: 'docs.rs', file: 'Cargo.toml' }]);
    expect(listWebHosts(state.db, project.id)).toEqual([]);
  });

  it('leaves out a found host the list may not hold', () => {
    const project = seedProject(store);
    startWebHosts(state, project.id, [
      { host: 'localhost', file: 'package.json' },
      { host: '10.0.0.8', file: 'package.json' },
    ]);
    expect(listWebHosts(state.db, project.id).map((h) => h.host)).toEqual(['github.com']);
  });

  it('adds, answers an existing host, and removes through the same rules', () => {
    const project = seedProject(store);
    expect(addWebHost(state, project.id, 'Docs.rs')).toMatchObject({
      created: true,
      host: { host: 'docs.rs', source: { kind: 'builder' } },
    });
    expect(addWebHost(state, project.id, 'docs.rs').created).toBe(false);
    expect(
      listPermissionRules(state.db, project.id, null).map((r) => [r.toolName, r.pattern]),
    ).toEqual([[WEB_HOST_TOOL, 'docs.rs']]);
    expect(removeWebHost(state, project.id, 'docs.rs').host).toBe('docs.rs');
    expect(listWebHosts(state.db, project.id)).toEqual([]);
    expect(() => removeWebHost(state, project.id, 'docs.rs')).toThrow(NotFoundError);
    const types = listEventsAfter(state.db, 0, 100).map((e) => e.type);
    expect(types.filter((t) => t === EventType.WebHostsChanged)).toHaveLength(2);
  });

  it('is apart from the hosts commands may reach, both ways', () => {
    const project = seedProject(store);
    addWebHost(state, project.id, 'docs.rs');
    allowNetworkHost(state, project.id, 'index.crates.io');
    expect(listNetworkHosts(state.db, project.id).map((h) => h.host)).toEqual(['index.crates.io']);
    expect(listWebHosts(state.db, project.id).map((h) => h.host)).toEqual(['docs.rs']);
  });

  it('lists found hosts for the builder and adds none of them', () => {
    const project = seedProject(store);
    startWebHosts(state, project.id, []);
    const found = [
      { host: 'github.com', file: 'package.json' },
      { host: 'react.dev', file: 'package.json' },
      { host: 'react.dev', file: 'apps/web/package.json' },
      { host: 'localhost', file: 'package.json' },
    ];
    expect(unlistedWebHosts(state.db, project.id, found)).toEqual([
      { host: 'react.dev', file: 'package.json' },
    ]);
    expect(listWebHosts(state.db, project.id).map((h) => h.host)).toEqual(['github.com']);
  });
});

describe('the web search switch', () => {
  it('is on until the project turns it off', () => {
    const project = seedProject(store);
    expect(webSearchOn(state.db, project.id)).toBe(true);
    state.write((ctx) => {
      setWebSearch(ctx, project.id, false);
    });
    expect(webSearchOn(state.db, project.id)).toBe(false);
    state.write((ctx) => {
      setWebSearch(ctx, project.id, true);
    });
    expect(webSearchOn(state.db, project.id)).toBe(true);
  });

  it('is per project', () => {
    const one = seedProject(store);
    const other = seedProject(store);
    state.write((ctx) => {
      setWebSearch(ctx, one.id, false);
    });
    expect(webSearchOn(state.db, other.id)).toBe(true);
  });

  it('reads as off when the stored value is not a boolean', () => {
    const project = seedProject(store);
    state.write((ctx) => {
      setAppSetting(ctx, `web-search:${project.id}`, 'yes');
    });
    expect(webSearchOn(state.db, project.id)).toBe(false);
  });
});
