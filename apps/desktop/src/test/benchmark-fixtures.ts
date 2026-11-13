import { BenchmarkStatusDto } from '@10db/contracts';

/** An Artificial Analysis status with no key and no sync; `overrides` set what a test is about. */
export function benchmarkStatusDto(overrides: Record<string, unknown> = {}): BenchmarkStatusDto {
  return BenchmarkStatusDto.parse({
    keyConfigured: false,
    lastSyncAt: null,
    lastSuccessAt: null,
    outcome: null,
    message: null,
    models: 0,
    indexVersion: null,
    unmeasuredProfiles: [],
    off: false,
    syncing: false,
    ...overrides,
  });
}
