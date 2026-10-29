import {
  mintId,
  WorkstreamChangesDto,
  type InboxItemDto,
  type WorkstreamId,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { inboxItemDto, taskDto, workstreamDto } from '../../test/fixtures';

const projectId = mintId('Project');
const workstreamId: WorkstreamId = mintId('Workstream');
const taskId = mintId('Task');
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

const card: InboxItemDto = inboxItemDto({
  kind: 'check',
  projectId,
  title: 'Ready for you to check: Write the greeting',
  body: '2 commits are ready. Approve to finish the task, or send it back with a note.',
  options: [
    { label: 'approve', description: 'The work is right' },
    { label: 'send_back', description: 'It needs more work' },
  ],
  detail: { workstreamId, baseHead: BASE, head: HEAD, commits: ['1111111aaaa', '2222222bbbb'] },
  targets: [{ workstreamId, sessionId: null }],
});

function changes(overrides: Partial<WorkstreamChangesDto> = {}): WorkstreamChangesDto {
  return WorkstreamChangesDto.parse({
    baseHead: BASE,
    head: HEAD,
    commits: ['1111111aaaa', '2222222bbbb'],
    diff: 'diff --git a/hello.txt b/hello.txt\n+hello world\n',
    truncated: false,
    files: [
      { path: 'hello.txt', added: 3, removed: 1 },
      { path: 'logo.png', added: null, removed: null },
    ],
    ...overrides,
  });
}

function serve(diff: WorkstreamChangesDto): { answers: unknown[] } {
  const answers: unknown[] = [];
  server.use(
    http.get(daemonUrl('/inbox'), () => HttpResponse.json(answers.length === 0 ? [card] : [])),
    http.get(daemonUrl(`/workstreams/${workstreamId}/changes`), () => HttpResponse.json(diff)),
    http.get(daemonUrl('/workstreams'), () =>
      HttpResponse.json([workstreamDto({ id: workstreamId, taskId, projectId })]),
    ),
    http.get(daemonUrl(`/projects/${projectId}/tasks`), () =>
      HttpResponse.json([
        taskDto({
          id: taskId,
          projectId,
          acceptanceCriteria: ['hello.txt says hello', 'The tests pass'],
        }),
      ]),
    ),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ request }) => {
      answers.push(await request.json());
      return HttpResponse.json({ ...card, state: 'ANSWERED' });
    }),
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  return { answers };
}

describe('CheckCard', () => {
  it('shows criteria, commits, files with counts and the diff', async () => {
    serve(changes());
    renderApp('/inbox');
    expect(await screen.findByText('hello.txt says hello')).toBeTruthy();
    expect(screen.getByText('The tests pass')).toBeTruthy();
    expect(screen.getByText('1111111')).toBeTruthy();
    expect(screen.getByText('2222222')).toBeTruthy();
    const file = (await screen.findByText('hello.txt')).closest('li');
    expect(within(file as HTMLElement).getByText('+3')).toBeTruthy();
    expect(within(file as HTMLElement).getByText('-1')).toBeTruthy();
    const binary = screen.getByText('logo.png').closest('li');
    expect(within(binary as HTMLElement).queryByText(/^[+-]\d/)).toBeNull();
    expect(screen.getByText(/\+hello world/)).toBeTruthy();
    expect(screen.queryByText(/The diff is longer than we show/)).toBeNull();
  });

  it('a truncated diff says so', async () => {
    serve(changes({ truncated: true }));
    renderApp('/inbox');
    expect(
      await screen.findByText('The diff is longer than we show. The file list above is complete.'),
    ).toBeTruthy();
  });

  it('Approve sends approve', async () => {
    const { answers } = serve(changes());
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(answers).toEqual([{ choice: 'approve' }]);
    });
  });

  it('Send Back needs a note, then sends it', async () => {
    const { answers } = serve(changes());
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    const send = screen.getByRole('button', { name: 'Send It Back' });
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'What needs to change' }), {
      target: { value: '  Say hello twice  ' },
    });
    expect(send.hasAttribute('disabled')).toBe(false);
    fireEvent.click(send);
    await waitFor(() => {
      expect(answers).toEqual([{ choice: 'send_back', note: 'Say hello twice' }]);
    });
  });
});
