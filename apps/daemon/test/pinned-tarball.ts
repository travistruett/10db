import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentPin } from '../src/environment/agent-pins';
import {
  extractWithTar,
  tarballIntegrity,
  type InstallDeps,
} from '../src/environment/pinned-install';

/** A tarball laid out like npm's claude-code-darwin-arm64: `package/claude` and a licence beside it. */
export function buildClaudeTarball(root: string, name: string, versionOutput: string): string {
  const src = join(root, `src-${name}`);
  mkdirSync(join(src, 'package'), { recursive: true });
  const claude = join(src, 'package', 'claude');
  writeFileSync(claude, `#!/bin/sh\necho "${versionOutput}"\n`);
  chmodSync(claude, 0o755);
  writeFileSync(join(src, 'package', 'LICENSE.md'), 'licence');
  const tarball = join(root, `${name}.tgz`);
  execFileSync('/usr/bin/tar', ['-czf', tarball, '-C', src, 'package']);
  return tarball;
}

/** The pin that records `tarball`'s checksum. */
export async function pinForTarball(tarball: string, version = '1.2.3'): Promise<AgentPin> {
  return {
    tool: 'claude',
    label: 'Claude Code',
    version,
    sha512: await tarballIntegrity(tarball),
    tarballUrl: 'https://registry.example.test/claude.tgz',
    latestUrl: 'https://registry.example.test/latest',
    member: 'package/claude',
    strip: 1,
    executable: 'claude',
  };
}

/** The network, served from a file; counts the downloads. */
export function servingTarball(tarball: string): InstallDeps & { calls: () => number } {
  let calls = 0;
  return {
    download: (_url, to) => {
      calls += 1;
      copyFileSync(tarball, to);
      return Promise.resolve();
    },
    extract: extractWithTar,
    calls: () => calls,
  };
}
