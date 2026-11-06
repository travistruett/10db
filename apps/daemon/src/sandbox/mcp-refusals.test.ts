import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { readRefusedHosts, refusalPreload, watchRefusals } from './mcp-refusals';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-refusals-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs a stand-in for srt's command line under the preload, and answers what it printed on stderr. */
function runUnderPreload(script: string): { stderr: string; log: string } {
  const log = join(dir, 'refused.log');
  const preload = join(dir, 'preload.cjs');
  const cli = join(dir, 'cli.mjs');
  writeFileSync(log, '');
  writeFileSync(preload, refusalPreload(log));
  writeFileSync(cli, script);
  const result = spawnSync(process.execPath, ['-r', preload, cli], { encoding: 'utf8' });
  return { stderr: result.stderr, log: readFileSync(log, 'utf8') };
}

describe("srt's debug log, read for the hosts its proxy refused", () => {
  it('records each refused host once, whichever way it was refused', () => {
    const { log } = runUnderPreload(`
      console.error('[SandboxDebug] Connection blocked to Billing.us-east-1.api.aws:443');
      console.error('[SandboxDebug] Connection blocked to billing.us-east-1.api.aws:443');
      console.error('[SandboxDebug] HTTP request blocked to plain.example.org:80');
      console.error('[SandboxDebug] Connection blocked to [2001:db8::1]:443');
    `);
    expect(log.split('\n').filter(Boolean)).toEqual([
      'billing.us-east-1.api.aws',
      'plain.example.org',
      '2001:db8::1',
    ]);
  });

  it("keeps srt's debug log off stderr, and leaves everything else on it", () => {
    const { stderr } = runUnderPreload(`
      console.error('[SandboxDebug] Connection allowed to a.example.org:443');
      console.warn('[SandboxDebug] something\\nover two lines');
      console.error('the server says', 'hello');
      process.stderr.write('written directly\\n');
    `);
    expect(stderr).toBe('the server says hello\nwritten directly\n');
  });

  it('records nothing for a message that merely contains the words', () => {
    const { log } = runUnderPreload(`
      console.error('Connection blocked to evil.example.org:443');
      console.error('[SandboxDebug] note: Connection blocked to evil.example.org:443');
    `);
    expect(log).toBe('');
  });

  it('reads whole lines as hosts and drops what is no host name', () => {
    expect(
      readRefusedHosts(
        ['a.example.org', '', 'B.Example.org', 'has space.org', 'x'.repeat(300), '*.bad'].join(
          '\n',
        ),
      ),
    ).toEqual(['a.example.org', 'b.example.org']);
  });
});

describe('watching a server’s refusal log', () => {
  it('reports each host once, as the log grows, and reads a line only when it is whole', () => {
    const clock = new ManualClock();
    const log = join(dir, 'refused.log');
    writeFileSync(log, '');
    const seen: string[] = [];
    const stop = watchRefusals(log, (host) => seen.push(host), clock);
    appendFileSync(log, 'a.example.org\n');
    clock.advance(2000);
    expect(seen).toEqual(['a.example.org']);
    appendFileSync(log, 'a.example.org\nb.example.org\nc.exam');
    clock.advance(2000);
    expect(seen).toEqual(['a.example.org', 'b.example.org']);
    appendFileSync(log, 'ple.org\n');
    clock.advance(2000);
    expect(seen).toEqual(['a.example.org', 'b.example.org', 'c.example.org']);
    stop();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('takes a last look when stopped', () => {
    const clock = new ManualClock();
    const log = join(dir, 'refused.log');
    writeFileSync(log, '');
    const seen: string[] = [];
    const stop = watchRefusals(log, (host) => seen.push(host), clock);
    appendFileSync(log, 'late.example.org\n');
    stop();
    expect(seen).toEqual(['late.example.org']);
    appendFileSync(log, 'later.example.org\n');
    stop();
    clock.advance(10_000);
    expect(seen).toEqual(['late.example.org']);
  });

  it('survives a log that is gone', () => {
    const clock = new ManualClock();
    const stop = watchRefusals(join(dir, 'refused.log'), () => undefined, clock);
    clock.advance(2000);
    expect(() => {
      stop();
    }).not.toThrow();
  });
});
