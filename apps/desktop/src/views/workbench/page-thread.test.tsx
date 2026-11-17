import {
  mintId,
  TaskScreensDto,
  type ConversationItemDto,
  type ConversationLiveDto,
  type PassPageDto,
  type PassTurnWithFilesDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationLive } from '../../daemon/conversation-queries';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import {
  minutesBeforeNow,
  pageItemDto,
  pagesByStatus,
  passHandlers,
  passTurnWithFilesDto,
  taskMessageDto,
  taskScreenDto,
} from '../../test/pass-fixtures';
import { PageThread } from './page-thread';

// Workbench spec §4.3, sessions UI spec §7.3: a page's thread on the kit's list, over its task's
// conversation: the builder's pictures, replies as markdown, tool rows, notices with what they offer,
// each turn's files and pictures after its reply, and what streams now.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const page: PassPageDto = pagesByStatus().ready;
const conversationId = page.conversationId ?? mintId('Conversation');

const turn = passTurnWithFilesDto({
  taskId: page.taskId,
  startedAt: minutesBeforeNow(12),
  files: [{ path: 'src/settings/page.tsx', added: 4, removed: 1 }],
});
const picture = {
  id: mintId('ConversationFile'),
  name: 'tight padding.png',
  mediaType: 'image/png',
  size: 4,
};
const message = pageItemDto(conversationId, {
  kind: 'message',
  seq: 1,
  text: 'The padding is too tight',
  files: [picture],
  turnId: turn.id,
});
const reply = pageItemDto(conversationId, {
  kind: 'agent_message',
  seq: 2,
  author: 'agent',
  text: 'I **loosened** the form’s padding.',
  turnId: turn.id,
});
const NOTICE = 'Your edit to src/settings/form.tsx is part of this page’s work.';
const notice = pageItemDto(conversationId, {
  kind: 'notice',
  seq: 3,
  author: 'system',
  text: NOTICE,
});

/** A command call of the page's turn. */
const commandItem = (over: Record<string, unknown>) =>
  pageItemDto(conversationId, {
    kind: 'tool_call',
    seq: 2,
    author: 'agent',
    call: {
      kind: 'command',
      id: 'call-1',
      harnessTool: 'Bash',
      status: 'done',
      title: 'pnpm test',
      startedAt: minutesBeforeNow(2),
      durationMs: 1000,
      parentId: null,
      refusal: null,
      deniedBy: null,
      limit: null,
      soft: null,
      command: 'pnpm test',
      cwd: null,
      outputTail: 'ok',
      outputBytes: 2,
      exitCode: 0,
      ...over,
    },
  });

let pictureAsked: string | null;
beforeEach(() => {
  pictureAsked = null;
});

function serve(
  items: readonly ConversationItemDto[],
  streams: ConversationLiveDto['items'] = [],
): void {
  server.use(
    http.get(daemonUrl('/conversations/:conversationId/files/:fileId'), ({ params, request }) => {
      pictureAsked = `${String(params['fileId'])} ${request.headers.get('authorization') ?? ''}`;
      return new HttpResponse(PNG, { headers: { 'content-type': 'image/png' } });
    }),
    ...passHandlers({
      conversations: { [conversationId]: items },
      streams: { [conversationId]: streams },
    }),
    ...baseHandlers(),
  );
}

/** The thread as its page draws it, with the page's live stream as the pane reads it. */
function Thread(props: {
  readonly turns?: readonly PassTurnWithFilesDto[];
  readonly canSend?: boolean;
  readonly onAllow?: () => void;
}) {
  const live = useConversationLive(conversationId);
  return (
    <PageThread
      page={page}
      turns={props.turns ?? []}
      live={live}
      busy={false}
      canSend={props.canSend ?? true}
      onAllow={props.onAllow ?? (() => undefined)}
    />
  );
}

const messages = (): HTMLElement => screen.getByRole('group', { name: 'Messages' });

describe('PageThread', () => {
  it('shows the items oldest first: a picture named by its file, a markdown reply with its turn’s files, a dimmed notice', async () => {
    serve([message, reply, notice]);
    renderWithDaemon(<Thread turns={[turn]} />);
    // The reply is markdown: its emphasis is drawn, never its asterisks.
    await screen.findByText('loosened');
    const text = messages().textContent;
    expect(text).not.toContain('**');
    expect(text.indexOf('The padding is too tight')).toBeLessThan(text.indexOf('loosened'));
    expect(text.indexOf('loosened')).toBeLessThan(text.indexOf('src/settings/page.tsx+4'));
    expect(text.indexOf('src/settings/page.tsx+4')).toBeLessThan(text.indexOf(NOTICE));
    const image = await screen.findByRole('img', { name: 'tight padding.png' });
    expect(image.getAttribute('src')).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    );
    expect(pictureAsked).toBe(`${picture.id} Bearer test-token`);
    // A sent picture is a thumbnail in a row, never drawn at the width of the thread.
    expect(image.style.height).toBe('96px');
    expect(image.style.maxWidth).toBe('160px');
    const files = screen.getByRole('list', { name: 'Files this turn changed' });
    expect(files.textContent).toBe('src/settings/page.tsx+4 −1');
    expect(screen.getByText(NOTICE).style.color).toBe('var(--mantine-color-dimmed)');
  });

  it('shows a call the turn made in its Worked row, and what streams before it is stored', async () => {
    serve(
      [message, commandItem({})],
      [{ itemId: mintId('ConversationItem'), kind: 'agent_message', text: 'Now the header' }],
    );
    renderWithDaemon(<Thread />);
    expect(await screen.findByText('Now the header')).toBeTruthy();
    expect(messages().textContent).not.toContain('pnpm test');
    fireEvent.click(screen.getByRole('button', { name: 'Worked · 1 Step' }));
    expect(messages().textContent).toContain('pnpm test');
  });

  it("shows the before at the top and each turn's pictures after its reply", async () => {
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
    serve([message, reply]);
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
      http.get(
        daemonUrl('/screens/:screenId'),
        () => new HttpResponse(PNG, { headers: { 'content-type': 'image/png' } }),
      ),
    );
    renderWithDaemon(<Thread turns={[turn]} />);
    await screen.findByRole('img', { name: 'Settings before, 1440 by 900' });
    await screen.findByRole('img', { name: 'Settings after, turn 1, 1440 by 900' });
    await screen.findByRole('img', { name: 'tight padding.png' });
    expect(
      within(messages())
        .getAllByRole('img')
        .map((img) => img.getAttribute('alt')),
    ).toEqual([
      'Settings before, 1440 by 900',
      'tight padding.png',
      'Settings after, turn 1, 1440 by 900',
    ]);
    expect(screen.queryByRole('img', { name: /turn 2/ })).toBeNull();
    // A click on a picture or a sent thumbnail opens it at the size the window allows.
    for (const name of ['Settings after, turn 1, 1440 by 900', 'tight padding.png']) {
      fireEvent.click(screen.getByRole('button', { name: `Enlarge ${name}` }));
      const dialog = await screen.findByRole('dialog', { name });
      expect(within(dialog).getByRole('img', { name }).getAttribute('src')).toMatch(
        /^data:image\/png;base64,/,
      );
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    }
  });

  it("leads with the goal's earlier pictures of the page, then its own before", async () => {
    const before = taskScreenDto({ taskId: page.taskId });
    const earlier = taskScreenDto({ kind: 'after', sha256: 'c'.repeat(64) });
    serve([pageItemDto(conversationId, { kind: 'message', seq: 1 })]);
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
    renderWithDaemon(<Thread />);
    await screen.findByRole('img', { name: 'Settings before, 1440 by 900' });
    await screen.findByRole('img', {
      name: 'Settings after sign-off, from an earlier task of this goal, 1440 by 900',
    });
    expect(screen.getByText('Earlier in this goal')).toBeTruthy();
    expect(
      within(messages())
        .getAllByRole('img')
        .map((img) => img.getAttribute('alt')),
    ).toEqual([
      'Settings after sign-off, from an earlier task of this goal, 1440 by 900',
      'Settings before, 1440 by 900',
    ]);
  });

  it('draws a path a notice puts in backticks as code', async () => {
    serve([
      reply,
      pageItemDto(conversationId, {
        kind: 'notice',
        seq: 3,
        author: 'system',
        text: 'People: UI work changed shared `src/ui/button.ts`.',
      }),
    ]);
    renderWithDaemon(<Thread />);
    const path = await screen.findByText('src/ui/button.ts');
    expect(path.tagName).toBe('CODE');
    expect(path.parentElement?.textContent).toBe(
      'People: UI work changed shared src/ui/button.ts.',
    );
  });

  it.each([
    { name: 'before the first message, says where the page is', items: [], says: true },
    { name: 'keeps saying so above a notice', items: [notice], says: true },
    { name: 'says it no more once the builder has written', items: [notice, message], says: false },
  ])('$name', async ({ items, says }) => {
    serve(items);
    renderWithDaemon(<Thread />);
    await screen.findByRole('group', { name: 'Messages' });
    if (says) {
      expect(await screen.findByText('Settings is at')).toBeTruthy();
      expect(screen.getByText('/settings')).toBeTruthy();
    } else {
      expect(await screen.findByText('The padding is too tight')).toBeTruthy();
      expect(screen.queryByText('Settings is at')).toBeNull();
    }
  });

  it.each([
    { name: 'sends a notice that offers it to this page', offer: true, canSend: true },
    { name: 'offers nothing while the pass is not open', offer: true, canSend: false },
    { name: 'offers nothing on a notice that offers nothing', offer: false, canSend: true },
  ])('$name', async ({ offer, canSend }) => {
    const finding = pageItemDto(conversationId, {
      kind: 'notice',
      seq: 3,
      author: 'system',
      text: 'Review: src/settings/form.tsx:12 drops the error state.',
      ...(offer ? { offer: 'send_to_agent' as const } : {}),
    });
    const posted: { taskId: string; messageId: string }[] = [];
    server.use(
      http.post(daemonUrl('/tasks/:taskId/thread/:messageId/send-to-agent'), ({ params }) => {
        posted.push({ taskId: String(params['taskId']), messageId: String(params['messageId']) });
        return HttpResponse.json(taskMessageDto(page.taskId, { body: 'Fix it' }), { status: 201 });
      }),
    );
    serve([reply, finding]);
    renderWithDaemon(<Thread canSend={canSend} />);
    await screen.findByText('Review: src/settings/form.tsx:12 drops the error state.');
    const send = screen.queryByRole('button', { name: 'Ask Agent to Fix' });
    expect(send !== null).toBe(offer && canSend);
    if (send === null) return;
    fireEvent.click(send);
    await waitFor(() => {
      expect(posted).toEqual([{ taskId: page.taskId, messageId: finding.id }]);
    });
    expect(await screen.findByText('Sent to the agent')).toBeTruthy();
    // Sent once, it is not offered to send again.
    expect(screen.getByRole('button', { name: 'Ask Agent to Fix' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('a notice that offers Allow this shows it and sends it', async () => {
    const denied = pageItemDto(conversationId, {
      kind: 'notice',
      seq: 3,
      author: 'system',
      text: 'Auto mode stopped this Bash call:\n\n```\nnpx vercel deploy\n```',
      offer: 'allow_this',
    });
    const posted: string[] = [];
    server.use(
      http.post(daemonUrl('/tasks/:taskId/thread/:messageId/send-to-agent'), ({ params }) => {
        posted.push(String(params['messageId']));
        return HttpResponse.json(taskMessageDto(page.taskId, { body: 'I approve' }), {
          status: 201,
        });
      }),
    );
    serve([reply, denied]);
    renderWithDaemon(<Thread />);
    const allow = await screen.findByRole('button', { name: 'Allow this' });
    expect(screen.queryByRole('button', { name: 'Ask Agent to Fix' })).toBeNull();
    fireEvent.click(allow);
    await waitFor(() => {
      expect(posted).toEqual([denied.id]);
    });
    expect(await screen.findByText('Sent to the agent')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow this' })).toHaveProperty('disabled', true);
  });

  it('offers a soft judge denial’s Allow This on its tool row, which sends the go-ahead', async () => {
    const held = commandItem({
      id: 'call-2',
      status: 'denied',
      title: 'npx vercel deploy',
      command: 'npx vercel deploy',
      refusal: 'Deploying is a limit',
      deniedBy: 'judge',
      soft: true,
      outputTail: '',
      outputBytes: 0,
      exitCode: null,
    });
    const onAllow = vi.fn();
    serve([message, held]);
    renderWithDaemon(<Thread onAllow={onAllow} />);
    fireEvent.click(await screen.findByRole('button', { name: /Allow This/ }));
    expect(onAllow).toHaveBeenCalledWith(expect.objectContaining({ id: 'call-2' }));
  });
});
