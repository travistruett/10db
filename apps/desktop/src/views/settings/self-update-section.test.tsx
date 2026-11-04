import {
  SELF_UPDATE_SWITCH,
  SelfUpdateInput,
  SelfUpdateStatusDto,
  SelfUpdateWaitInput,
  ShapeId,
} from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';

const RUNNING = '1a2b3c4d5e6f708192a3b4c5d6e7f80910111213';
const NEWER = '9f8e7d6c5b4a39281706f5e4d3c2b1a009182736';
const PATH = '/settings/self-update';
const SHAPE_A = ShapeId.parse('shp_01a1a4f2-5934-70f4-b48f-d5f50a92e844');
const SHAPE_B = ShapeId.parse('shp_01a1a4f2-5934-70f4-b48f-d5f50a92e845');
const DENSER = { id: SHAPE_A, title: 'Denser board' };

function status(over: Partial<SelfUpdateStatusDto> = {}): SelfUpdateStatusDto {
  return SelfUpdateStatusDto.parse({
    enabled: true,
    isDefault: true,
    runningCommit: RUNNING,
    availableCommit: null,
    notInstalling: null,
    waitMinutes: 15,
    waitingSince: null,
    draining: false,
    drainingSince: null,
    midSession: { working: 0, waitingOnCard: 0, shapes: [] },
    blocker: null,
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

describe('why the app cannot update itself, in Settings', () => {
  it('shows nothing when it can', async () => {
    serving(status());
    renderApp('/settings/updates');
    await screen.findByRole('switch', { name: 'Update 10db by itself' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['not-in-applications', 'This copy is not the one in /Applications, so it is left as it is.'],
    ['no-repository', 'This build knows no repository in build-info.json.'],
    ['gh-missing', 'gh is not installed, so 10db cannot ask GitHub for builds.'],
    ['unreachable', 'gh could not reach GitHub: it is signed out or offline.'],
    ['failed', 'The update to 1a2b3c4d5e6f failed while downloading the build: connection reset.'],
  ] as const)('shows the reason for %s under the switch', async (kind, message) => {
    serving(status({ blocker: { kind, message } }));
    renderApp('/settings/updates');
    const alert = await screen.findByRole('alert', { name: 'Why 10db will not update itself' });
    expect(alert.textContent).toContain(message);
  });

  it('insets the reason like the rows around it, since the card adds no padding', async () => {
    serving(status({ blocker: { kind: 'gh-missing', message: 'gh is not installed.' } }));
    renderApp('/settings/updates');
    const alert = await screen.findByRole('alert', { name: 'Why 10db will not update itself' });
    expect(alert.style.paddingInline).toBe('var(--mantine-spacing-md)');
    expect(alert.style.paddingBlock).toBe('var(--mantine-spacing-sm)');
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
    expect(screen.getByText('Update waiting')).toBeTruthy();
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

  it('names what the drain waits for, and what it does not wait for', async () => {
    serving(
      status({
        availableCommit: NEWER,
        waitingSince: WAITING_SINCE,
        draining: true,
        drainingSince: DRAINING_SINCE,
        midSession: { working: 1, waitingOnCard: 2, shapes: [] },
      }),
    );
    renderApp('/settings/updates');
    const draining = await screen.findByRole('status', { name: 'Update status' });
    expect(draining.textContent).toMatch(/waiting for 1 running step to finish/);
    expect(draining.textContent).toMatch(/Lanes waiting on a card \(2\) do not hold it/);
  });

  it('names the shaping conversation a drain waits for when no lane is running', async () => {
    serving(
      status({
        availableCommit: NEWER,
        waitingSince: WAITING_SINCE,
        draining: true,
        drainingSince: DRAINING_SINCE,
        midSession: { working: 1, waitingOnCard: 0, shapes: [DENSER] },
      }),
    );
    renderApp('/settings/updates');
    const draining = await screen.findByRole('status', { name: 'Update status' });
    expect(draining.textContent).toMatch(
      /waiting only for a turn in the shaping conversation “Denser board”/,
    );
    expect(draining.textContent).toMatch(/No lane is running/);
    expect(draining.textContent).toMatch(/press Stop/);
    // The switch this section shows, by its label: Stop can't end a session that ignores it.
    expect(draining.textContent).toContain(`turn ${SELF_UPDATE_SWITCH} off`);
    expect(draining.textContent).toMatch(/quit 10db/);
    expect(draining.textContent).not.toMatch(/waiting for 1 running step/);
  });

  it('names a conversation among the steps a drain waits for', async () => {
    serving(
      status({
        availableCommit: NEWER,
        waitingSince: WAITING_SINCE,
        draining: true,
        drainingSince: DRAINING_SINCE,
        midSession: { working: 2, waitingOnCard: 0, shapes: [DENSER] },
      }),
    );
    renderApp('/settings/updates');
    const draining = await screen.findByRole('status', { name: 'Update status' });
    expect(draining.textContent).toMatch(
      /waiting for 2 running steps to finish, among them a turn in the shaping conversation “Denser board”/,
    );
  });

  it('names what holds an update that waits', async () => {
    serving(
      status({
        availableCommit: NEWER,
        waitingSince: WAITING_SINCE,
        midSession: { working: 0, waitingOnCard: 1, shapes: [] },
      }),
    );
    renderApp('/settings/updates');
    const waiting = await screen.findByRole('status', { name: 'Update status' });
    expect(waiting.textContent).toMatch(/Holding it now: 1 lane waiting on a card/);
  });

  it('names the shaping conversations that hold an update that waits', async () => {
    serving(
      status({
        availableCommit: NEWER,
        waitingSince: WAITING_SINCE,
        midSession: {
          working: 3,
          waitingOnCard: 0,
          shapes: [DENSER, { id: SHAPE_B, title: 'Login flow' }],
        },
      }),
    );
    renderApp('/settings/updates');
    const waiting = await screen.findByRole('status', { name: 'Update status' });
    expect(waiting.textContent).toMatch(
      /Holding it now: 1 running step and turns in 2 shaping conversations \(“Denser board”, “Login flow”\)/,
    );
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

  it.each([
    ['failed', /update to 9f8e7d6 failed.*off and on/i],
    ['rolled-back', /rolled back from 9f8e7d6.*once main has a newer commit/i],
  ] as const)(
    'says why a head that is %s is not installing, and offers no Install Now',
    async (notInstalling, text) => {
      serving(status({ availableCommit: NEWER, notInstalling }));
      renderApp('/settings/updates');
      const note = await screen.findByRole('status', { name: 'Update status' });
      expect(note.textContent).toMatch(text);
      expect(note.textContent).not.toMatch(/is waiting/);
      expect(screen.getByText('Update not installing')).toBeTruthy();
      expect(screen.queryByText('Update waiting')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Install Now' })).toBeNull();
    },
  );

  it('says a head has no build yet, and still takes Install Now for when it has', async () => {
    serving(status({ availableCommit: NEWER, notInstalling: 'unbuilt' }));
    renderApp('/settings/updates');
    const note = await screen.findByRole('status', { name: 'Update status' });
    expect(note.textContent).toMatch(/9f8e7d6 has no finished build yet/);
    expect(note.textContent).not.toMatch(/is waiting/);
    expect(screen.getByText('Update has no build yet')).toBeTruthy();
    expect(screen.queryByText('Update waiting')).toBeNull();
    // The daemon remembers it: the factory drains the moment the build is staged.
    fireEvent.click(screen.getByRole('button', { name: 'Install Now' }));
    await waitFor(() => {
      expect(installNows.count).toBe(1);
    });
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
