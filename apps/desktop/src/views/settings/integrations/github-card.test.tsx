import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../../test/daemon';
import { daemonEvent } from '../../../test/fixtures';
import { benchmarkStatusDto } from '../../../test/benchmark-fixtures';
import { DEVICE_SIGNIN, githubStatusDto } from '../../../test/github-fixtures';

type Status = ReturnType<typeof githubStatusDto>;

/** The daemon's side of the GitHub card: a status that changes with Sign In, and what was asked. */
function serve(initial: Partial<Status> = {}, opts: { readonly signinRefusal?: string } = {}) {
  let status = githubStatusDto(initial);
  const requests: string[] = [];
  const sockets: { send(data: string): void }[] = [];
  let seq = 10;
  server.use(
    http.get(daemonUrl('/benchmarks/status'), () => HttpResponse.json(benchmarkStatusDto())),
    http.get(daemonUrl('/github'), ({ request }) => {
      const recheck = new URL(request.url).searchParams.get('recheck');
      requests.push(recheck === null ? 'status' : `recheck=${recheck}`);
      return HttpResponse.json(status);
    }),
    http.post(daemonUrl('/github/signin'), () => {
      requests.push('signin');
      if (opts.signinRefusal !== undefined)
        return HttpResponse.json(
          { error: 'upstream', message: opts.signinRefusal },
          { status: 502 },
        );
      status = { ...status, signingIn: DEVICE_SIGNIN };
      return HttpResponse.json({ code: DEVICE_SIGNIN.code, url: DEVICE_SIGNIN.url });
    }),
    http.delete(daemonUrl('/github/signin'), () => {
      requests.push('cancel');
      status = { ...status, signingIn: null };
      return new HttpResponse(null, { status: 204 });
    }),
    ...baseHandlers(),
    eventStream.addEventListener('connection', ({ client }) => {
      sockets.push(client);
    }),
  );
  const end = (data: {
    ok: boolean;
    login: string | null;
    message: string | null;
    cancelled: boolean;
    now: Partial<Status>;
  }) => {
    const { now, ...ended } = data;
    status = { ...status, signingIn: null, ...now };
    seq += 1;
    sockets.at(-1)?.send(
      JSON.stringify(
        daemonEvent({
          seq,
          type: 'github.login_ended',
          entityType: 'github',
          entityId: 'login',
          data: ended,
        }),
      ),
    );
  };
  renderApp('/settings/integrations');
  return { requests, end, sockets };
}

const card = async () => screen.findByRole('group', { name: 'GitHub' });

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
let open: MockInstance<typeof window.open>;
let popup: Window;
beforeEach(() => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  if (frame.contentWindow === null) throw new Error('the test page has no frame window');
  popup = frame.contentWindow;
  popup.opener = window;
  open = vi.spyOn(window, 'open').mockReturnValue(popup);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  open.mockRestore();
  writeText.mockClear();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('Settings › Integrations: GitHub', () => {
  it('reads "Checking…" in dimmed text until the status arrives', async () => {
    server.use(
      http.get(daemonUrl('/benchmarks/status'), () => HttpResponse.json(benchmarkStatusDto())),
      http.get(daemonUrl('/github'), async () => {
        await new Promise(() => undefined);
        return HttpResponse.json(githubStatusDto());
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/integrations');
    const github = await card();
    expect(within(github).getByText('Checking…')).toBeTruthy();
    expect(within(github).queryByRole('button')).toBeNull();
  });

  it.each([
    {
      name: 'signed in',
      status: {},
      label: 'Signed in as octocat',
      color: 'teal',
      buttons: ['Switch Account', 'Check Again'],
    },
    {
      name: 'signed out',
      status: { state: 'signed_out', login: null },
      label: 'Not signed in',
      color: 'yellow',
      buttons: ['Sign In', 'Check Again'],
    },
    {
      name: 'gh not installed',
      status: { state: 'not_installed', login: null },
      label: "gh isn't installed",
      color: 'yellow',
      buttons: ['Check Again'],
    },
    {
      name: 'unreachable, never shown as signed out',
      status: { state: 'unreachable', login: null },
      label: "Couldn't reach GitHub",
      color: 'yellow',
      buttons: ['Check Again'],
    },
  ] as const)(
    '$name: $label, $color, buttons $buttons',
    async ({ status, label, color, buttons }) => {
      serve(status);
      const github = await card();
      expect(await within(github).findByText(label)).toBeTruthy();
      expect(within(github).getByTestId('connection-dot').getAttribute('data-color')).toBe(color);
      expect(
        within(github)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(buttons);
      expect(within(github).getByText(/Opens pull requests, watches their checks/)).toBeTruthy();
      expect(
        within(github).getByText(/Without it: Pull requests, CI checks and self-update stop/),
      ).toBeTruthy();
    },
  );

  it('Sign In is the one filled button of a signed-out card', async () => {
    serve({ state: 'signed_out', login: null });
    const github = await card();
    const signIn = await within(github).findByRole('button', { name: 'Sign In' });
    expect(signIn.getAttribute('data-variant')).toBe('filled');
    expect(
      within(github).getByRole('button', { name: 'Check Again' }).getAttribute('data-variant'),
    ).toBe('default');
  });

  it("a signed-in card says the login is the Mac's and offers no sign-out", async () => {
    serve();
    const github = await card();
    expect(
      await within(github).findByText("This is gh's own login, the same one your terminal uses."),
    ).toBeTruthy();
    expect(within(github).queryByRole('button', { name: /Sign Out/ })).toBeNull();
  });

  it('a card with no gh says where 10db looks and how to install it', async () => {
    serve({ state: 'not_installed', login: null });
    const github = await card();
    expect(
      await within(github).findByText(/\/opt\/homebrew\/bin, \/usr\/local\/bin and \/usr\/bin/),
    ).toBeTruthy();
    expect(within(github).getByText(/brew install gh/)).toBeTruthy();
  });

  it('Check Again asks for a recheck and shows what it finds', async () => {
    const { requests } = serve({ state: 'not_installed', login: null });
    const github = await card();
    server.use(
      http.get(daemonUrl('/github'), ({ request }) => {
        requests.push(new URL(request.url).search);
        return HttpResponse.json(githubStatusDto({ state: 'signed_out', login: null }));
      }),
    );
    fireEvent.click(await within(github).findByRole('button', { name: 'Check Again' }));
    expect(await within(github).findByText('Not signed in')).toBeTruthy();
    expect(requests).toContain('?recheck=1');
  });

  describe('Sign In', () => {
    it('shows a loader, then the code in large monospace with Copy, Open Page Again and Cancel, and opens the page', async () => {
      const { requests } = serve({ state: 'signed_out', login: null });
      const github = await card();
      fireEvent.click(await within(github).findByRole('button', { name: 'Sign In' }));
      const code = await within(github).findByText(DEVICE_SIGNIN.code);
      expect(requests).toContain('signin');
      expect(open).toHaveBeenCalledWith(DEVICE_SIGNIN.url, '_blank');
      // The code and the waiting line sit in a polite live region.
      const live = code.closest('[aria-live="polite"]');
      expect(live).not.toBeNull();
      expect(
        within(live as HTMLElement).getByText(/Waiting for you to approve in the browser/),
      ).toBeTruthy();
      expect(
        within(github)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Copy', 'Open Page Again', 'Cancel']);
      fireEvent.click(within(github).getByRole('button', { name: 'Copy' }));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(DEVICE_SIGNIN.code);
      });
      fireEvent.click(within(github).getByRole('button', { name: 'Open Page Again' }));
      expect(open).toHaveBeenCalledTimes(2);
    });

    it('mounted while a sign-in runs, shows the code and Cancel', async () => {
      serve({ state: 'signed_out', login: null, signingIn: DEVICE_SIGNIN });
      const github = await card();
      expect(await within(github).findByText(DEVICE_SIGNIN.code)).toBeTruthy();
      expect(within(github).getByRole('button', { name: 'Cancel' })).toBeTruthy();
      expect(within(github).queryByRole('button', { name: 'Sign In' })).toBeNull();
    });

    it('Cancel stops it and the card returns to Sign In', async () => {
      const { requests } = serve({ state: 'signed_out', login: null, signingIn: DEVICE_SIGNIN });
      const github = await card();
      fireEvent.click(await within(github).findByRole('button', { name: 'Cancel' }));
      expect(await within(github).findByRole('button', { name: 'Sign In' })).toBeTruthy();
      expect(requests).toContain('cancel');
      expect(within(github).queryByText(DEVICE_SIGNIN.code)).toBeNull();
    });

    it('a page that will not open says so and keeps the code on screen', async () => {
      open.mockReturnValue(null);
      serve({ state: 'signed_out', login: null });
      const github = await card();
      fireEvent.click(await within(github).findByRole('button', { name: 'Sign In' }));
      expect(await within(github).findByText(DEVICE_SIGNIN.code)).toBeTruthy();
      expect(within(github).getByText(/The browser did not open the page/)).toBeTruthy();
      expect(within(github).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    });

    it("gh's refusal shows beside Sign In, which stays to retry", async () => {
      serve({ state: 'signed_out', login: null }, { signinRefusal: "gh didn't print a code" });
      const github = await card();
      fireEvent.click(await within(github).findByRole('button', { name: 'Sign In' }));
      expect(await within(github).findByText("gh didn't print a code")).toBeTruthy();
      expect(within(github).getByRole('button', { name: 'Sign In' })).toBeTruthy();
    });

    it('the end of a sign-in turns the header teal with "just now" and closes the code', async () => {
      const { end, sockets } = serve({
        state: 'signed_out',
        login: null,
        signingIn: DEVICE_SIGNIN,
      });
      const github = await card();
      await within(github).findByText(DEVICE_SIGNIN.code);
      await waitFor(() => {
        expect(sockets).toHaveLength(1);
      });
      end({
        ok: true,
        login: 'octocat',
        message: null,
        cancelled: false,
        now: { state: 'signed_in', login: 'octocat' },
      });
      expect(await within(github).findByText('Signed in as octocat')).toBeTruthy();
      expect(within(github).getByText('just now')).toBeTruthy();
      expect(within(github).queryByText(DEVICE_SIGNIN.code)).toBeNull();
      expect(within(github).getByTestId('connection-dot').getAttribute('data-color')).toBe('teal');
    });

    it("a failed end shows gh's message beside Sign In; a cancelled one shows none", async () => {
      const { end, sockets } = serve({
        state: 'signed_out',
        login: null,
        signingIn: DEVICE_SIGNIN,
      });
      const github = await card();
      await within(github).findByText(DEVICE_SIGNIN.code);
      await waitFor(() => {
        expect(sockets).toHaveLength(1);
      });
      end({
        ok: false,
        login: null,
        message: 'Sign-in timed out',
        cancelled: false,
        now: {},
      });
      expect(await within(github).findByText('Sign-in timed out')).toBeTruthy();
      expect(within(github).getByRole('button', { name: 'Sign In' })).toBeTruthy();
      end({
        ok: false,
        login: null,
        message: 'Sign-in cancelled.',
        cancelled: true,
        now: {},
      });
      await waitFor(() => {
        expect(within(github).queryByText('Sign-in timed out')).toBeNull();
      });
      expect(within(github).queryByText('Sign-in cancelled.')).toBeNull();
    });

    it('Switch Account runs the same sign-in', async () => {
      const { requests } = serve();
      const github = await card();
      fireEvent.click(await within(github).findByRole('button', { name: 'Switch Account' }));
      expect(await within(github).findByText(DEVICE_SIGNIN.code)).toBeTruthy();
      expect(requests).toContain('signin');
    });
  });
});
