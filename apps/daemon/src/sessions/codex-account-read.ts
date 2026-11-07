import { knownEfforts } from '@10db/contracts';
import type { z } from 'zod';
import type { SeenAccount } from './account-check';
import { AccountReadResponse, ModelListResponse, RateLimitsReadResponse } from './codex-protocol';
import { AccountProbeError } from './types';

/** One request to a running app-server, answered as the schema reads it. */
export type CodexCall = <T>(method: string, params: unknown, schema: z.ZodType<T>) => Promise<T>;

/** Who 10db tells `codex app-server` it is. */
export const CODEX_CLIENT_INFO = { name: '10db', title: '10db', version: '1' } as const;

const NOTHING: SeenAccount = {
  email: undefined,
  organization: undefined,
  subscriptionType: undefined,
  tokenSource: undefined,
  apiKeySource: undefined,
  apiProvider: undefined,
};

/**
 * Who the initialized app-server is signed in as. A ChatGPT identity is the email and the workspace
 * together, and only the usage read names the workspace: without it the account could be confirmed
 * as the wrong one, so a missing workspace rejects with an `AccountProbeError`. `withModels` also
 * reads the model list, which only informs Settings and the catalogue, so a failed read leaves it unset.
 */
export async function readSeenAccount(call: CodexCall, withModels: boolean): Promise<SeenAccount> {
  const { account } = await call('account/read', { refreshToken: false }, AccountReadResponse);
  if (account === null) return NOTHING;
  // A key or Bedrock login is not a ChatGPT plan; the account check refuses it by its provider.
  if (account.type !== 'chatgpt') return { ...NOTHING, apiProvider: account.type };
  const usage = await call('account/rateLimits/read', undefined, RateLimitsReadResponse);
  if (usage.accountId === null || usage.accountId === undefined)
    throw new AccountProbeError('Codex did not name the workspace');
  const models = withModels
    ? await call('model/list', {}, ModelListResponse).catch(() => undefined)
    : undefined;
  return {
    ...NOTHING,
    apiProvider: 'chatgpt',
    email: account.email ?? undefined,
    subscriptionType: account.planType,
    organization: usage.accountId,
    ...(models === undefined
      ? {}
      : {
          models: models.data
            .filter((m) => m.hidden !== true)
            .map((m) => ({
              id: m.model,
              resolvedId: null,
              efforts: knownEfforts(
                (m.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort),
              ),
            })),
        }),
  };
}
