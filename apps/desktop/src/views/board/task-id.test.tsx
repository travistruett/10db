import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { taskDto } from '../../test/fixtures';
import { shortTaskId } from './task-id';
import { TaskCardMenu } from './task-card-menu';
import { TaskDrawer } from './task-drawer';

/** The clipboard is the boundary: jsdom has none, so each test gets one that records what is written. */
const written: string[] = [];

beforeEach(() => {
  written.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn((text: string) => {
        written.push(text);
        return Promise.resolve();
      }),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('shortTaskId', () => {
  it('keeps the prefix and the random tail, which tell tasks apart', () => {
    expect(shortTaskId('tsk_01a18d66-184b-7000-8000-0123456789ab')).toBe('tsk_…456789ab');
  });

  it('leaves an ID that is already short as it is', () => {
    expect(shortTaskId('tsk_abc')).toBe('tsk_abc');
  });
});

describe('Copy ID on the card menu', () => {
  async function openMenu(task = taskDto({ title: 'Ship it' })) {
    server.use(...baseHandlers());
    renderWithDaemon(
      <TaskCardMenu
        task={task}
        latest={undefined}
        parkedDependency={null}
        moves={[]}
        onMove={() => undefined}
        onStart={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Ship it' }));
    return task;
  }

  it('copies the full task ID and says it was copied', async () => {
    const task = await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy ID', hidden: true }));
    await waitFor(() => {
      expect(written).toEqual([task.id]);
    });
    expect(written[0]).toMatch(/^tsk_/);
    expect(await screen.findByRole('menuitem', { name: 'Copied', hidden: true })).toBeTruthy();
  });
});

describe('the task ID in the drawer', () => {
  function open(task = taskDto({ title: 'Ship it' })) {
    server.use(
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderWithDaemon(
      <TaskDrawer task={task} columnName="Ready" peers={new Map()} onClose={() => undefined} />,
    );
    return task;
  }

  it('shows a short form and copies the full ID with one click, confirming it', async () => {
    const task = open();
    const d = await screen.findByRole('dialog', { name: 'Task' });
    const button = within(d).getByRole('button', { name: /^Copy task ID/ });
    expect(button.textContent).toBe(shortTaskId(task.id));
    expect(button.textContent).not.toBe(task.id);
    fireEvent.click(button);
    await waitFor(() => {
      expect(written).toEqual([task.id]);
    });
    expect(await within(d).findByText('Copied')).toBeTruthy();
  });
});
