import type { PassTurnActivity } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { minutesBeforeNow, PASS_NOW, pageTurn, turnActivity } from '../../test/pass-fixtures';
import { liveLine } from './live-line';

const now = Date.parse(PASS_NOW);

describe('liveLine', () => {
  it.each<{
    name: string;
    activity: PassTurnActivity | null;
    doing: string;
    files: string | null;
  }>([
    {
      name: 'an edit names the file by its last two parts',
      activity: turnActivity({ tool: 'Edit', target: 'src/settings/page.tsx' }),
      doing: 'Working · 4 min · editing settings/page.tsx',
      files: '1 file changed so far',
    },
    {
      name: 'a write is editing too',
      activity: turnActivity({
        tool: 'Write',
        target: 'form.tsx',
        filesTouched: ['src/settings/page.tsx', 'form.tsx', 'src/settings/x.css'],
      }),
      doing: 'Working · 4 min · editing form.tsx',
      files: '3 files changed so far',
    },
    {
      name: 'a read names what it reads and changed nothing yet',
      activity: turnActivity({ tool: 'Read', target: 'src/settings/page.tsx', filesTouched: [] }),
      doing: 'Working · 4 min · reading settings/page.tsx',
      files: null,
    },
    {
      name: 'a command names its first word as given',
      activity: turnActivity({ tool: 'Bash', target: 'pnpm', filesTouched: [] }),
      doing: 'Working · 4 min · running pnpm',
      files: null,
    },
    {
      name: 'a search says so',
      activity: turnActivity({ tool: 'Grep', target: null, filesTouched: [] }),
      doing: 'Working · 4 min · searching',
      files: null,
    },
    {
      name: 'a tool it has no word for is named',
      activity: turnActivity({ tool: 'WebFetch', target: null, filesTouched: [] }),
      doing: 'Working · 4 min · using WebFetch',
      files: null,
    },
    {
      name: 'text, between tools, is the time alone',
      activity: turnActivity({ tool: null, target: null }),
      doing: 'Working · 4 min',
      files: '1 file changed so far',
    },
    {
      name: 'before the first report, the time alone',
      activity: null,
      doing: 'Working · 4 min',
      files: null,
    },
  ])('$name', ({ activity, doing, files }) => {
    const turn = pageTurn({ startedAt: minutesBeforeNow(4), activity });
    expect(liveLine(turn, now)).toEqual({ doing, files });
  });

  it('counts whole minutes from the turn’s start', () => {
    const turn = pageTurn({ startedAt: minutesBeforeNow(0.5), activity: null });
    expect(liveLine(turn, now).doing).toBe('Working · 0 min');
  });
});
