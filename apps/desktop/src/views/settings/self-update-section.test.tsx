import { SelfUpdateInput, SelfUpdateStatusDto, SelfUpdateWaitInput } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';

const RUNNING = '1a2b3c4d5e6f708192a3b4c5d6e7f80910111213';
const NEWER = '9f8e7d6c5b4a39281706f5e4d3c2b1a009182736';
const PATH = '/settings/self-update';

function status(over: Partial<SelfUpdateStatusDto> = {}): SelfUpdateStatusDto {
  return SelfUpdateStatusDto.parse({
    enabled: true,
    isDefault: true,
    runningCommit: RUNNING,
    availableCommit: null,
    waitMinutes: 15,
    waitingSince: null,
    draining: false,
    drainingSince: null,
    ...over,
  });
}

const WAITING_SINCE = '2026-11-03T12:00:00.000Z';
const DRAINING_SINCE = '2026-11-03T12:15:00.000Z';
/** The wait limits and Install Now presses the daemon was sent. */
const waits: (number | null)[] = [];
const installNows = { count: 0 };

/** A daemon that keeps the switch where the builder puts it, and records what it was sent. */
function serving(initial: SelfUpdateStatusDto) {
  let current = initial;
  const puts: SelfUpdateInput[] = [];
  server.use(
    http.get(daemonUrl(PATH), () => HttpResponse.json(current)),
    http.put(daemonUrl(`${PATH}/wait`), async ({ request }) => {
      const input = SelfUpdateWaitInput.parse(await request.json());
      waits.push(input.minutes);
      current = status({ ...current, waitMinutes: input.minutes ?? 15 });
      return HttpResponse.json(current);
    }),
    http.post(daemonUrl(`${PATH}/install-now`), () => {
      installNows.count += 1;
      current = status({ ...current, draining: true, drainingSince: DRAINING_SINCE });
      return HttpResponse.json(current);
    }),
    http.put(daemonUrl(PATH), async ({ request }) => {
      const input = SelfUpdateInput.parse(await request.json());
      puts.push(input);
      current = status({
        enabled: input.enabled ?? true,
        isDefault: input.enabled === null,
      });
      return HttpResponse.json(current);
    }),
    ...baseHandlers(),
  );
  return puts;
}

describe('the self-update switch in Settings', () => {
  it('is on by default, and says it follows the repository the app was built for', async () => {
    serving(status());
    renderApp('/settings/updates');
    const toggle = await screen.findByRole('switch', { name: 'Update 10db by itself' });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).checked).toBe(true);
    });
    expect(screen.getByText(/repository this app was built from/i)).toBeTruthy();
  });

  it('is not on a project’s General section: it is one setting for the whole app', async () => {
    serving(status());
    renderApp('/settings/general');
    await screen.findByRole('heading', { name: 'General' });
    expect(screen.queryByRole('switch', { name: 'Update 10db by itself' })).toBeNull();
  });

  it('shows off when the builder has turned it off', async () => {
    serving(status({ enabled: false, isDefault: false }));
    renderApp('/settings/updates');
    const toggle = await screen.findByRole('switch', { name: 'Update 10db by itself' });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).checked).toBe(false);
    });
  });

  it('turns off when the builder switches it off, and sends exactly that', async () => {
    const puts = serving(status());
    renderApp('/settings/updates');
    const toggle = await screen.findByRole('switch', { name: 'Update 10db by itself' });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).checked).toBe(true);
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(puts).toEqual([{ enabled: false }]);
    });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).checked).toBe(false);
    });
  });

  it('turns on again when the builder switches it on', async () => {
    const puts = serving(status({ enabled: false, isDefault: false }));
    renderApp('/settings/updates');
    const toggle = await screen.findByRole('switch', { name: 'Update 10db by itself' });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).checked).toBe(false);
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(puts).toEqual([{ enabled: true }]);
    });
  });

  it('says which build is running and when a newer one is waiting', async () => {
    serving(status({ availableCommit: NEWER }));
    renderApp('/settings/updates');
    expect(await screen.findByText(/Running 1a2b3c4/)).toBeTruthy();
    expect(screen.getByText(/9f8e7d6 is waiting/)).toBeTruthy();
  });

  it('says so when the app runs from source and cannot update itself', async () => {
    serving(status({ runningCommit: null }));
    renderApp('/settings/updates');
    expect(await screen.findByText(/running from source/i)).toBeTruthy();
  });
});

describe('a waiting update in Settings', () => {
  beforeEach(() => {
    waits.length = 0;
    installNows.count = 0;
  });

  it('says an update is waiting, since when, and when lanes will pause for it', async () => {
    serving(status({ availableCommit: NEWER, waitingSince: WAITING_SINCE, waitMinutes: 20 }));
    renderApp('/settings/updates');
    const waiting = await screen.findByRole('status', { name: 'Update status' });
    expect(waiting.textContent).toMatch(/9f8e7d6 is waiting/);
    expect(waiting.textContent).toMatch(/since 2026-11-03/);
    expect(waiting.textContent).toMatch(/after 20 minutes/);
    expect(waiting.textContent).not.toMatch(/draining/i);
  });

  it('says the factory is draining, since when, and why lanes paused', async () => {
    serving(
      status({
        availableCommit: NEWER,
        waitingSince: WAITING_SINCE,
        draining: true,
        drainingSince: DRAINING_SINCE,
      }),
    );
    renderApp('/settings/updates');
    const draining = await screen.findByRole('status', { name: 'Update status' });
    expect(draining.textContent).toMatch(/draining since 2026-11-03/i);
    expect(draining.textContent).toMatch(/no new steps/i);
    expect(draining.textContent).toMatch(/running steps finish/i);
    // Drained already: Install Now has nothing left to do.
    expect(screen.queryByRole('button', { name: 'Install Now' })).toBeNull();
  });

  it('shows no update status when none is waiting', async () => {
    serving(status());
    renderApp('/settings/updates');
    await screen.findByRole('switch', { name: 'Update 10db by itself' });
    expect(screen.queryByRole('status', { name: 'Update status' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Install Now' })).toBeNull();
  });

  it('starts the drain at once at Install Now', async () => {
    serving(status({ availableCommit: NEWER, waitingSince: WAITING_SINCE }));
    renderApp('/settings/updates');
    fireEvent.click(await screen.findByRole('button', { name: 'Install Now' }));
    await waitFor(() => {
      expect(installNows.count).toBe(1);
    });
    expect((await screen.findByRole('status', { name: 'Update status' })).textContent).toMatch(
      /draining since/i,
    );
  });

  it('offers no Install Now with the switch off', async () => {
    serving(status({ enabled: false, isDefault: false, availableCommit: NEWER }));
    renderApp('/settings/updates');
    await screen.findByRole('switch', { name: 'Update 10db by itself' });
    expect(screen.queryByRole('button', { name: 'Install Now' })).toBeNull();
  });

  it('sets how many minutes an update waits before lanes pause', async () => {
    serving(status());
    renderApp('/settings/updates');
    const input = await screen.findByRole('textbox', { name: 'Minutes before lanes pause' });
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('15');
    });
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(waits).toEqual([30]);
    });
  });
});
