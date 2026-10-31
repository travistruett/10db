import { JudgeStatusDto, type JudgeKeyInput } from '@10db/contracts';
import { readJson, type DaemonClient } from './client';

/**
 * Sends the OpenRouter key to the daemon, which writes it to the Keychain. A plain function rather
 * than a mutation hook: TanStack keeps a mutation's variables in its cache after the request ends.
 * The caller refreshes the judge status afterwards; nothing here touches a cache.
 */
export async function sendJudgeKey(
  client: DaemonClient,
  input: JudgeKeyInput,
): Promise<JudgeStatusDto> {
  return readJson(await client.judge.key.$put({ json: input }), JudgeStatusDto);
}

/** Deletes the Keychain item. */
export async function removeJudgeKey(client: DaemonClient): Promise<JudgeStatusDto> {
  return readJson(await client.judge.key.$delete(), JudgeStatusDto);
}
