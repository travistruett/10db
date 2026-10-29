import {
  EventType,
  InvalidError,
  NotFoundError,
  type NetworkHostDto,
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
import { storableRule } from './rules';

/** The tool name of the sandbox's ask to reach a host; the same rules a card answer stores. */
const NETWORK_TOOL = 'SandboxNetworkAccess';

const LOOPBACK_NAME = /(^|\.)localhost$/;
const LOOPBACK_V4 = /^(127(\.\d{1,3}){3}|0\.0\.0\.0)$/;
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
  const rule = storableRule(NETWORK_TOOL, host);
  const pattern = rule?.pattern ?? null;
  const labels = (pattern ?? '').replace(/^\*\./, '').split('.');
  if (pattern === null || !isSandboxDomain(pattern) || labels.includes('')) {
    throw refusal(
      `${host} can't be listed: use a host name such as index.crates.io, or *. and a domain such as *.crates.io.`,
    );
  }
  if (labels.length < 2) {
    throw refusal(`${host} is too broad: it covers a whole top-level domain. Name the host.`);
  }
  return pattern;
}

/** The project's allowed hosts, oldest first, one per host however many rules name it. */
export function listNetworkHosts(db: DbReader, projectId: ProjectId): NetworkHostDto[] {
  const seen = new Map<string, NetworkHostDto>();
  for (const rule of listPermissionRules(db, projectId, null)) {
    if (rule.toolName !== NETWORK_TOOL || rule.pattern === null) continue;
    if (!seen.has(rule.pattern))
      seen.set(rule.pattern, { host: rule.pattern, createdAt: rule.createdAt });
  }
  return [...seen.values()];
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
    return { host: { host, createdAt: rule.createdAt }, created: true };
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
