import { TaskScreensDto, TaskThreadDto } from '@10db/contracts';
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
  taskScreenDto,
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
    renderWithDaemon(<Thread page={page} turns={[turn]} canSend />);
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

  it("shows the before at the top and each turn's pictures under its reply", async () => {
    const before = taskScreenDto({ taskId: page.taskId });
    const ofTurn = taskScreenDto({
      taskId: page.taskId,
      kind: 'turn',
      turnId: turn.id,
      turnSeq: 1,
      sha256: 'b'.repeat(64),
    });
    const ofAnotherTurn = taskScreenDto({
      taskId: page.taskId,
      kind: 'turn',
      turnId: passTurnWithFilesDto({ taskId: page.taskId }).id,
      turnSeq: 2,
    });
    const asked: string[] = [];
    serve(TaskThreadDto.parse({ taskId: page.taskId, messages: [message, reply] }));
    server.use(
      http.get(daemonUrl('/tasks/:taskId/screens'), () =>
        HttpResponse.json(
          TaskScreensDto.parse({
            taskId: page.taskId,
            screens: [before, ofTurn, ofAnotherTurn],
            fromGoal: [],
          }),
        ),
      ),
      http.get(daemonUrl('/screens/:screenId'), ({ params, request }) => {
        asked.push(`${String(params['screenId'])} ${request.headers.get('authorization') ?? ''}`);
        return new HttpResponse(PNG, { headers: { 'content-type': 'image/png' } });
      }),
    );
    renderWithDaemon(<Thread page={page} turns={[turn]} canSend />);
    const thread = await screen.findByRole('list', { name: 'Thread' });
    await screen.findByRole('img', { name: 'Settings before, 1440 by 900' });
    const items = [...thread.children];
    expect(
      within(items[0] as HTMLElement)
        .getByRole('img')
        .getAttribute('alt'),
    ).toBe('Settings before, 1440 by 900');
    const replyItem = await waitFor(() => {
      const found = items.find((item) => item.textContent.includes(reply.body));
      if (found === undefined) throw new Error('no reply');
      return found as HTMLElement;
    });
    expect(
      (await within(replyItem).findAllByRole('img')).map((img) => img.getAttribute('alt')),
    ).toEqual(['Settings after, turn 1, 1440 by 900']);
    expect(screen.queryByRole('img', { name: /turn 2/ })).toBeNull();
    expect(asked).toContain(`${before.id} Bearer test-token`);
  });

  it('shows the before with the route before the first message', async () => {
    const before = taskScreenDto({ taskId: page.taskId });
    serve(TaskThreadDto.parse({ taskId: page.taskId, messages: [] }));
    server.use(
      http.get(daemonUrl('/tasks/:taskId/screens'), () =>
        HttpResponse.json(
          TaskScreensDto.parse({ taskId: page.taskId, screens: [before], fromGoal: [] }),
        ),
      ),
      http.get(
        daemonUrl('/screens/:screenId'),
        () => new HttpResponse(PNG, { headers: { 'content-type': 'image/png' } }),
      ),
    );
    renderWithDaemon(<Thread page={page} turns={[]} canSend />);
    expect(await screen.findByRole('img', { name: 'Settings before, 1440 by 900' })).toBeTruthy();
    expect(screen.getByText('/settings')).toBeTruthy();
  });

  it("leads with the goal's earlier pictures of the page, then its own before", async () => {
    const before = taskScreenDto({ taskId: page.taskId });
    const earlier = taskScreenDto({ kind: 'after', sha256: 'c'.repeat(64) });
    serve(TaskThreadDto.parse({ taskId: page.taskId, messages: [message] }));
    server.use(
      http.get(daemonUrl('/tasks/:taskId/screens'), () =>
        HttpResponse.json(
          TaskScreensDto.parse({ taskId: page.taskId, screens: [before], fromGoal: [earlier] }),
        ),
      ),
      http.get(
        daemonUrl('/screens/:screenId'),
        () => new HttpResponse(PNG, { headers: { 'content-type': 'image/png' } }),
      ),
    );
    renderWithDaemon(<Thread page={page} turns={[]} canSend />);
    const thread = await screen.findByRole('list', { name: 'Thread' });
    await screen.findByRole('img', { name: 'Settings before, 1440 by 900' });
    const first = thread.children[0] as HTMLElement;
    expect(within(first).getByText('Earlier in this goal')).toBeTruthy();
    expect(
      (await within(first).findAllByRole('img')).map((img) => img.getAttribute('alt')),
    ).toEqual([
      'Settings after sign-off, from an earlier task of this goal, 1440 by 900',
      'Settings before, 1440 by 900',
    ]);
  });

  it('draws a path a notice puts in backticks as code', async () => {
    const shared = taskMessageDto(page.taskId, {
      author: 'system',
      kind: 'notice',
      body: 'People: UI work changed shared `src/ui/button.ts`.',
      createdAt: minutesBeforeNow(1),
    });
    serve(TaskThreadDto.parse({ taskId: page.taskId, messages: [reply, shared] }));
    renderWithDaemon(<Thread page={page} turns={[]} canSend />);
    const path = await screen.findByText('src/ui/button.ts');
    expect(path.tagName).toBe('CODE');
    expect(path.parentElement?.textContent).toBe(
      'People: UI work changed shared src/ui/button.ts.',
    );
  });

  it('before the first message, says where the page is', async () => {
    serve(TaskThreadDto.parse({ taskId: page.taskId, messages: [] }));
    renderWithDaemon(<Thread page={page} turns={[]} canSend />);
    expect(await screen.findByText('Settings is at')).toBeTruthy();
    expect(screen.getByText('/settings')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Thread' })).toBeNull();
  });

  it('keeps saying where the page is above a notice, until the builder sends a message', async () => {
    serve(TaskThreadDto.parse({ taskId: page.taskId, messages: [notice] }));
    renderWithDaemon(<Thread page={page} turns={[]} canSend />);
    expect(await screen.findByText(notice.body)).toBeTruthy();
    expect(screen.getByText('Settings is at')).toBeTruthy();
  });

  it('says no more where the page is once the builder has written', async () => {
    serve(TaskThreadDto.parse({ taskId: page.taskId, messages: [notice, message] }));
    renderWithDaemon(<Thread page={page} turns={[]} canSend />);
    expect(await screen.findByText('The padding is too tight')).toBeTruthy();
    expect(screen.queryByText('Settings is at')).toBeNull();
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
    renderWithDaemon(<Thread page={page} turns={[]} canSend={canSend} />);
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
