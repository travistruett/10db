import type { BatchDto, WorkstreamDto } from '@10db/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { batchDto, workstreamDto } from '../../test/fixtures';
import { BatchStrip } from './batch-strip';

const batch = batchDto();
const member = (taskTitle: string, state: WorkstreamDto['state']) =>
  workstreamDto({ batchId: batch.id, projectId: batch.projectId, taskTitle, state });

describe('BatchStrip', () => {
  it.each<{
    name: string;
    batch: BatchDto;
    workstreams: WorkstreamDto[];
    texts: string[];
    absent?: string[];
    buttons: string[];
    link?: string;
  }>([
    {
      name: 'cutting',
      batch: batchDto({ state: 'CUTTING', branch: null, baseSha: null }),
      workstreams: [],
      texts: ['Greetings', 'Cutting branch'],
      buttons: [],
    },
    {
      name: 'open with work running',
      batch,
      workstreams: [member('Alpha', 'RUNNING'), member('Beta', 'DONE')],
      texts: ['Open', '10db/greetings-0a1b2c3d', 'Alpha', 'Running'],
      absent: ['Beta'],
      buttons: ['Abandon'],
    },
    {
      name: 'open with a failed workstream',
      batch,
      workstreams: [member('Alpha', 'FAILED'), member('Beta', 'DONE')],
      texts: ['Alpha', 'Failed'],
      buttons: ['Ship anyway', 'Abandon'],
    },
    {
      name: 'shipping',
      batch: batchDto({ state: 'SHIPPING' }),
      workstreams: [],
      texts: ['Shipping'],
      buttons: [],
    },
    {
      name: 'shipped',
      batch: batchDto({ state: 'SHIPPED', prUrl: 'https://github.com/acme/widgets/pull/7' }),
      workstreams: [],
      texts: ['Shipped'],
      buttons: [],
      link: 'https://github.com/acme/widgets/pull/7',
    },
    {
      name: 'closed',
      batch: batchDto({ state: 'CLOSED' }),
      workstreams: [],
      texts: ['Closed: no changes'],
      buttons: [],
    },
    {
      name: 'failed',
      batch: batchDto({ state: 'FAILED', failure: 'gate_failed' }),
      workstreams: [member('Alpha', 'DONE')],
      texts: ['Not shipped', 'The gate failed'],
      buttons: ['Retry', 'Abandon'],
    },
    {
      name: 'abandoned',
      batch: batchDto({ state: 'ABANDONED' }),
      workstreams: [],
      texts: ['Abandoned'],
      buttons: [],
    },
  ])('$name', async ({ batch: b, workstreams, texts, absent = [], buttons, link }) => {
    server.use(...baseHandlers());
    renderWithDaemon(<BatchStrip batch={b} workstreams={workstreams} />);
    for (const text of texts) expect(await screen.findByText(text)).toBeTruthy();
    for (const text of absent) expect(screen.queryByText(text)).toBeNull();
    expect(screen.queryAllByRole('button').map((x) => x.textContent)).toEqual(buttons);
    if (link)
      expect(screen.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe(link);
  });
});
