// Spike 9: `caffeinate -i -w <pid>` holds a PreventUserIdleSystemSleep assertion while <pid> lives and exits by
// itself when <pid> dies, including on SIGKILL. As in M1, the holder (standing in for the daemon) spawns
// caffeinate as its own child with its own pid, so a crashed daemon leaves an orphaned caffeinate behind; it must
// still exit.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, finish, info } from './report.ts';

const HOLDER = `
const { spawn } = require('node:child_process');
const caf = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
process.stdout.write(String(caf.pid) + '\\n');
setInterval(() => {}, 1 << 30);
`;

function assertionLine(cafPid: number): string | undefined {
  const out = execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' });
  return out.split('\n').find((l) => l.includes(`pid ${cafPid}(caffeinate)`) && l.includes('PreventUserIdleSystemSleep'));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
  const holder = spawn(process.execPath, ['-e', HOLDER], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [chunk] = (await once(holder.stdout, 'data')) as [Buffer];
  const cafPid = Number(chunk.toString('utf8').trim());
  await sleep(1000);
  const line = assertionLine(cafPid);
  info(`${signal}: holder and caffeinate pids`, { holder: holder.pid ?? null, caffeinate: cafPid });
  info(`${signal}: assertion line`, line?.trim() ?? null);
  check(`${signal}: assertion held while the holder lives`, line !== undefined, line ? 'present' : 'absent');
  const t0 = Date.now();
  holder.kill(signal);
  const gone = await goneWithin(cafPid, 5000);
  check(`${signal}: orphaned caffeinate exits by itself after the holder dies`, gone, `${Date.now() - t0}ms`);
  check(`${signal}: assertion released`, assertionLine(cafPid) === undefined, 'absent after exit');
  if (!gone) process.kill(cafPid, 'SIGKILL');
}
finish();
