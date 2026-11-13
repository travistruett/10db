import { BenchmarkStatusDto, type BenchmarkKeyInput } from '@10db/contracts';
import { readJson, type DaemonClient } from './client';

/**
 * Sends the Artificial Analysis key to the daemon, which writes it to the Keychain and starts a sync. A plain
 * function rather than a mutation hook: TanStack keeps a mutation's variables in its cache after the request
 * ends. The caller puts the answer in the status cache; nothing here touches one.
 */
export async function sendBenchmarkKey(
  client: DaemonClient,
  input: BenchmarkKeyInput,
): Promise<BenchmarkStatusDto> {
  return readJson(await client.benchmarks.key.$put({ json: input }), BenchmarkStatusDto);
}

/** Deletes the Keychain item. */
export async function removeBenchmarkKey(client: DaemonClient): Promise<BenchmarkStatusDto> {
  return readJson(await client.benchmarks.key.$delete(), BenchmarkStatusDto);
}
