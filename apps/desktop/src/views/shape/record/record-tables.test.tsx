import { mintId, type TaskDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { useEventStream } from '../../../daemon/events';
import { pickOption } from '../../../test/combobox';
import {
  baseHandlers,
  daemonUrl,
  eventStream,
  renderWithDaemonAndRouter,
  server,
} from '../../../test/daemon';
import { daemonEvent, projectViewDto, taskDto } from '../../../test/fixtures';
import {
  decisionRow,
  evidenceRow,
  P1_DOCUMENT_ID,
  planRecordHandlers,
  questionRow,
  RECORD_PROJECT_ID,
  RECORD_SHAPE_ID,
  recordPage,
  reviewRow,
  taskRow,
  type SeenPage,
} from '../../../test/plan-record-fixtures';
import { DecisionsTab } from './decisions-tab';
import { EvidenceTab } from './evidence-tab';
import { QuestionsTab } from './questions-tab';
import { ReviewsTab } from './reviews-tab';
import { TasksTab } from './tasks-tab';

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
      entryVersion: 1,
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

describe('Reviews', () => {
  it('reviews group by document, revision and round', async () => {
    server.use(
      ...planRecordHandlers({
        pages: (list) =>
          recordPage(
            list,
            [
              reviewRow({ key: 'p1-r1-1', text: 'First finding' }),
              reviewRow({ key: 'p1-r1-2', text: 'Second finding', severity: 'low' }),
              reviewRow({ key: 'p1-r2-1', round: 2, text: 'Third finding', severity: 'low' }),
            ],
            {
              groups: [
                { document: 'p1', revision: 1, round: 1, total: 22, high: 9, medium: 0, low: 13 },
                { document: 'p1', revision: 1, round: 2, total: 1, high: 0, medium: 0, low: 1 },
              ],
            },
          ),
      }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<ReviewsTab shapeId={RECORD_SHAPE_ID} documents={['p1']} />);
    const first = await screen.findByText('p1 · revision 1 · round 1 · 9 high, 13 low');
    const second = screen.getByText('p1 · revision 1 · round 2 · 1 low');
    const order = (el: HTMLElement) =>
      Array.from(document.querySelectorAll('tr')).indexOf(
        el.closest('tr') ?? document.createElement('tr'),
      );
    expect(order(first)).toBeLessThan(order(screen.getByText('First finding')));
    expect(order(screen.getByText('Second finding'))).toBeLessThan(order(second));
    expect(order(second)).toBeLessThan(order(screen.getByText('Third finding')));
  });

  it("an imported finding shows its reviewer's name and outcome words", async () => {
    server.use(
      ...planRecordHandlers({
        pages: (list) =>
          recordPage(list, [reviewRow()], {
            groups: [
              { document: 'p1', revision: 1, round: 1, total: 1, high: 1, medium: 0, low: 0 },
            ],
          }),
      }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<ReviewsTab shapeId={RECORD_SHAPE_ID} documents={['p1']} />);
    const row = (await screen.findByText('Revoked devices keep their session')).closest('tr');
    expect(row?.textContent).toContain('fable plan reviewer');
    expect(row?.textContent).toContain('blocking, security');
    expect(row?.textContent).toContain('partial: revoked-device column is a stub');
    expect(row?.textContent).toContain('Resolved');
  });

  it('a document filter goes to the daemon', async () => {
    const seen: SeenPage[] = [];
    server.use(...planRecordHandlers({ seen }), ...baseHandlers());
    await renderWithDaemonAndRouter(
      <ReviewsTab shapeId={RECORD_SHAPE_ID} documents={['p1', 'spec']} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Filter Document' }));
    await pickOption(await screen.findByRole('combobox', { name: 'Document' }), 'spec');
    await waitFor(() => {
      expect(seen.at(-1)?.query.get('document')).toBe('spec');
    });
  });
});

describe('Questions', () => {
  it('questions list an undecided decision', async () => {
    server.use(
      ...planRecordHandlers({
        pages: (list) =>
          recordPage(list, [
            questionRow(),
            questionRow({
              key: 'd2',
              source: 'decision',
              text: 'Which port for pairing?',
              for: null,
              about: null,
              blocks: null,
            }),
          ]),
      }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<QuestionsTab shapeId={RECORD_SHAPE_ID} />);
    const asked = (await screen.findByText('Which port?')).closest('tr');
    expect(asked?.textContent).toContain('designer');
    expect(asked?.textContent).toContain('t1');
    expect(asked?.textContent).toContain('P2');
    const undecided = screen.getByText('Which port for pairing?').closest('tr');
    expect(undecided?.textContent).toContain('Undecided decision');
  });
});

/** The event stream, mounted as the app's shell mounts it. */
function Stream() {
  useEventStream();
  return null;
}

describe('Tasks', () => {
  const project = projectViewDto({ id: RECORD_PROJECT_ID });

  it('a task row opens its section', async () => {
    const row = taskRow();
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json([taskDto({ id: row.taskId, projectId: project.id, title: row.title })]),
      ),
      ...planRecordHandlers({ pages: (list) => recordPage(list, [row]) }),
      ...baseHandlers(),
    );
    const onSearch = vi.fn();
    await renderWithDaemonAndRouter(
      <TasksTab shapeId={RECORD_SHAPE_ID} projectId={project.id} onSearch={onSearch} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'p1#task-12 · revision 2' }));
    expect(onSearch).toHaveBeenCalledWith({
      tab: 'documents',
      doc: P1_DOCUMENT_ID,
      rev: 2,
      section: 'task-12',
    });
  });

  it("a task's state follows a task.changed event", async () => {
    const row = taskRow();
    let task: TaskDto = taskDto({
      id: row.taskId,
      projectId: project.id,
      title: row.title,
      boardStatus: 'backlog',
    });
    const socket: { send: ((text: string) => void) | null } = { send: null };
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([task])),
      ...planRecordHandlers({ pages: (list) => recordPage(list, [row]) }),
      eventStream.addEventListener('connection', ({ client }) => {
        socket.send = (text) => {
          client.send(text);
        };
      }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(
      <>
        <Stream />
        <TasksTab shapeId={RECORD_SHAPE_ID} projectId={project.id} onSearch={() => undefined} />
      </>,
    );
    const line = await screen.findByText('Not started');
    expect(line.closest('tr')?.textContent).toContain('Pair a device');
    task = { ...task, boardStatus: 'ready' };
    await waitFor(() => {
      expect(socket.send).not.toBeNull();
    });
    socket.send?.(
      JSON.stringify(
        daemonEvent({ seq: 7, type: 'task.changed', entityType: 'task', entityId: task.id }),
      ),
    );
    expect(await screen.findByText('Ready')).toBeTruthy();
  });
});
