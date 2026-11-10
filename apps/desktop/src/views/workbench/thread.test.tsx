import { TaskThreadDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import {
  minutesBeforeNow,
  pagesByStatus,
  passHandlers,
  passTurnWithFilesDto,
  taskFileDto,
  taskMessageDto,
} from '../../test/pass-fixtures';
import { Thread } from './thread';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const page = pagesByStatus().ready;

const sent = taskMessageDto(page.taskId, {
  body: 'The padding is too tight',
  createdAt: minutesBeforeNow(12),
});
const picture = taskFileDto(sent, { name: 'tight padding.png' });
const message = { ...sent, files: [picture] };
const reply = taskMessageDto(page.taskId, {
  author: 'agent',
  kind: 'reply',
  body: 'I loosened the form’s padding.',
  createdAt: minutesBeforeNow(3),
});
const notice = taskMessageDto(page.taskId, {
  author: 'system',
  kind: 'notice',
  body: 'Your edit to src/settings/form.tsx is part of this page’s work.',
  createdAt: minutesBeforeNow(2),
});
const turn = passTurnWithFilesDto({
  taskId: page.taskId,
  startedAt: minutesBeforeNow(12),
  files: [{ path: 'src/settings/page.tsx', added: 4, removed: 1 }],
});

let pictureAsked: string | null;
beforeEach(() => {
  pictureAsked = null;
});

function serve(thread: TaskThreadDto) {
  server.use(
    http.get(daemonUrl('/tasks/:taskId/thread/pictures/:fileId'), ({ params, request }) => {
      pictureAsked = `${String(params['fileId'])} ${request.headers.get('authorization') ?? ''}`;
      return new HttpResponse(PNG, { headers: { 'content-type': 'image/png' } });
    }),
    ...passHandlers({ threads: { [page.taskId]: thread } }),
    ...baseHandlers(),
  );
}

describe('Thread', () => {
  it('shows the messages oldest first: a picture named by its file, a reply with its turn’s files, a dimmed notice', async () => {
    serve(TaskThreadDto.parse({ taskId: page.taskId, messages: [message, reply, notice] }));
    renderWithDaemon(<Thread page={page} turns={[turn]} openPage={null} canSend />);
    const thread = await screen.findByRole('list', { name: 'Thread' });
    expect([...thread.children].map((item) => item.textContent)).toEqual([
      expect.stringContaining('The padding is too tight'),
      expect.stringContaining('I loosened the form’s padding.'),
      expect.stringContaining('Your edit to src/settings/form.tsx'),
    ]);
    const image = await screen.findByRole('img', { name: 'tight padding.png' });
    expect(image.getAttribute('src')).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    );
    expect(pictureAsked).toBe(`${picture.id} Bearer test-token`);
    const files = screen.getByRole('list', { name: 'Files this turn changed' });
    expect(files.textContent).toBe('src/settings/page.tsx+4 −1');
    expect(screen.getByText(notice.body).style.color).toBe('var(--mantine-color-dimmed)');
  });

  it('before the first message, says where the page is', async () => {
    serve(TaskThreadDto.parse({ taskId: page.taskId, messages: [] }));
    renderWithDaemon(
      <Thread page={page} turns={[]} openPage={<button type="button">Open Page</button>} canSend />,
    );
    expect(await screen.findByText('Settings is at')).toBeTruthy();
    expect(screen.getByText('/settings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Page' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Thread' })).toBeNull();
  });

  it.each([
    {
      name: 'sends a sendable notice to this page',
      sendable: true,
      canSend: true,
      button: 'enabled',
    },
    {
      name: 'offers nothing on a sendable notice while the pass is not open',
      sendable: true,
      canSend: false,
      button: 'none',
    },
    {
      name: 'offers nothing on a notice that is not sendable',
      sendable: false,
      canSend: true,
      button: 'none',
    },
  ] as const)('$name', async ({ sendable, canSend, button }) => {
    const finding = taskMessageDto(page.taskId, {
      author: 'system',
      kind: 'notice',
      body: 'Review: src/settings/form.tsx:12 drops the error state.',
      createdAt: minutesBeforeNow(1),
      sendable,
    });
    const posted: { taskId: string; messageId: string }[] = [];
    server.use(
      http.post(daemonUrl('/tasks/:taskId/thread/:messageId/send-to-agent'), ({ params }) => {
        posted.push({
          taskId: String(params['taskId']),
          messageId: String(params['messageId']),
        });
        return HttpResponse.json(taskMessageDto(page.taskId, { body: finding.body }), {
          status: 201,
        });
      }),
    );
    serve(TaskThreadDto.parse({ taskId: page.taskId, messages: [reply, finding] }));
    renderWithDaemon(<Thread page={page} turns={[]} openPage={null} canSend={canSend} />);
    const entry = (await screen.findByText(finding.body)).closest('li');
    if (entry === null) throw new Error('the notice is not an entry of the thread');
    const send = within(entry).queryByRole('button', { name: 'Send to Agent' });
    // Only the notice offers it; the reply above it never does.
    expect(screen.queryAllByRole('button', { name: 'Send to Agent' })).toHaveLength(
      button === 'none' ? 0 : 1,
    );
    if (button === 'none') return;
    if (send === null) throw new Error('the notice offers no Send to Agent');
    fireEvent.click(send);
    await waitFor(() => {
      expect(posted).toEqual([{ taskId: page.taskId, messageId: finding.id }]);
    });
    expect(await within(entry).findByText('Sent to the agent')).toBeTruthy();
    // Sent once, it is not offered to send again.
    expect(send).toHaveProperty('disabled', true);
  });
});
