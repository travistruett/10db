import type { PassTurnActivity } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { minutesBeforeNow, pageTurn, turnActivity } from '../../test/pass-fixtures';
import { liveLine } from './live-line';

describe('liveLine', () => {
  it.each<{
    name: string;
    activity: PassTurnActivity | null;
    tool: string | null;
    files: string | null;
  }>([
    {
      name: 'an edit names the file by its last two parts',
      activity: turnActivity({ tool: 'Edit', target: 'src/settings/page.tsx' }),
      tool: 'editing settings/page.tsx',
      files: '1 file changed so far',
    },
    {
      name: 'a write is editing too',
      activity: turnActivity({
        tool: 'Write',
        target: 'form.tsx',
        filesTouched: ['src/settings/page.tsx', 'form.tsx', 'src/settings/x.css'],
      }),
      tool: 'editing form.tsx',
      files: '3 files changed so far',
    },
    {
      name: 'a read names what it reads and changed nothing yet',
      activity: turnActivity({ tool: 'Read', target: 'src/settings/page.tsx', filesTouched: [] }),
      tool: 'reading settings/page.tsx',
      files: null,
    },
    {
      name: 'a command names its first word as given',
      activity: turnActivity({ tool: 'Bash', target: 'pnpm', filesTouched: [] }),
      tool: 'running pnpm',
      files: null,
    },
    {
      name: 'a search says so',
      activity: turnActivity({ tool: 'Grep', target: null, filesTouched: [] }),
      tool: 'searching',
      files: null,
    },
    {
      name: 'a tool it has no word for is named',
      activity: turnActivity({ tool: 'WebFetch', target: null, filesTouched: [] }),
      tool: 'using WebFetch',
      files: null,
    },
    {
      name: 'text, between tools, is the time alone',
      activity: turnActivity({ tool: null, target: null }),
      tool: null,
      files: '1 file changed so far',
    },
    {
      name: 'before the first report, the time alone',
      activity: null,
      tool: null,
      files: null,
    },
  ])('$name', ({ activity, tool, files }) => {
    const turn = pageTurn({ startedAt: minutesBeforeNow(4), activity });
    expect(liveLine(turn)).toEqual({ tool, files });
  });
});
