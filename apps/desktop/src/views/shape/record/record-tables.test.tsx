import { mintId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { pickOption } from '../../../test/combobox';
import { baseHandlers, renderWithDaemonAndRouter, server } from '../../../test/daemon';
import {
  decisionRow,
  evidenceRow,
  planRecordHandlers,
  RECORD_SHAPE_ID,
  recordPage,
  type SeenPage,
} from '../../../test/plan-record-fixtures';
import { DecisionsTab } from './decisions-tab';
import { EvidenceTab } from './evidence-tab';

describe('Decisions', () => {
  it('decisions page and open a drawer with alternatives', async () => {
    const seen: SeenPage[] = [];
    const rows = Array.from({ length: 30 }, (_, i) =>
      decisionRow({ key: `d${String(i + 1)}`, question: `Question ${String(i + 1)}?` }),
    );
    server.use(
      ...planRecordHandlers({
        seen,
        pages: (list, query) => {
          const page = Number(query.get('page') ?? '1');
          return recordPage(list, rows.slice((page - 1) * 25, page * 25), { total: 30, page });
        },
      }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<DecisionsTab shapeId={RECORD_SHAPE_ID} />);
    expect(await screen.findByText('Question 1?')).toBeTruthy();
    expect(screen.getByText('1–25 of 30')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(await screen.findByText('Question 26?')).toBeTruthy();
    expect(seen.map((s) => s.query.get('page'))).toEqual(['1', '2']);
    fireEvent.click(screen.getByText('Question 26?'));
    const drawer = await screen.findByRole('dialog', { name: 'Question 26?' });
    expect(within(drawer).getByText('Turned down: Docs PRs — They land in the repo')).toBeTruthy();
    expect(within(drawer).getByText('“Plans never go in the repo.”')).toBeTruthy();
  });

  it('an effort-only decision reads This effort', async () => {
    server.use(
      ...planRecordHandlers({
        pages: (list) =>
          recordPage(list, [
            decisionRow({ key: 'd1', lasting: true }),
            decisionRow({ key: 'd2', question: 'Which port?', lasting: false, decidedAt: null }),
          ]),
      }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<DecisionsTab shapeId={RECORD_SHAPE_ID} />);
    const row = (await screen.findByText('Which port?')).closest('tr');
    expect(row?.textContent).toContain('This effort');
    expect(row?.textContent).toContain('Not yet');
    expect(screen.getByText('Where does the record live?').closest('tr')?.textContent).toContain(
      'Lasting',
    );
  });

  it('a state filter goes to the daemon', async () => {
    const seen: SeenPage[] = [];
    server.use(
      ...planRecordHandlers({ seen, pages: (list) => recordPage(list, [decisionRow()]) }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<DecisionsTab shapeId={RECORD_SHAPE_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Filter State' }));
    await pickOption(await screen.findByRole('combobox', { name: 'State' }), 'Accepted');
    await waitFor(() => {
      expect(seen.at(-1)?.query.get('state')).toBe('accepted');
    });
  });
});

describe('Evidence', () => {
  it('evidence shows a moved anchor as Moved, never Current', async () => {
    const workstreamId = mintId('Workstream');
    const check = {
      entryKey: 'f1',
      anchorIndex: 0,
      result: 'moved' as const,
      line: 2001,
      checkedCommit: '0123456789abcdef',
      note: null,
      workstreamId,
      at: '2026-11-12T08:00:00.000Z',
    };
    server.use(
      ...planRecordHandlers({
        pages: (list) =>
          recordPage(list, [
            evidenceRow({ checks: [{ taskId: mintId('Task'), results: [check] }] }),
            evidenceRow({
              key: 'f2',
              title: 'Tailscale serves the host',
              body: { claim: 'Tailscale Serve proxies the host.' },
              anchors: [
                { kind: 'url', url: 'https://tailscale.com/kb/serve', readAt: '2026-11-12' },
              ],
            }),
          ]),
      }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<EvidenceTab shapeId={RECORD_SHAPE_ID} />);
    const row = (await screen.findByText('apps/daemon/src/runner/runner.ts:1976')).closest('tr');
    expect(row?.textContent).toContain('Moved');
    expect(row?.textContent).not.toContain('Current');
    expect(screen.getByText('The runner packs the context once per session.')).toBeTruthy();
    const page = screen.getByText('tailscale.com').closest('tr');
    expect(page?.textContent).toContain('Read 12 Nov 2026');
  });
});
