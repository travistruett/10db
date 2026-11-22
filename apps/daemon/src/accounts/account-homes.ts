import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Provider, type AccountId } from '@10db/contracts';
import { giveOpenRouterAccountsAHome } from '@10db/db';
import { OPENROUTER_KEY_ACCOUNT, type Keychain } from '../environment';
import type { StateStore } from '../events';
import type { Logger } from '../log';

/** Where an account keeps its agent's login and config: under its own folder, named for the harness. */
export function accountConfigDir(root: string, id: AccountId, harness: Provider | null): string {
  return join(root, id, harness === Provider.Codex ? 'codex' : 'claude');
}

/** The directory and every level 10db made above it: readable by the builder only (accounts spec §4). */
export function makePrivate(root: string, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode passes through the umask, so each level is set explicitly.
  for (const path of [root, dirname(dir), dir]) chmodSync(path, 0o700);
}

/**
 * An OpenRouter account stored before it ran sessions has no directory, and without one Codex would run in
 * the builder's own `~/.codex`. This gives it its own at start, with the default lane cap.
 */
export function giveOpenRouterHomes(state: StateStore, root: string): void {
  state.write((ctx) => {
    for (const row of giveOpenRouterAccountsAHome(ctx, (id) =>
      accountConfigDir(root, id, Provider.Codex),
    )) {
      if (row.configDir !== null) makePrivate(root, row.configDir);
    }
  });
}

/** Removes the Keychain item an older version kept the OpenRouter key in; a key lives in its account's own item. */
export function removeLegacyOpenRouterKey(keychain: Keychain, logger: Pick<Logger, 'warn'>): void {
  try {
    keychain.remove(OPENROUTER_KEY_ACCOUNT);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.name : 'error' },
      'could not remove the old OpenRouter key item',
    );
  }
}
