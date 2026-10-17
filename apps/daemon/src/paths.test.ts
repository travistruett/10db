import { HARNESS_PLUGIN_DIR } from '@10db/harness';
import { describe, expect, it } from 'vitest';
import { resolveHarnessDir } from './paths';

describe('resolveHarnessDir', () => {
  it('uses the harness package when running from source', () => {
    expect(resolveHarnessDir()).toBe(HARNESS_PLUGIN_DIR);
  });
});
