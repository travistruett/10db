import type { InboxItemDto, ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { inboxItemDto, projectViewDto } from '../../test/fixtures';
import { shapeDto, shapeMessageDto, shapeViewDto } from '../../test/shape-fixtures';

// From a send until Claude's first output, and between outputs, the conversation says Claude is
// working. It stops when the turn ends or is stopped, and a turn waiting on an Inbox card says so
// instead.

const project = projectViewDto();
const base = shapeDto({ projectId: project.id, state: 'listening' });

const turn = (running: boolean): ShapeViewDto['turn'] => ({
  running,
  queued: 0,
  proposing: false,
  rehearsing: false,
  waitingForUpdate: false,
});

const viewOf = (running: boolean): ShapeViewDto =>
  shapeViewDto({ shape: base, messages: [shapeMessageDto(base.id)], turn: turn(running) });

function card(): InboxItemDto {
  return inboxItemDto({
    kind: 'permission',
    projectId: project.id,
    title: 'Allow Bash?',
    body: 'curl -s https://example.com',
    category: 'access',
    options: [
      { label: 'allow_once', description: 'Allow this call once' },
      { label: 'deny', description: 'Deny; your note is passed to the agent' },
    ],
    detail: { shapeId: base.id },
  });
}

/** Serves the conversation as `current()` says and these open cards. */
function serve(
  current: () => ShapeViewDto,
  items: InboxItemDto[] = [],
  ...more: Parameters<typeof server.use>
) {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([base])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(current())),
    http.get(daemonUrl('/inbox'), () => HttpResponse.json(items)),
    ...more,
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
}

const WORKING = 'Claude is working…';
const working = (): HTMLElement | null => screen.queryByText(WORKING);

describe('The working line in a Plan conversation', () => {
  it('shows while a turn runs, whether or not anything has been output yet', async () => {
    serve(() => viewOf(true));
    renderApp(`/shape/${base.id}`);

    const line = await screen.findByText(WORKING);
    // Announced politely, so a screen reader hears it without it taking focus.
    expect(line.closest('[role="status"]')).not.toBeNull();
  });

  it('is not there when no turn runs', async () => {
    serve(() => viewOf(false));
    renderApp(`/shape/${base.id}`);

    await screen.findByRole('textbox', { name: 'Message' });
    expect(working()).toBeNull();
  });

  it('shows from the send, before the daemon reports the turn running', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve(
      () => viewOf(false),
      [],
      http.post(daemonUrl('/shapes/:shapeId/messages'), async () => {
        await held;
        return HttpResponse.json(shapeMessageDto(base.id), { status: 202 });
      }),
    );
    renderApp(`/shape/${base.id}`);

    const input = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'What did AWS cost last month?' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(await screen.findByText(WORKING)).toBeTruthy();
    release();
    await waitFor(() => {
      expect(working()).toBeNull();
    });
  });

  it('says it is waiting for an answer, not that Claude is working, while a card is open', async () => {
    serve(() => viewOf(true), [card()]);
    renderApp(`/shape/${base.id}`);

    await screen.findByRole('region', { name: 'Waiting for your answer' });
    expect(working()).toBeNull();
    expect(screen.getByText('Waiting for your answer in the Inbox…')).toBeTruthy();
  });

  it('goes once Stop is pressed, before the turn has ended', async () => {
    serve(
      () => viewOf(true),
      [],
      http.post(daemonUrl('/shapes/:shapeId/stop'), async () => {
        await new Promise<void>(() => undefined);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderApp(`/shape/${base.id}`);

    await screen.findByText(WORKING);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(working()).toBeNull();
    });
  });

  it('shows between outputs: a tool line is the last message and the turn still runs', async () => {
    const view = shapeViewDto({
      shape: base,
      messages: [
        shapeMessageDto(base.id),
        shapeMessageDto(base.id, { author: 'claude', kind: 'tool', body: 'Read · notes.md' }),
      ],
      turn: turn(true),
    });
    serve(() => view);
    renderApp(`/shape/${base.id}`);

    expect(await screen.findByText(WORKING)).toBeTruthy();
  });
});
