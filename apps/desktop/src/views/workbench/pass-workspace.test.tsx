import { TaskId } from '@10db/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { multipartParts, useNodeMultipart } from '../../test/multipart';
import {
  askItem,
  PASS_NOW,
  passHandlers,
  pagesByStatus,
  passViewDto,
  taskMessageDto,
} from '../../test/pass-fixtures';
import { clockTime } from './page-status';
import { PassWorkspace } from './pass-workspace';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(PASS_NOW) });
  server.use(...passHandlers(), ...baseHandlers());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderWorkspace(selected: (pages: Pages) => TaskId | null = () => null) {
  const pages = pagesByStatus();
  const onSelect = vi.fn();
  renderWithDaemon(
    <PassWorkspace
      view={passViewDto({ pages: Object.values(pages) })}
      inbox={[askItem(pages.asks)]}
      project={projectViewDto()}
      selected={selected(pages)}
      onSelect={onSelect}
    />,
  );
  await screen.findByRole('list', { name: 'Pages in this pass' });
  return { pages, onSelect };
}

type Pages = ReturnType<typeof pagesByStatus>;

function queueRows() {
  return within(screen.getByRole('list', { name: 'Pages in this pass' })).getAllByRole('button');
}

describe('PassWorkspace queue', () => {
  it('lists the pages as buttons in queue order, each with its state line', async () => {
    const { pages } = await renderWorkspace();
    expect(queueRows().map((row) => row.textContent)).toEqual([
      'PeopleAsks a question',
      'ReportsThe session kept crashing or could not start.',
      'SettingsReady · 3 min',
      'BillingWorking · 4 min · median 5',
      `TeamPaused: usage limit, resumes ${clockTime(pages.paused.pausedUntil ?? '')}`,
      'HomeNot started',
    ]);
  });

  it('marks the selected page current and selects another on a click', async () => {
    const { pages, onSelect } = await renderWorkspace();
    // Nothing selected: the queue's first row is the one shown.
    expect(queueRows().filter((row) => row.getAttribute('aria-current') === 'true')).toHaveLength(
      1,
    );
    expect(queueRows()[0]?.getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    expect(onSelect).toHaveBeenCalledWith(pages.ready.taskId);
  });

  it('draws the selected page as current when the route names it', async () => {
    await renderWorkspace((pages) => pages.working.taskId);
    const current = queueRows().filter((row) => row.getAttribute('aria-current') === 'true');
    expect(current.map((row) => row.textContent)).toEqual(['BillingWorking · 4 min · median 5']);
    const thread = screen.getByRole('region', { name: 'Billing' });
    expect(await within(thread).findByText('Billing is at')).toBeTruthy();
  });

  it('names a page that waits on the builder heavier, and dims the rest', async () => {
    await renderWorkspace();
    const name = (page: string) =>
      within(screen.getByRole('button', { name: new RegExp(`^${page}`) })).getByText(page);
    expect(['Settings', 'People', 'Billing'].map((page) => name(page).style.fontWeight)).toEqual([
      '500',
      '500',
      '400',
    ]);
    const dimmed = queueRows().map((row) =>
      row.style.color === 'var(--mantine-color-dimmed)' ? 'dimmed' : 'plain',
    );
    expect(dimmed).toEqual(['plain', 'plain', 'plain', 'dimmed', 'dimmed', 'dimmed']);
  });
});

describe('PassWorkspace working line', () => {
  it('ends a working page’s thread with what the agent does, and ticks the minutes without announcing', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval'],
      now: Date.parse(PASS_NOW),
    });
    await renderWorkspace((pages) => pages.working.taskId);
    const thread = screen.getByRole('region', { name: 'Billing' });
    expect(within(thread).getByText('Working · 4 min · editing settings/page.tsx')).toBeTruthy();
    expect(within(thread).getByText('1 file changed so far')).toBeTruthy();
    expect(within(thread).queryByRole('status')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(within(thread).getByText('Working · 5 min · editing settings/page.tsx')).toBeTruthy();
  });

  it('draws no working line on a page that is not working', async () => {
    await renderWorkspace((pages) => pages.ready.taskId);
    const thread = screen.getByRole('region', { name: 'Settings' });
    expect(within(thread).queryByText(/^Working/)).toBeNull();
  });
});

describe('PassWorkspace composer', () => {
  it('sends the shown page’s draft, words and picture, to that page’s thread', async () => {
    const NodeFile = await useNodeMultipart();
    let posted: { taskId: string; text: string | undefined; pictures: readonly string[] } | null =
      null;
    server.use(
      http.post(daemonUrl('/tasks/:taskId/thread'), async ({ params, request }) => {
        const parts = multipartParts(await request.text());
        posted = {
          taskId: String(params['taskId']),
          text: parts.text['text'],
          pictures: parts.files['picture'] ?? [],
        };
        return HttpResponse.json(
          taskMessageDto(TaskId.parse(params['taskId']), { body: 'padding too tight' }),
          { status: 201 },
        );
      }),
    );
    const { pages } = await renderWorkspace((p) => p.ready.taskId);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Settings' });
    fireEvent.change(input, { target: { value: 'padding too tight' } });
    const shot = new NodeFile([new Uint8Array([1])], 'tight.png', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { files: [shot], getData: () => '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(posted).toEqual({
        taskId: pages.ready.taskId,
        text: 'padding too tight',
        pictures: ['tight.png'],
      });
    });
    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });

  it('keeps each page’s draft while another page is shown', async () => {
    const pages = pagesByStatus();
    const view = passViewDto({ pages: Object.values(pages) });
    function Selecting() {
      const [selected, setSelected] = useState<TaskId>(pages.ready.taskId);
      return (
        <PassWorkspace
          view={view}
          inbox={[]}
          project={projectViewDto()}
          selected={selected}
          onSelect={setSelected}
        />
      );
    }
    renderWithDaemon(<Selecting />);
    const message = (page: string) =>
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: `Message to ${page}` });
    await screen.findByRole('textbox', { name: 'Message to Settings' });
    fireEvent.change(message('Settings'), { target: { value: 'half a thought' } });
    fireEvent.click(screen.getByRole('button', { name: /^Billing/ }));
    expect(message('Billing').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    expect(message('Settings').value).toBe('half a thought');
  });
});
