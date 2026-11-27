import { DEVICE_LABEL_MAX } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { readTailnetName, type CliResult, type TailscaleRun } from './tailscale-cli';

const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const whois = (node: unknown) => ok(JSON.stringify({ Node: node }));

function fakeRun(result: CliResult) {
  const calls: (readonly string[])[] = [];
  const run: TailscaleRun = (args) => {
    calls.push(args);
    return Promise.resolve(result);
  };
  return { run, calls };
}

describe('readTailnetName', () => {
  it('runs the CLI only for a bare Tailscale address, picks the best name, and is null on any failure', async () => {
    const answer = whois({ Hostinfo: { Hostname: 'phone' } });
    const accepted = ['100.64.0.0', '100.127.255.255', '100.100.1.2', 'fd7a:115c:a1e0::1'];
    const refused = [
      '100.63.255.255',
      '100.128.0.0',
      '192.168.1.5',
      '127.0.0.1',
      'fd7a:115c:a1e1::1',
      '::1',
      '-h',
      '--json',
      '100.64.0.9:443',
      '[fd7a:115c:a1e0::1]',
      'host.tail1234.ts.net',
      'fd7a:115c:a1e0::1%en0',
      '::ffff:100.64.0.9',
      '::ffff:6440:9',
      '',
    ];
    for (const ip of accepted) {
      const { run, calls } = fakeRun(answer);
      expect(await readTailnetName(run, ip, 1000), ip).toBe('phone');
      expect(calls).toEqual([['whois', '--json', ip]]);
    }
    for (const ip of refused) {
      const { run, calls } = fakeRun(answer);
      expect(await readTailnetName(run, ip, 1000), ip).toBeNull();
      expect(calls, ip).toEqual([]);
    }

    const read = (node: unknown) => readTailnetName(fakeRun(whois(node)).run, '100.64.0.9', 1000);
    expect(
      await read({ Hostinfo: { Hostname: ' Travis’s S26 ' }, ComputedName: 'travis-s26' }),
    ).toBe('Travis’s S26');
    expect(await read({ Hostinfo: { Hostname: 'localhost' }, ComputedName: 'travis-s26' })).toBe(
      'travis-s26',
    );
    expect(await read({ Hostinfo: { Hostname: '' }, Name: 'travis-s26.tail1234.ts.net.' })).toBe(
      'travis-s26',
    );
    expect(await read({ Name: 'travis-s26.tail1234.ts.net.' })).toBe('travis-s26');
    expect(await read({ Hostinfo: { Hostname: 'x'.repeat(DEVICE_LABEL_MAX + 20) } })).toBe(
      'x'.repeat(DEVICE_LABEL_MAX),
    );
    expect(await read({ Hostinfo: { Hostname: '  ' } })).toBeNull();
    expect(await read(null)).toBeNull();

    const readResult = (result: CliResult) =>
      readTailnetName(fakeRun(result).run, '100.64.0.9', 1000);
    expect(await readResult({ code: null, stdout: '', stderr: '', timedOut: true })).toBeNull();
    expect(
      await readResult({ code: 1, stdout: '{}', stderr: 'no such peer', timedOut: false }),
    ).toBeNull();
    expect(await readResult(ok('not json'))).toBeNull();
    expect(await readResult(ok('{"Node":{"Hostinfo":{"Hostname":7}}}'))).toBeNull();
    const throwing: TailscaleRun = () => Promise.reject(new Error('boom'));
    expect(await readTailnetName(throwing, '100.64.0.9', 1000)).toBeNull();
  });
});
