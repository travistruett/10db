import type { ShapeViewDto } from '@10db/contracts';
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
});
