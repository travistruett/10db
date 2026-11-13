import { AccountKind } from '@10db/contracts';
import {
  accountSecretRef,
  getAccountRow,
  getJudgeConfig,
  insertAccount,
  listAccounts,
  patchJudgeConfig,
  recordAccountSecret,
} from '@10db/db';
import { OPENROUTER_KEY_ACCOUNT, secretFingerprint, type Keychain } from '../environment';
import type { StateStore } from '../events';
import type { Logger } from '../log';

/** The labels tried for the account the old key moves into, in order, then "OpenRouter 2", "OpenRouter 3"... */
const LABELS = ['OpenRouter', 'OpenRouter key'] as const;
const LABEL_BASE = 'OpenRouter';
const FIRST_NUMBERED = 2;

function freeLabel(taken: ReadonlySet<string>): string {
  for (const label of LABELS) if (!taken.has(label)) return label;
  for (let n = FIRST_NUMBERED; ; n += 1) {
    const label = `${LABEL_BASE} ${String(n)}`;
    if (!taken.has(label)) return label;
  }
}

/**
 * Moves the OpenRouter key kept in its own Keychain item into an OpenRouter account, once, so a key lives in one
 * place under the rules every account secret follows. It runs at start and never throws: a failure is logged by
 * error name and the next start tries again.
 *
 * 1. Read the old item; unreadable or absent, stop.
 * 2. An OpenRouter account (archived or not) already holds this key: remove the old item, stop.
 * 3. Any other OpenRouter account that is not archived: the builder has set one up, so leave everything.
 * 4. Otherwise create the account, write its key, read it back, record the fingerprint and, when decisions run
 *    on no account, point them at it. The row and the setting commit together or not at all, and the Keychain
 *    write comes before the commit. Only then is the old item removed; a failure there is finished by step 2 on
 *    the next start.
 */
export async function moveOpenRouterKey(deps: {
  readonly state: StateStore;
  readonly keychain: Keychain;
  readonly logger: Pick<Logger, 'warn'>;
}): Promise<void> {
  const fail = (what: string, error: unknown): void => {
    deps.logger.warn(
      { step: what, err: error instanceof Error ? error.name : 'error' },
      'could not move the OpenRouter key into an account',
    );
  };
  let key: string | null;
  try {
    key = await deps.keychain.readAsync(OPENROUTER_KEY_ACCOUNT);
  } catch (error) {
    fail('read', error);
    return;
  }
  if (key === null) return;
  const old = key;
  const removeOld = (): void => {
    try {
      deps.keychain.remove(OPENROUTER_KEY_ACCOUNT);
    } catch (error) {
      fail('remove', error);
    }
  };
  try {
    const accounts = listAccounts(deps.state.db, { includeArchived: true });
    const openRouter = accounts.filter((a) => a.kind === AccountKind.OpenRouter);
    const fingerprint = secretFingerprint(old);
    const holdsIt = openRouter.some(
      (a) => getAccountRow(deps.state.db, a.id).secretFingerprint === fingerprint,
    );
    if (holdsIt) {
      removeOld();
      return;
    }
    if (openRouter.some((a) => !a.archived)) return;
    const taken = new Set(accounts.map((a) => a.label));
    const written: { ref: string | null } = { ref: null };
    try {
      deps.state.write((ctx) => {
        const created = insertAccount(
          ctx,
          { kind: AccountKind.OpenRouter, label: freeLabel(taken) },
          { configDirFor: () => '' },
        );
        const ref = accountSecretRef(created.id);
        written.ref = ref;
        deps.keychain.write(ref, old);
        if (deps.keychain.read(ref) !== old) throw new Error('read-back differs');
        recordAccountSecret(ctx, created.id, fingerprint);
        if (getJudgeConfig(ctx.tx).accountId === null)
          patchJudgeConfig(ctx, { accountId: created.id });
      });
    } catch (error) {
      // The row was rolled back; take the item it pointed at out too, so nothing orphaned stays in the Keychain.
      if (written.ref !== null) {
        try {
          deps.keychain.remove(written.ref);
        } catch {
          // The failure that matters is the one being reported.
        }
      }
      fail('create', error);
      return;
    }
    removeOld();
  } catch (error) {
    fail('move', error);
  }
}
