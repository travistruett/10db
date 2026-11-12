import {
  effectiveTrust,
  TRUST_DEFAULTS,
  TRUST_SWITCH_KEYS,
  type ProjectId,
  type TrustOverrides,
  type TrustSwitches,
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
    const off: TrustOverrides = { plugins: {} };
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
  return parsed;
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
