import {
  mintId,
  WorkstreamChangesDto,
  type InboxItemDto,
  type WorkstreamId,
} from '@10db/contracts';
import { within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { inboxItemDto, taskDto, workstreamDto } from '../../test/fixtures';
import { findText, getText, queryText, serveOpenRows } from '../../test/inbox-page-fixtures';

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

const changes = WorkstreamChangesDto.parse({
  baseHead: BASE,
  head: HEAD,
  commits: ['1111111aaaa', '2222222bbbb'],
  diff: 'diff --git a/hello.txt b/hello.txt\n+hello world\n',
  truncated: false,
  files: [
    { path: 'hello.txt', added: 3, removed: 1 },
    { path: 'logo.png', added: null, removed: null },
  ],
});

function htmlElement(node: Node | null): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error('expected an element');
  return node;
}

describe('CheckCard', () => {
  it('shows criteria, commits, files with counts and the diff', async () => {
    server.use(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([card])),
      http.get(daemonUrl(`/workstreams/${workstreamId}/changes`), () => HttpResponse.json(changes)),
      http.get(daemonUrl('/workstreams'), () =>
        HttpResponse.json([workstreamDto({ id: workstreamId, taskId, projectId })]),
      ),
      http.get(daemonUrl(`/tasks/${taskId}`), () =>
        HttpResponse.json(
          taskDto({
            id: taskId,
            projectId,
            acceptanceCriteria: ['hello.txt says hello', 'The tests pass'],
          }),
        ),
      ),
      ...baseHandlers(),
      eventStream.addEventListener('connection', () => undefined),
    );
    serveOpenRows(() => [card]);
    renderApp('/inbox');
    expect(await findText('hello.txt says hello')).toBeTruthy();
    expect(getText('The tests pass')).toBeTruthy();
    expect(getText('1111111')).toBeTruthy();
    expect(getText('2222222')).toBeTruthy();
    const file = (await findText('hello.txt')).closest('li');
    expect(within(htmlElement(file)).getByText('+3')).toBeTruthy();
    expect(within(htmlElement(file)).getByText('-1')).toBeTruthy();
    const binary = getText('logo.png').closest('li');
    expect(within(htmlElement(binary)).queryByText(/^[+-]\d/)).toBeNull();
    expect(getText(/\+hello world/)).toBeTruthy();
    expect(queryText(/The diff is longer than we show/)).toBeNull();
  });
});
