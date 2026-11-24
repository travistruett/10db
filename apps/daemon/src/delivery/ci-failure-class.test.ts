import { describe, expect, it } from 'vitest';
import { classifyCiFailures } from './ci-failure-class';

const job = (name: string) => ({
  name,
  link: null,
  jobId: '1',
  runId: '2',
  description: null,
});

describe('classifyCiFailures', () => {
  const rows: {
    name: string;
    failing: string[];
    base: string[] | null;
    onBase: string[];
    change: string[];
  }[] = [
    { name: 'base green: all the change', failing: ['e2e'], base: [], onBase: [], change: ['e2e'] },
    {
      name: 'same check red on base',
      failing: ['e2e'],
      base: ['e2e'],
      onBase: ['e2e'],
      change: [],
    },
    {
      name: 'mixed: only the shared one waits',
      failing: ['e2e', 'unit'],
      base: ['e2e'],
      onBase: ['e2e'],
      change: ['unit'],
    },
    {
      name: 'base unreadable: the change',
      failing: ['e2e'],
      base: null,
      onBase: [],
      change: ['e2e'],
    },
  ];
  it.each(rows)('$name', ({ failing, base, onBase, change }) => {
    const out = classifyCiFailures(failing.map(job), base === null ? null : new Set(base));
    expect(out.base.map((j) => j.name)).toEqual(onBase);
    expect(out.change.map((j) => j.name)).toEqual(change);
  });
});
