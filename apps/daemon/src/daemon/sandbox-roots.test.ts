import { mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { silentLogger } from '../log';
import { SandboxTempDirError, type GateSandbox, type LaneSandbox } from '../sandbox';
import { createGateRunner } from '../verify';
import { laneWrittenRootsOf, openSandboxRoots, sandboxesFor } from './sandbox-roots';

let base: TempDir;
beforeEach(() => {
  base = tempDir('roots');
});
afterEach(() => {
  base.cleanup();
});

/** Every root under the test's own dir, as a test daemon is given them. */
const given = () => ({
  tmpRoot: join(base.path, 't'),
  codexLaneTempRoot: join(base.path, 'l'),
  filesRoot: join(base.path, 'r'),
  systemTempRoots: [join(base.path, 'sys'), join(base.path, 'var-tmp')],
});

/** Builders that record whether they were asked for a sandbox. */
function builders() {
  const built: string[] = [];
  const never = (what: string) => () => {
    built.push(what);
    return Promise.reject(new Error(`${what} ran`));
  };
  return {
    built,
    build: {
      lane: (): LaneSandbox => {
        built.push('lane');
        return { forSession: never('lane session') };
      },
      gate: (): GateSandbox => {
        built.push('gate');
        return { forRun: never('gate run') };
      },
    },
  };
}

describe('the sandbox roots', () => {
  it("makes each root private and counts every one lanes write: both lanes' roots and the system temp dirs", () => {
    const roots = openSandboxRoots(given(), base.path);
    expect(roots.refusal).toBeNull();
    for (const root of [roots.temp, roots.codexLanes, roots.files])
      expect(statSync(root).mode & 0o777, root).toBe(0o700);
    expect(laneWrittenRootsOf(roots)).toEqual([
      roots.temp,
      roots.codexLanes,
      ...given().systemTempRoots,
    ]);
    const { built, build } = builders();
    sandboxesFor(roots, build);
    expect(built).toEqual(['lane', 'gate']);
  });

  it('refuses every lane session and every gate when a root is refused, and builds neither', async () => {
    mkdirSync(join(base.path, 'elsewhere'));
    symlinkSync(join(base.path, 'elsewhere'), join(base.path, 'r'));
    const roots = openSandboxRoots(given(), base.path);
    expect(roots.refusal).toBeInstanceOf(SandboxTempDirError);
    const { built, build } = builders();
    const { lane, gate } = sandboxesFor(roots, build);
    expect(built).toEqual([]);
    await expect(
      lane.forSession({
        project: {
          id: mintId('Project'),
          repoPath: base.path,
          sandboxLoopback: false,
          gateCommand: 'true',
        },
        env: {},
        rules: [],
        resumeProviderSessionId: null,
        configDir: join(base.path, '.claude'),
        checkouts: [base.path],
        mcpServers: {},
      }),
    ).rejects.toThrow(join(base.path, 'r'));
    // The gate runner fails the gate with the refusal, as for any sandbox it can't build.
    const runner = createGateRunner({ sandbox: gate, logger: silentLogger });
    const result = await runner.run({
      project: { repoPath: base.path, sandboxLoopback: false },
      command: 'touch ran',
      logPath: join(base.path, 'gate.log'),
      timeoutMs: 10_000,
      env: {},
      rules: [],
      checkouts: [base.path],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.tail).toContain(
      `10db could not start the gate's sandbox: The sandbox root ${join(base.path, 'r')}`,
    );
    expect(readdirSync(base.path)).not.toContain('ran');
    expect(readdirSync(join(base.path, 'elsewhere'))).toEqual([]);
  });
});
