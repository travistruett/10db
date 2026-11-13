import { ConflictError, type BenchmarkStatusDto } from '@10db/contracts';
import type { ApiServices } from '../api';
import type { BenchmarkSync } from '../benchmarks';
import { AA_KEY_ACCOUNT, KeychainError, type Keychain } from '../environment';

/** The benchmark side of the HTTP API: the sync's status and the Artificial Analysis key. */
export type BenchmarkApiServices = Pick<
  ApiServices,
  'benchmarkStatus' | 'syncBenchmarks' | 'setBenchmarkKey' | 'removeBenchmarkKey'
>;

/** A Keychain that refuses is a conflict the builder can act on, not a server fault. */
async function keychainConflict<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof KeychainError) throw new ConflictError(error.message);
    throw error;
  }
}

export function createBenchmarkServices(deps: {
  readonly benchmarks: Pick<BenchmarkSync, 'status' | 'sync'>;
  readonly keychain: Keychain;
  /** Started with `TENDB_BENCHMARKS=off`: the key is not read or written, even to say whether it is set. */
  readonly off: boolean;
}): BenchmarkApiServices {
  /**
   * The sync records whether a key was there when it last ran; the card shows whether one is there now, so
   * a key set a second ago reads as set. The read is off the event loop: Settings asks on every visit.
   */
  const withLiveKey = async (status: BenchmarkStatusDto): Promise<BenchmarkStatusDto> => ({
    ...status,
    keyConfigured: deps.off
      ? false
      : await keychainConflict(
          async () => (await deps.keychain.readAsync(AA_KEY_ACCOUNT)) !== null,
        ),
    off: deps.off,
  });
  const refuseWhenOff = (): void => {
    if (deps.off) throw new ConflictError('Started with TENDB_BENCHMARKS=off');
  };
  return {
    benchmarkStatus: () => withLiveKey(deps.benchmarks.status()),
    async syncBenchmarks() {
      return withLiveKey(await deps.benchmarks.sync());
    },
    async setBenchmarkKey(input) {
      refuseWhenOff();
      await keychainConflict(() => {
        deps.keychain.write(AA_KEY_ACCOUNT, input.key);
      });
      // The sync checks the key with AA and never rejects; the status says it is running and the card follows it.
      void deps.benchmarks.sync();
      return withLiveKey(deps.benchmarks.status());
    },
    async removeBenchmarkKey() {
      refuseWhenOff();
      await keychainConflict(() => {
        deps.keychain.remove(AA_KEY_ACCOUNT);
      });
      return withLiveKey(deps.benchmarks.status());
    },
  };
}
