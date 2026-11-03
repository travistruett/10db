import {
  EventType,
  InvalidError,
  NotFoundError,
  type FoundHostDto,
  type PermissionRuleDto,
  type ProjectId,
  type WebHostDto,
  type WebHostSource,
} from '@10db/contracts';
import {
  deleteProjectPermissionRules,
  getAppSetting,
  getProject,
  insertPermissionRule,
  listPermissionRules,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { StateStore } from '../events';
import { namesPrivateHost } from '../guard';
import { checkConcreteHost } from './network-hosts';
import { WEB_HOST_TOOL } from './rules';

/** Every read list starts with this host. */
const STARTING_HOST = 'github.com';
/** The `foundIn` of a host 10db starts a list with: no file named it, and neither did the builder. */
const STARTED_BY_10DB = '';
/** Longer than this a URL carries more than an address, so it gets a card whatever its host. */
const MAX_URL_LENGTH = 2000;
/** Characters URL parsing drops or reads as `/`, so the text the builder reads differs from the host fetched. */
const UNCLEAR_URL = /[\s\\]/;

const startedKey = (projectId: ProjectId): string => `web-hosts-started:${projectId}`;
const searchKey = (projectId: ProjectId): string => `web-search:${projectId}`;

function refusal(message: string): InvalidError {
  return new InvalidError(message);
}

/**
 * A host folded to the form the read list stores, or an `InvalidError` saying why it can't be listed:
 * one concrete public name, never a pattern, an address or a name on the builder's own network. A
 * WebFetch runs from Claude Code itself, past the sandbox, so a host here reaches further than one a
 * command reaches through the proxy.
 */
export function checkWebHost(raw: string): string {
  const host = checkConcreteHost(raw);
  if (isIP(host) !== 0 || namesPrivateHost(host)) {
    throw refusal(`${host} is not a public web host, so it can't go on the read list.`);
  }
  return host;
}

/**
 * The host of a URL whose host alone says where the request goes, or null when it can only be asked
 * about as a whole: not https on port 443, a login in it, an address or a name on the builder's own
 * network, a character URL parsing drops, or too long. The host comes from parsing the URL, never
 * from its text, so `https://github.com@example.net/` is no page of github.com.
 */
export function webPageHost(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH || UNCLEAR_URL.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // Parsing leaves the port empty when it is https's own.
  const plain = url.protocol === 'https:' && url.port === '';
  if (!plain || url.username !== '' || url.password !== '') return null;
  try {
    return checkWebHost(url.hostname);
  } catch {
    return null;
  }
}

function sourceOf(rule: PermissionRuleDto): WebHostSource {
  if (rule.foundIn === STARTED_BY_10DB) return { kind: 'start' };
  if (rule.foundIn !== null) return { kind: 'file', file: rule.foundIn };
  if (rule.sourceInboxId !== null) return { kind: 'card' };
  return { kind: 'builder' };
}

/** The project's read list, oldest first, one entry per host. */
export function listWebHosts(db: DbReader, projectId: ProjectId): WebHostDto[] {
  const seen = new Map<string, WebHostDto>();
  for (const rule of listPermissionRules(db, projectId, null)) {
    if (rule.toolName !== WEB_HOST_TOOL || rule.pattern === null || seen.has(rule.pattern)) {
      continue;
    }
    seen.set(rule.pattern, {
      host: rule.pattern,
      source: sourceOf(rule),
      createdAt: rule.createdAt,
    });
  }
  return [...seen.values()];
}

function emitChanged(ctx: WriteContext, projectId: ProjectId, hosts: readonly string[]): void {
  ctx.emit({
    type: EventType.WebHostsChanged,
    entityType: 'web_hosts',
    entityId: projectId,
    data: { hosts: [...hosts] },
  });
}

/** True once the project's read list has had its start, whatever the builder has done to it since. */
export function webHostsStarted(db: DbReader, projectId: ProjectId): boolean {
  return getAppSetting(db, startedKey(projectId)) !== undefined;
}

/**
 * Gives the project's read list its start, once: github.com and `found`, the documentation hosts of
 * its dependencies. A list that has had its start is left alone, so a host the builder removed stays
 * out. A found host the list may not hold is left out.
 */
export function startWebHosts(
  state: StateStore,
  projectId: ProjectId,
  found: readonly FoundHostDto[],
): void {
  state.write((ctx) => {
    getProject(ctx.tx, projectId);
    if (webHostsStarted(ctx.tx, projectId)) return;
    setAppSetting(ctx, startedKey(projectId), true);
    const hosts = new Map([[STARTING_HOST, STARTED_BY_10DB]]);
    for (const { host: named, file } of found) {
      try {
        const host = checkWebHost(named);
        if (!hosts.has(host)) hosts.set(host, file);
      } catch {
        continue;
      }
    }
    const listed = new Set(listWebHosts(ctx.tx, projectId).map((h) => h.host));
    for (const [host, foundIn] of hosts) {
      if (listed.has(host)) continue;
      insertPermissionRule(ctx, {
        projectId,
        workstreamId: null,
        toolName: WEB_HOST_TOOL,
        pattern: host,
        sourceInboxId: null,
        foundIn,
      });
    }
    emitChanged(ctx, projectId, [...hosts.keys()]);
  });
}

/**
 * The hosts a reading of the project's files found that are not on the read list, each with its file.
 * Lists nothing on its own: a lane may have written those files, so the builder adds each by name.
 */
export function unlistedWebHosts(
  db: DbReader,
  projectId: ProjectId,
  found: readonly FoundHostDto[],
): FoundHostDto[] {
  const listed = new Set(listWebHosts(db, projectId).map((h) => h.host));
  const unlisted = new Map<string, FoundHostDto>();
  for (const { host: named, file } of found) {
    try {
      const host = checkWebHost(named);
      if (!listed.has(host) && !unlisted.has(host)) unlisted.set(host, { host, file });
    } catch {
      continue;
    }
  }
  return [...unlisted.values()];
}

/** Adds a host the builder named; a host already listed is answered, not stored again. */
export function addWebHost(
  state: StateStore,
  projectId: ProjectId,
  raw: string,
): { readonly host: WebHostDto; readonly created: boolean } {
  const host = checkWebHost(raw);
  return state.write((ctx) => {
    getProject(ctx.tx, projectId);
    const existing = listWebHosts(ctx.tx, projectId).find((h) => h.host === host);
    if (existing) return { host: existing, created: false };
    const rule = insertPermissionRule(ctx, {
      projectId,
      workstreamId: null,
      toolName: WEB_HOST_TOOL,
      pattern: host,
      sourceInboxId: null,
    });
    emitChanged(ctx, projectId, [host]);
    return {
      host: { host, source: { kind: 'builder' }, createdAt: rule.createdAt },
      created: true,
    };
  });
}

/** Takes a host off the read list; a host not on it is a `NotFoundError`. */
export function removeWebHost(state: StateStore, projectId: ProjectId, raw: string): WebHostDto {
  const host = raw.trim().toLowerCase();
  return state.write((ctx) => {
    getProject(ctx.tx, projectId);
    const existing = listWebHosts(ctx.tx, projectId).find((h) => h.host === host);
    if (!existing) throw new NotFoundError('web host', host);
    deleteProjectPermissionRules(ctx, { projectId, toolName: WEB_HOST_TOOL, pattern: host });
    emitChanged(ctx, projectId, [host]);
    return existing;
  });
}

/**
 * Lanes search the web with no card unless the project turned that off. A stored value that is not a
 * boolean is not trusted, and reads as off: the builder sees a card, and no search goes out unseen.
 */
export function webSearchOn(db: DbReader, projectId: ProjectId): boolean {
  const stored = getAppSetting(db, searchKey(projectId));
  if (stored === undefined) return true;
  return z.boolean().safeParse(stored).data ?? false;
}

export function setWebSearch(ctx: WriteContext, projectId: ProjectId, on: boolean): void {
  setAppSetting(ctx, searchKey(projectId), on);
  ctx.emit({
    type: EventType.WebSearchChanged,
    entityType: 'web_search',
    entityId: projectId,
    data: { enabled: on },
  });
}
