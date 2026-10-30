import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const RuntimeInfo = z.object({
  pid: z.int(),
  port: z.int(),
  protocolVersion: z.int(),
  startedAt: z.iso.datetime(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfo>;

/** Write-then-rename, so a reader (the crash test, the desktop shell) never sees a half-written file. */
function writeAtomically(path: string, content: string, mode: number): void {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** `daemon.json` tells the UI where to connect; `ui-token` (0600) holds its bearer token. */
export function writeRuntimeFiles(dataDir: string, info: RuntimeInfo, token: string): void {
  writeAtomically(join(dataDir, 'ui-token'), token, 0o600);
  writeAtomically(join(dataDir, 'daemon.json'), `${JSON.stringify(info, null, 2)}\n`, 0o644);
}

export function readRuntimeInfo(dataDir: string): RuntimeInfo {
  return RuntimeInfo.parse(JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')));
}

export function removeRuntimeFiles(dataDir: string): void {
  rmSync(join(dataDir, 'daemon.json'), { force: true });
}
