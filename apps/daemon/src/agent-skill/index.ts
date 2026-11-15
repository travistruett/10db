import { AgentSkillNotInstallable, EventType, type AgentSkillStatus } from '@10db/contracts';
import { getAppSetting, setAppSetting } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import {
  inspectAgentSkill,
  installAgentSkill,
  installedSkillDir,
  readSkillVersion,
  uninstallAgentSkill,
} from './install';

export { installedSkillDir } from './install';

export const AGENT_SKILL_SETTING = 'agent_skill_enabled';

/** Whether this daemon may write the skill into the builder's home, and where the shipped copy is. */
export type AgentSkillPlacement =
  | { readonly kind: 'installable'; readonly shippedDir: string }
  | {
      readonly kind: 'not_installable';
      readonly reason: AgentSkillNotInstallable;
      readonly shippedDir: string | null;
    };

/**
 * A run from source has no shipped copy; a daemon on a data dir other than the app's is a throwaway one
 * (a test, a second instance) and must not write into the builder's home; the app's own daemon installs.
 */
export function agentSkillPlacement(
  shippedDir: string | null,
  dataDir: string,
  appDataDir: string,
): AgentSkillPlacement {
  if (shippedDir === null)
    return { kind: 'not_installable', reason: AgentSkillNotInstallable.FromSource, shippedDir };
  if (dataDir !== appDataDir)
    return { kind: 'not_installable', reason: AgentSkillNotInstallable.OtherDataDir, shippedDir };
  return { kind: 'installable', shippedDir };
}

export interface AgentSkill {
  status(): AgentSkillStatus;
  /** Saves the setting, then installs or uninstalls when this daemon may; otherwise only saves it. */
  setEnabled(enabled: boolean): AgentSkillStatus;
  /** Installs when enabled and installable. A failure is logged and kept for `status`, never thrown. */
  atStart(): void;
  /** The version the app ships; null when it ships none. */
  shippedVersion(): string | null;
}

const StoredEnabled = z.boolean();

export function createAgentSkill(deps: {
  readonly state: StateStore;
  readonly placement: AgentSkillPlacement;
  readonly home: string;
  readonly logger: Logger;
}): AgentSkill {
  const { placement, home } = deps;
  let lastError: string | null = null;

  const enabled = (): boolean => {
    const parsed = StoredEnabled.safeParse(getAppSetting(deps.state.db, AGENT_SKILL_SETTING));
    return parsed.success ? parsed.data : true;
  };
  const shippedVersion = (): string | null =>
    placement.shippedDir === null ? null : readSkillVersion(placement.shippedDir);

  const apply = (): void => {
    if (placement.kind !== 'installable') return;
    try {
      if (enabled()) {
        const result = installAgentSkill(home, placement.shippedDir);
        lastError = result.error?.message ?? null;
        if (result.error)
          deps.logger.warn({ error: result.error.message }, 'agent skill link failed');
      } else {
        uninstallAgentSkill(home);
        lastError = null;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      deps.logger.warn({ error: lastError }, 'agent skill install failed');
    }
  };

  const status = (): AgentSkillStatus => {
    const found = inspectAgentSkill(home);
    return {
      enabled: enabled(),
      installable: placement.kind === 'installable' ? true : { reason: placement.reason },
      version: shippedVersion(),
      installedVersion: found.installedVersion,
      installedPath: installedSkillDir(home),
      links: found.links,
      error: lastError,
    };
  };

  return {
    status,
    setEnabled(next) {
      deps.state.write((ctx) => {
        setAppSetting(ctx, AGENT_SKILL_SETTING, next);
        ctx.emit({
          type: EventType.SettingsChanged,
          entityType: 'app_setting',
          entityId: AGENT_SKILL_SETTING,
          data: { enabled: next },
        });
      });
      apply();
      return status();
    },
    atStart: apply,
    shippedVersion,
  };
}
