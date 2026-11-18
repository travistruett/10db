import { describe, expect, it } from 'vitest';
import {
  cachedProcessTable,
  parseOpenPaths,
  parseProcessTable,
  type ProcessRow,
} from './process-table';

describe('parseOpenPaths', () => {
  it('reads each process’s working directory and open files from lsof’s field output', () => {
    const rows: { name: string; output: string[]; expected: Map<number, string[]> }[] = [
      {
        name: 'cwd, text and open files, a socket left out',
        output: [
          'p501',
          'fcwd',
          'n/Users/me/repo',
          'ftxt',
          'n/bin/zsh',
          'f1',
          'n/private/tmp/10db-abc123/claude-501/s/tasks/b1.output',
          'f3',
          'nlocalhost:3000',
          'p777',
          'fcwd',
          'n/private/tmp/x y',
          '',
        ],
        expected: new Map([
          [
            501,
            ['/Users/me/repo', '/bin/zsh', '/private/tmp/10db-abc123/claude-501/s/tasks/b1.output'],
          ],
          [777, ['/private/tmp/x y']],
        ]),
      },
      {
        name: 'a process with no path, and lines it cannot read',
        output: ['p12', 'fcwd', 'p13', 'fcwd', 'nrelative', 'pnot', 'n/x', ''],
        expected: new Map(),
      },
    ];
    for (const row of rows) {
      expect.soft(parseOpenPaths(row.output.join('\n')), row.name).toEqual(row.expected);
    }
  });
});

describe('parseProcessTable', () => {
  it('reads pid, parent, group, the trimmed start time and the program from ps output', () => {
    const rows: { name: string; output: string; expected: ProcessRow[] }[] = [
      {
        name: 'a start time with a padded day',
        output: [
          '    1     0     1 Mon Oct 12 08:00:01 2026',
          '  501   1   501 Thu Oct  5 12:00:00 2026',
          '12345 501 12345 Thu Oct 30 12:34:56 2026',
          '',
        ].join('\n'),
        expected: [
          { pid: 1, ppid: 0, pgid: 1, startedAt: 'Mon Oct 12 08:00:01 2026' },
          { pid: 501, ppid: 1, pgid: 501, startedAt: 'Thu Oct  5 12:00:00 2026' },
          { pid: 12345, ppid: 501, pgid: 12345, startedAt: 'Thu Oct 30 12:34:56 2026' },
        ],
      },
      {
        name: 'the program after the start time, spaces and a login shell’s dash included',
        output: [
          '  501   1   501 Thu Oct  5 12:00:00 2026 /bin/zsh',
          '  502 501   501 Thu Oct 30 12:34:56 2026 -zsh',
          '  503 501   503 Thu Oct 30 12:34:56 2026 /Applications/My App.app/Contents/MacOS/app',
        ].join('\n'),
        expected: [
          { pid: 501, ppid: 1, pgid: 501, startedAt: 'Thu Oct  5 12:00:00 2026', comm: '/bin/zsh' },
          { pid: 502, ppid: 501, pgid: 501, startedAt: 'Thu Oct 30 12:34:56 2026', comm: '-zsh' },
          {
            pid: 503,
            ppid: 501,
            pgid: 503,
            startedAt: 'Thu Oct 30 12:34:56 2026',
            comm: '/Applications/My App.app/Contents/MacOS/app',
          },
        ],
      },
      {
        name: 'a header and a line it cannot read, left out',
        output: 'PID PPID PGID STARTED\nnot a row\n  7   1   7 Thu Oct 30 12:00:00 2026',
        expected: [{ pid: 7, ppid: 1, pgid: 7, startedAt: 'Thu Oct 30 12:00:00 2026' }],
      },
    ];
    for (const row of rows) {
      expect.soft(parseProcessTable(row.output), row.name).toEqual(row.expected);
    }
  });
});

describe('cachedProcessTable', () => {
  const rows: ProcessRow[] = [{ pid: 7, ppid: 1, pgid: 7, startedAt: 'x' }];

  it('shares one reading within the window, reads again after it, and never keeps a failure', async () => {
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

    let failingReads = 0;
    const failingOnce = cachedProcessTable(
      () => {
        failingReads += 1;
        return failingReads === 1 ? Promise.reject(new Error('ps failed')) : Promise.resolve(rows);
      },
      500,
      () => 0,
    );
    await expect(failingOnce()).rejects.toThrow('ps failed');
    await expect(failingOnce()).resolves.toEqual(rows);
  });
});
