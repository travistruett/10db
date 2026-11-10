import { TaskThreadDto } from '@10db/contracts';
import { screen } from '@testing-library/react';
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
    renderWithDaemon(<Thread page={page} turns={[turn]} openPage={null} />);
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
      <Thread page={page} turns={[]} openPage={<button type="button">Open Page</button>} />,
    );
    expect(await screen.findByText('Settings is at')).toBeTruthy();
    expect(screen.getByText('/settings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Page' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Thread' })).toBeNull();
  });
});
