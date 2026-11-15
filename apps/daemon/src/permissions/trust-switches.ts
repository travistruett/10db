import {
  effectiveTrust,
  TRUST_DEFAULTS,
  TRUST_SWITCH_KEYS,
  type ProjectId,
  type TrustOverrides,
  type TrustSwitches,
  YourMcpServerKey,
} from '@10db/contracts';
import {
  getAppSetting,
  setAppSetting,
  type DbReader,
  type Json,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';

const APP_TRUST_SETTING = 'trust';
const MCP_APPROVALS_SETTING = 'trust.mcp-approvals';

function projectTrustSetting(projectId: ProjectId): string {
  return `trust.${projectId}`;
}

/** Told each stored value that is not the shape 10db reads, which then reads as off. */
export type OnInvalid = (key: string, stored: unknown) => void;

/** Logs each stored switch value that reads as off for not being the shape 10db reads. */
export function warnInvalidTrust(log: { warn(fields: object, message: string): void }): OnInvalid {
  return (key, stored) => {
    log.warn(
      { key, stored },
      'a stored trust switch is not a shape 10db reads, so it reads as off',
    );
  };
}

const StoredObject = z.record(z.string(), z.unknown());

/**
 * Reads a stored switch object key by key, so one bad key turns only itself off and a key added later reads
 * as absent. A value that is not an object at all is not trusted: every switch reads as off.
 */
function parseStored(setting: string, stored: unknown, onInvalid: OnInvalid): TrustOverrides {
  if (stored === undefined) return {};
  const object = StoredObject.safeParse(stored);
  if (!object.success) {
    onInvalid(setting, stored);
    const off: TrustOverrides = { plugins: {}, yourMcpServers: false, mcpServers: {} };
    for (const key of TRUST_SWITCH_KEYS) off[key] = false;
    return off;
  }
  const parsed: TrustOverrides = {};
  for (const key of TRUST_SWITCH_KEYS) {
    const value = object.data[key];
    if (value === undefined) continue;
    const flag = z.boolean().safeParse(value);
    if (!flag.success) onInvalid(key, value);
    parsed[key] = flag.success && flag.data;
  }
  const plugins = object.data['plugins'];
  if (plugins !== undefined) parsed.plugins = parsePlugins(plugins, onInvalid);
  const yours = object.data['yourMcpServers'];
  if (yours !== undefined) {
    const flag = z.boolean().safeParse(yours);
    if (!flag.success) onInvalid('yourMcpServers', yours);
    parsed.yourMcpServers = flag.success && flag.data;
  }
  const servers = object.data['mcpServers'];
  if (servers !== undefined) parsed.mcpServers = parseServerSwitches(servers, onInvalid);
  return parsed;
}

/** Each stored server switch; a key that is no server's key is dropped, and a value not a boolean is off. */
function parseServerSwitches(
  stored: unknown,
  onInvalid: OnInvalid,
): Record<YourMcpServerKey, boolean> {
  const object = StoredObject.safeParse(stored);
  if (!object.success) {
    onInvalid('mcpServers', stored);
    return {};
  }
  const servers: Record<YourMcpServerKey, boolean> = {};
  for (const [name, value] of Object.entries(object.data)) {
    const key = YourMcpServerKey.safeParse(name);
    if (!key.success) {
      onInvalid(`mcpServers.${name}`, value);
      continue;
    }
    const flag = z.boolean().safeParse(value);
    if (!flag.success) onInvalid(`mcpServers.${name}`, value);
    servers[key.data] = flag.success && flag.data;
  }
  return servers;
}

function parsePlugins(stored: unknown, onInvalid: OnInvalid): Record<string, boolean> {
  const object = StoredObject.safeParse(stored);
  if (!object.success) {
    onInvalid('plugins', stored);
    return {};
  }
  const plugins: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(object.data)) {
    if (id === '') continue;
    const flag = z.boolean().safeParse(value);
    if (!flag.success) onInvalid(`plugins.${id}`, value);
    plugins[id] = flag.success && flag.data;
  }
  return plugins;
}

function asJson(overrides: TrustOverrides): Json {
  const stored: Record<string, Json> = {};
  for (const key of TRUST_SWITCH_KEYS) {
    const value = overrides[key];
    if (value !== undefined) stored[key] = value;
  }
  if (overrides.plugins !== undefined) stored['plugins'] = { ...overrides.plugins };
  if (overrides.yourMcpServers !== undefined) stored['yourMcpServers'] = overrides.yourMcpServers;
  if (overrides.mcpServers !== undefined) stored['mcpServers'] = { ...overrides.mcpServers };
  return stored;
}

/** The app-wide switches; an absent key takes its default. */
export function appTrustSwitches(db: DbReader, onInvalid: OnInvalid): TrustSwitches {
  const stored = parseStored(APP_TRUST_SETTING, getAppSetting(db, APP_TRUST_SETTING), onInvalid);
  return effectiveTrust(TRUST_DEFAULTS, stored);
}

export function setAppTrustSwitches(ctx: WriteContext, switches: TrustSwitches): void {
  setAppSetting(ctx, APP_TRUST_SETTING, asJson(switches));
}

/** A project's own switches; an absent key is no override. */
export function projectTrustOverrides(
  db: DbReader,
  projectId: ProjectId,
  onInvalid: OnInvalid,
): TrustOverrides {
  const setting = projectTrustSetting(projectId);
  return parseStored(setting, getAppSetting(db, setting), onInvalid);
}

export function setProjectTrustOverrides(
  ctx: WriteContext,
  projectId: ProjectId,
  overrides: TrustOverrides,
): void {
  setAppSetting(ctx, projectTrustSetting(projectId), asJson(overrides));
}

/** The switches a project's next session starts with. */
export function trustSwitchesFor(
  db: DbReader,
  projectId: ProjectId,
  onInvalid: OnInvalid,
): TrustSwitches {
  return effectiveTrust(
    appTrustSwitches(db, onInvalid),
    projectTrustOverrides(db, projectId, onInvalid),
  );
}

const StoredApprovals = z.record(YourMcpServerKey, z.string().regex(/^[0-9a-f]{64}$/));

/**
 * The config hash the builder approved for each of their own MCP servers. A stored value that is not the
 * shape is no approvals, the safe side, and `onInvalid` is told.
 */
export function mcpApprovals(
  db: DbReader,
  onInvalid?: (stored: unknown) => void,
): ReadonlyMap<YourMcpServerKey, string> {
  const stored = getAppSetting(db, MCP_APPROVALS_SETTING);
  if (stored === undefined) return new Map();
  const parsed = StoredApprovals.safeParse(stored);
  if (!parsed.success) {
    onInvalid?.(stored);
    return new Map();
  }
  return new Map(
    Object.entries(parsed.data).map(([key, hash]) => [YourMcpServerKey.parse(key), hash]),
  );
}

/** Approves one server's exact config, replacing any earlier approval of it. */
export function approveMcpServer(
  ctx: WriteContext,
  key: YourMcpServerKey,
  configHash: string,
): void {
  const approvals: Record<string, Json> = Object.fromEntries(mcpApprovals(ctx.tx));
  approvals[key] = configHash;
  setAppSetting(ctx, MCP_APPROVALS_SETTING, approvals);
}
