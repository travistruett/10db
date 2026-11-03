import { SelfUpdateInput, SelfUpdateStatusDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
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
    ...over,
  });
}

/** A daemon that keeps the switch where the builder puts it, and records what it was sent. */
function serving(initial: SelfUpdateStatusDto) {
  let current = initial;
  const puts: SelfUpdateInput[] = [];
  server.use(
    http.get(daemonUrl(PATH), () => HttpResponse.json(current)),
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
    expect(screen.getByText(/9f8e7d6 is on main/)).toBeTruthy();
  });

  it('says so when the app runs from source and cannot update itself', async () => {
    serving(status({ runningCommit: null }));
    renderApp('/settings/updates');
    expect(await screen.findByText(/running from source/i)).toBeTruthy();
  });
});
