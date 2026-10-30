import { describe, expect, it } from 'vitest';
import { cachedProcessTable, parseCwds, parseProcessTable, type ProcessRow } from './process-table';

describe('parseCwds', () => {
  it('reads each process’s working directory from lsof’s field output', () => {
    const output = ['p501', 'fcwd', 'n/Users/me/repo', 'p777', 'fcwd', 'n/private/tmp/x y', ''];
    expect(parseCwds(output.join('\n'))).toEqual(
      new Map([
        [501, '/Users/me/repo'],
        [777, '/private/tmp/x y'],
      ]),
    );
  });

  it('leaves out a process with no path, and lines it cannot read', () => {
    expect(parseCwds('p12\nfcwd\np13\nfcwd\nnrelative\npnot\nn/x\n')).toEqual(new Map());
  });
});

describe('parseProcessTable', () => {
  it('reads ps output with a start time that has a padded day', () => {
    const output = [
      '    1     0     1 Mon Oct 12 08:00:01 2026',
      '  501   1   501 Thu Oct  5 12:00:00 2026',
      '12345 501 12345 Thu Oct 30 12:34:56 2026',
      '',
    ].join('\n');
    expect(parseProcessTable(output)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, startedAt: 'Mon Oct 12 08:00:01 2026' },
      { pid: 501, ppid: 1, pgid: 501, startedAt: 'Thu Oct  5 12:00:00 2026' },
      { pid: 12345, ppid: 501, pgid: 12345, startedAt: 'Thu Oct 30 12:34:56 2026' },
    ]);
  });

  it('gives the same start time text as ps -o lstart= -p, trimmed', () => {
    const [row] = parseProcessTable('  501   1   501 Thu Oct  5 12:00:00 2026\n');
    expect(row?.startedAt).toBe('Thu Oct  5 12:00:00 2026');
  });

  it('leaves out a line it cannot read', () => {
    expect(
      parseProcessTable('PID PPID PGID STARTED\nnot a row\n  7   1   7 Thu Oct 30 12:00:00 2026'),
    ).toEqual([{ pid: 7, ppid: 1, pgid: 7, startedAt: 'Thu Oct 30 12:00:00 2026' }]);
  });
});

describe('cachedProcessTable', () => {
  const rows: ProcessRow[] = [{ pid: 7, ppid: 1, pgid: 7, startedAt: 'x' }];

  it('shares one reading within the window, and reads again after it', async () => {
    let reads = 0;
    let clock = 0;
    const table = cachedProcessTable(
      () => {
        reads += 1;
        return Promise.resolve(rows);
      },
      500,
      () => clock,
    );
    await Promise.all([table(), table(), table()]);
    expect(reads).toBe(1);
    clock = 499;
    await table();
    expect(reads).toBe(1);
    clock = 500;
    await table();
    expect(reads).toBe(2);
  });

  it('does not keep a failed reading', async () => {
    let reads = 0;
    const table = cachedProcessTable(
      () => {
        reads += 1;
        return reads === 1 ? Promise.reject(new Error('ps failed')) : Promise.resolve(rows);
      },
      500,
      () => 0,
    );
    await expect(table()).rejects.toThrow('ps failed');
    await expect(table()).resolves.toEqual(rows);
  });
});
