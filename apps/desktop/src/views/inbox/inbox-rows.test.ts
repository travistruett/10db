import type { InboxItemDto } from '@10db/contracts';
import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { inboxItemDto } from '../../test/fixtures';
import { inboxRows } from './inbox-rows';

const project = mintId('Project');
const flag = (title: string, body: string, overrides: Partial<InboxItemDto> = {}): InboxItemDto =>
  inboxItemDto({ kind: 'flag', title, body, options: [], projectId: project, ...overrides });
const question = inboxItemDto({ projectId: project });

describe('inboxRows', () => {
  const a = flag('Write outside every claim', 'docs/a.md');
  const a2 = flag('Write outside every claim', 'docs/a.md');
  const b = flag('Write outside every claim', 'docs/b.md');
  const elsewhere = flag('Write outside every claim', 'docs/a.md', {
    projectId: mintId('Project'),
  });
  const withOptions = flag('Batch failed', 'gate', {
    options: [
      { label: 'Retry', description: '' },
      { label: 'Ship anyway', description: '' },
    ],
  });
  const withOptions2 = { ...withOptions, id: mintId('InboxItem') };
  const sameAsQuestion = inboxItemDto({
    projectId: project,
    title: question.title,
    body: question.body,
  });

  it.each<{ name: string; items: InboxItemDto[]; rows: InboxItemDto[][] }>([
    { name: 'nothing', items: [], rows: [] },
    { name: 'one flag', items: [a], rows: [[a]] },
    {
      name: 'identical flags, in one row at the first',
      items: [a, question, a2],
      rows: [[a, a2], [question]],
    },
    { name: 'flags about different paths, apart', items: [a, b], rows: [[a], [b]] },
    {
      name: 'identical flags of different projects, apart',
      items: [a, elsewhere],
      rows: [[a], [elsewhere]],
    },
    {
      name: 'flags that ask for a choice, apart',
      items: [withOptions, withOptions2],
      rows: [[withOptions], [withOptions2]],
    },
    {
      name: 'identical questions, apart',
      items: [question, sameAsQuestion],
      rows: [[question], [sameAsQuestion]],
    },
  ])('groups $name', ({ items, rows }) => {
    expect(inboxRows(items).map((row) => row.items)).toEqual(rows);
  });

  it('keys a card by its id, and identical flags by their text, which outlives any one of them', () => {
    expect(inboxRows([question])[0]?.key).toBe(question.id);
    const [both] = inboxRows([a, a2]);
    const [later] = inboxRows([a2]);
    expect(both?.key).toBe(later?.key);
    expect(both?.key).not.toBe(inboxRows([b])[0]?.key);
  });
});
