import {
  EventType,
  InvalidError,
  NotFoundError,
  type FoundHostDto,
  type NetworkHostDto,
  type NetworkHostSource,
  type PermissionRuleDto,
  type ProjectId,
} from '@10db/contracts';
import {
  deleteProjectPermissionRules,
  getProject,
  insertPermissionRule,
  listPermissionRules,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import { isSandboxDomain } from '../sandbox';
import { writeFoundHosts } from './found-hosts';
import { matchPermissionRule, storableRule } from './rules';

/** The tool name of the sandbox's ask to reach a host; the same rules a card answer stores. */
const NETWORK_TOOL = 'SandboxNetworkAccess';

const LOOPBACK_NAME = /(^|\.)localhost$/;
const LOOPBACK_V4 = /^(127(\.\d{1,3}){3}|0\.0\.0\.0)$/;
const DOTTED_QUAD =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** A last label that reads as a number: the sandbox's proxy would turn `0x7f.1` or `2130706433` into an address. */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
/**
 * Suffixes under which unrelated parties host sites, so a wildcard over one reaches anyone. A short
 * list, not the public suffix list: it catches the common ones a builder might type.
 */
const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'co.nz',
  'co.in',
  'com.br',
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'herokuapp.com',
  'appspot.com',
  'amazonaws.com',
  'cloudfront.net',
  'azurewebsites.net',
]);
const LOOPBACK_V6 = /^\[?(::1|0*:0*:0*:0*:0*:0*:0*:0*1)\]?$/;

function refusal(message: string): InvalidError {
  return new InvalidError(message);
}

/**
 * The host a builder typed, folded to the form a rule stores, or an `InvalidError` saying why it
 * can't be allowed. The profile's own host check (through `storableRule`, which a card answer uses)
 * decides what can be listed; on top of it a project may not be given loopback, which has its own
 * setting, nor a pattern that covers a whole top-level domain.
 */
export function checkNetworkHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (host === '') throw refusal('Enter a host, such as index.crates.io.');
  if (host === '*' || host === '*.') {
    throw refusal(`${host} is too broad: name the host, or *. and a domain such as *.crates.io.`);
  }
  if (
    LOOPBACK_NAME.test(host.replace(/^\*\./, '')) ||
    LOOPBACK_V4.test(host) ||
    LOOPBACK_V6.test(host)
  ) {
    throw refusal(`${host} is this machine: use the project's Allow localhost setting instead.`);
  }
  if (DOTTED_QUAD.test(host)) {
    const [first = '', second = ''] = host.split('.');
    if (first === '127' || first === '0') {
      throw refusal(`${host} is this machine: use the project's Allow localhost setting instead.`);
    }
    if (first === '169' && second === '254') {
      throw refusal(`${host} is a link-local address, where cloud metadata services listen.`);
    }
  }
  const rule = storableRule(NETWORK_TOOL, host);
  const pattern = rule?.pattern ?? null;
  const labels = (pattern ?? '').replace(/^\*\./, '').split('.');
  if (pattern === null || !isSandboxDomain(pattern) || labels.includes('')) {
    throw refusal(
      `${host} can't be listed: use a host name such as index.crates.io, or *. and a domain such as *.crates.io.`,
    );
  }
  const unlistable =
    host.length > MAX_HOST_LENGTH ||
    labels.some((label) => label.length > MAX_LABEL_LENGTH) ||
    // An address is written as four decimal parts, never as a short, hex, octal or whole-number form.
    (NUMERIC_LABEL.test(labels.at(-1) ?? '') &&
      (pattern.startsWith('*.') || !DOTTED_QUAD.test(pattern)));
  if (unlistable) {
    throw refusal(
      `${host} can't be listed: write an address as four decimal parts and a name at most 253 characters, with labels of at most 63.`,
    );
  }
  if (labels.length < 2 || (pattern.startsWith('*.') && SHARED_SUFFIXES.has(labels.join('.')))) {
    throw refusal(
      `${host} is too broad: it covers a whole top-level domain or a suffix many sites share. Name the host.`,
    );
  }
  return pattern;
}

/**
 * A host a project file or a blocked gate names, folded as `checkNetworkHost` folds it, or an
 * `InvalidError`. It must be one concrete name: a package manager never fetches from a wildcard, and
 * a gate's output can print any name, so a `*` here is never turned into a pattern.
 */
export function checkConcreteHost(raw: string): string {
  if (raw.includes('*')) {
    throw refusal(`${raw.trim()} is a pattern, not a host: name the one host to reach.`);
  }
  return checkNetworkHost(raw);
}

function sourceOf(rule: PermissionRuleDto): NetworkHostSource {
  if (rule.foundIn !== null) return { kind: 'file', file: rule.foundIn };
  if (rule.sourceInboxId !== null) return { kind: 'card' };
  return { kind: 'builder' };
}

/**
 * The project's allowed hosts, oldest first, one per host however many rules name it. A host's
 * source is its oldest rule's: the file that named it, the card that allowed it, or the builder.
 */
export function listNetworkHosts(db: DbReader, projectId: ProjectId): NetworkHostDto[] {
  const seen = new Map<string, NetworkHostDto>();
  for (const rule of listPermissionRules(db, projectId, null)) {
    if (rule.toolName !== NETWORK_TOOL || rule.pattern === null) continue;
    if (!seen.has(rule.pattern))
      seen.set(rule.pattern, {
        host: rule.pattern,
        source: sourceOf(rule),
        createdAt: rule.createdAt,
      });
  }
  return [...seen.values()];
}

/**
 * Allows the hosts a reading of the project's files found, as the project-wide rules an Allow for the
 * project stores, and keeps the reading for the cards that say a file names a host. A host already
 * allowed is left as it is. Answers the hosts this call allowed; one event covers them all.
 */
export function allowFoundHosts(
  state: StateStore,
  projectId: ProjectId,
  found: readonly FoundHostDto[],
): NetworkHostDto[] {
  return state.write((ctx) => {
    getProject(ctx.tx, projectId);
    const rules = listPermissionRules(ctx.tx, projectId, null);
    const allowed = new Set<string>();
    const added: NetworkHostDto[] = [];
    const kept: FoundHostDto[] = [];
    for (const { host: named, file } of found) {
      let host: string;
      try {
        host = checkConcreteHost(named);
      } catch {
        continue;
      }
      kept.push({ host, file });
      if (allowed.has(host) || isHostAllowed(rules, host)) continue;
      allowed.add(host);
      const rule = insertPermissionRule(ctx, {
        projectId,
        workstreamId: null,
        toolName: NETWORK_TOOL,
        pattern: host,
        sourceInboxId: null,
        foundIn: file,
      });
      added.push({ host, source: { kind: 'file', file }, createdAt: rule.createdAt });
    }
    writeFoundHosts(ctx, projectId, kept);
    if (added.length > 0) {
      ctx.emit({
        type: EventType.NetworkHostsChanged,
        entityType: 'network_hosts',
        entityId: projectId,
        data: { hosts: added.map((h) => h.host) },
      });
    }
    return added;
  });
}

/**
 * The hosts a reading of the project's files found that the project may be given and is not given
 * now, each with the file that names it, in the reading's order. Allows nothing and keeps nothing:
 * the files may have been written by a lane since the project was added, so a host from them is
 * allowed only when the builder allows it by name.
 */
export function unallowedFoundHosts(
  db: DbReader,
  projectId: ProjectId,
  found: readonly FoundHostDto[],
): FoundHostDto[] {
  getProject(db, projectId);
  const rules = listPermissionRules(db, projectId, null);
  const listed = new Map<string, FoundHostDto>();
  for (const { host: named, file } of found) {
    let host: string;
    try {
      host = checkConcreteHost(named);
    } catch {
      continue;
    }
    if (listed.has(host) || isHostAllowed(rules, host)) continue;
    listed.set(host, { host, file });
  }
  return [...listed.values()];
}

/** True when a project-wide rule covers the host: its own name, or a `*.` pattern over it. */
function isHostAllowed(rules: readonly PermissionRuleDto[], host: string): boolean {
  return (
    matchPermissionRule({ toolName: NETWORK_TOOL, input: { host } }, rules, { realPaths: [] }) !==
    undefined
  );
}

/** Stores the project-wide rule a card's Always allow would; a host already allowed is answered, not stored again. */
export function allowNetworkHost(
  state: StateStore,
  projectId: ProjectId,
  raw: string,
): { readonly host: NetworkHostDto; readonly created: boolean } {
  const host = checkNetworkHost(raw);
  return state.write((ctx) => {
    getProject(ctx.tx, projectId);
    const existing = listNetworkHosts(ctx.tx, projectId).find((h) => h.host === host);
    if (existing) return { host: existing, created: false };
    const rule = insertPermissionRule(ctx, {
      projectId,
      workstreamId: null,
      toolName: NETWORK_TOOL,
      pattern: host,
      sourceInboxId: null,
    });
    ctx.emit({
      type: EventType.NetworkHostsChanged,
      entityType: 'network_hosts',
      entityId: projectId,
      data: { host },
    });
    return {
      host: { host, source: { kind: 'builder' }, createdAt: rule.createdAt },
      created: true,
    };
  });
}

/** Removes every project-wide rule for the host; a host not allowed is a `NotFoundError`. */
export function removeNetworkHost(
  state: StateStore,
  projectId: ProjectId,
  raw: string,
): NetworkHostDto {
  const host = raw.trim().toLowerCase();
  return state.write((ctx) => {
    getProject(ctx.tx, projectId);
    const existing = listNetworkHosts(ctx.tx, projectId).find((h) => h.host === host);
    if (!existing) throw new NotFoundError('network host', host);
    deleteProjectPermissionRules(ctx, { projectId, toolName: NETWORK_TOOL, pattern: host });
    ctx.emit({
      type: EventType.NetworkHostsChanged,
      entityType: 'network_hosts',
      entityId: projectId,
      data: { host },
    });
    return existing;
  });
}
