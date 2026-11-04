import { mintId, type ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import {
  decisionProposal,
  goalProposal,
  looseTaskProposal,
  questionProposal,
  shapeDto,
  shapeMessageDto,
  shapeViewDto,
} from '../../test/shape-fixtures';

// Shape spec §4 D1: under 1100 px the Proposed sidebar is a drawer, and each count in the bar's
// summary line opens it at that count's section.

const project = projectViewDto();
const realObserver = window.ResizeObserver;

/** Reports a 900 px wide element, so the split pane chooses the drawer layout. */
class NarrowObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 900, width: 900, height: 600 };
    const box = [{ inlineSize: 900, blockSize: 600 }];
    this.callback(
      [
        {
          target,
          contentRect: { ...rect, toJSON: () => rect },
          borderBoxSize: box,
          contentBoxSize: box,
          devicePixelContentBoxSize: box,
        },
      ],
      this,
    );
  }
  unobserve(): void {
    // Nothing to stop.
  }
  disconnect(): void {
    // Nothing to stop.
  }
}

beforeEach(() => {
  window.ResizeObserver = NarrowObserver;
});
afterEach(() => {
  window.ResizeObserver = realObserver;
});

function openNarrow(view: ShapeViewDto): ReturnType<typeof renderApp> {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([view.shape])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
    ...baseHandlers(),
  );
  return renderApp(`/shape/${view.shape.id}`);
}

describe('Shape: the drawer layout', () => {
  const base = shapeDto({
    projectId: project.id,
    state: 'proposed',
    proposeUnlocked: true,
    round: 1,
  });
  const view = shapeViewDto({
    shape: base,
    messages: [shapeMessageDto(base.id)],
    proposals: [
      goalProposal('brainstorm', ['one', 'two']),
      looseTaskProposal('density', { title: 'Compact card density' }),
      looseTaskProposal('scrollbars', { title: 'Thin board scrollbars' }),
      decisionProposal('replaces-adopt'),
      questionProposal('ship-date'),
    ],
  });

  it('opens the drawer at the first row of the section a count names', async () => {
    openNarrow(view);
    const bar = await screen.findByRole('group', { name: 'Summary' });
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: '2 loose' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    const first = within(sidebar).getByRole('button', { name: /^Compact card density/ });
    expect(document.activeElement).toBe(first);
  });

  it('moves to another section when the drawer is already open', async () => {
    openNarrow(view);
    const bar = await screen.findByRole('group', { name: 'Summary' });
    fireEvent.click(within(bar).getByRole('button', { name: '2 loose' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    fireEvent.click(within(bar).getByRole('button', { name: '1 goal' }));
    const goal = within(sidebar).getByRole('button', { name: /^Brainstorm chat/ });
    expect(document.activeElement).toBe(goal);
  });

  it('opens at a converted row when only loose tasks were converted and no goal exists', async () => {
    const done = {
      state: 'accepted' as const,
      converted: { goalId: null, taskIds: [mintId('Task')], decisionId: null },
    };
    openNarrow(
      shapeViewDto({
        shape: base,
        messages: [shapeMessageDto(base.id)],
        proposals: [
          looseTaskProposal('density', { title: 'Compact card density', ...done }),
          looseTaskProposal('scrollbars', { title: 'Thin board scrollbars', ...done }),
        ],
      }),
    );
    const bar = await screen.findByRole('group', { name: 'Summary' });
    fireEvent.click(within(bar).getByRole('button', { name: '2 converted' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    const first = within(sidebar).getByRole('button', { name: /^Compact card density/ });
    expect(document.activeElement).toBe(first);
  });

  it('lifts the round filter in an open drawer to focus a converted row', async () => {
    const done = {
      state: 'accepted' as const,
      converted: { goalId: null, taskIds: [mintId('Task')], decisionId: null },
    };
    openNarrow(
      shapeViewDto({
        shape: { ...base, round: 2 },
        messages: [shapeMessageDto(base.id)],
        proposals: [
          looseTaskProposal('density', { title: 'Compact card density', ...done }),
          goalProposal('brainstorm', ['one'], { round: 2, mark: 'new' }),
        ],
      }),
    );
    const bar = await screen.findByRole('group', { name: 'Summary' });
    fireEvent.click(within(bar).getByRole('button', { name: '1 goal' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    const filter = within(sidebar).getByRole('button', { name: '1 change in round 2' });
    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(bar).getByRole('button', { name: '1 converted' }));
    expect(filter.getAttribute('aria-pressed')).toBe('false');
    const row = within(sidebar).getByRole('button', { name: /^Compact card density/ });
    expect(document.activeElement).toBe(row);
  });

  it('opens at the top, with no jump left over, from the Proposed button', async () => {
    openNarrow(view);
    const bar = await screen.findByRole('group', { name: 'Summary' });
    fireEvent.click(within(bar).getByRole('button', { name: '2 loose' }));
    await screen.findByRole('region', { name: 'Proposed' });
    const toggle = screen.getByRole('button', { name: 'Proposed' });
    fireEvent.click(toggle);
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    fireEvent.click(toggle);
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    expect(sidebar.contains(document.activeElement)).toBe(false);
  });

  // The drawer is laid over the bar's right end, where the Proposed button is, so a mouse user
  // needs a close control inside it.
  it('closes from a Close button in the drawer and leaves focus on the Proposed button', async () => {
    openNarrow(view);
    const bar = await screen.findByRole('group', { name: 'Summary' });
    fireEvent.click(within(bar).getByRole('button', { name: '2 loose' }));
    await screen.findByRole('region', { name: 'Proposed' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Proposed' }));
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Proposed' }));
  });

  it('closes on Esc, wherever focus is, and leaves focus on the Proposed button', async () => {
    openNarrow(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Proposed' }));
    await screen.findByRole('region', { name: 'Proposed' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Proposed' }));
  });

  it('leaves Esc to an open menu in the drawer', async () => {
    openNarrow(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Proposed' }));
    await screen.findByRole('region', { name: 'Proposed' });
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    menu.remove();
    expect(screen.getByRole('region', { name: 'Proposed' })).toBeTruthy();
  });
});
