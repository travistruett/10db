import {
  AccountDto,
  AccountId,
  AccountConnectDto,
  AccountPatch,
  mintId,
  type AccountPauseDto,
  type AccountUsageDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { accountKeys } from '../../../daemon/account-queries';
import {
  accountDto,
  accountIdentityDto,
  accountPauseDto,
  accountSignInDto,
  accountUsageDto,
  DEFAULT_ACCOUNT,
} from '../../../test/account-fixtures';
import {
  baseHandlers,
  daemonUrl,
  eventStream,
  renderApp,
  renderWithDaemon,
  server,
} from '../../../test/daemon';
import { daemonEvent } from '../../../test/fixtures';
import { AccountDrawer } from './account-drawer';
import { formatMoment } from './account-pause';

interface Served {
  readonly patches: { id: string; body: unknown }[];
  readonly identityCalls: string[];
  readonly archives: string[];
  /** The accounts a Connect was pressed for, and those whose sign-in was cancelled. */
  readonly connects: string[];
  readonly cancels: string[];
  /** Ends the account's browser sign-in on the daemon and tells the open window with an event. */
  readonly endLogin: (id: string, ok: boolean, message: string) => void;
  /** Another window (or an earlier run of this one) holds the daemon's sign-in slot for the account. */
  readonly holdSlot: (id: string) => void;
  /** The daemon restarts: the sign-in it was running is gone, and the event stream drops and reconnects. */
  readonly restartDaemon: () => void;
  /** Changes the account on the daemon and tells the open window with an `account.saved` event. */
  readonly changeRemotely: (id: string, changes: Partial<AccountDto>) => void;
  readonly accountListCalls: number;
  readonly queryClient: ReturnType<typeof renderApp>['queryClient'];
}

function serve(
  accounts: AccountDto[],
  opts: {
    identity?: Record<string, ReturnType<typeof accountIdentityDto>>;
    identityStatus?: { status: number; message: string };
    usage?: Record<string, AccountUsageDto>;
    /** Holds the identity answer until it resolves. */
    identityGate?: Promise<void>;
    patchRefusal?: { status: number; message: string };
    archiveRefusal?: { status: number; message: string };
    connectRefusal?: { status: number; message: string };
    /** Holds the answer to a read of the slot, once a Connect has been pressed, until it resolves. */
    slotGate?: Promise<void>;
    /** Holds the answer to a cancel until it resolves. */
    cancelGate?: Promise<void>;
    /** The page the daemon names for a sign-in; null is an agent that opens the browser itself. */
    connectUrl?: string | null;
    /** The pauses the daemon reports. */
    pauses?: AccountPauseDto[];
  } = {},
): Served {
  const patches: Served['patches'] = [];
  const identityCalls: string[] = [];
  const archives: string[] = [];
  const connects: string[] = [];
  const cancels: string[] = [];
  const sockets: { send(data: string): void }[] = [];
  let accountListCalls = 0;
  /** The account holding the daemon's one sign-in slot. */
  let slot: { accountId: string; label: string } | null = null;
  let seq = 10;
  const labelOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? 'Account';
  const tell = (id: string, data: { ok: boolean; message: string; cancelled: boolean }) => {
    seq += 1;
    sockets.at(-1)?.send(
      JSON.stringify(
        daemonEvent({
          seq,
          type: 'account.login_ended',
          entityType: 'account',
          entityId: id,
          data: { accountId: id, ...data },
        }),
      ),
    );
  };
  const live = [...accounts];
  server.use(
    http.get(daemonUrl('/accounts'), () => {
      accountListCalls += 1;
      return HttpResponse.json(live);
    }),
    http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) =>
      HttpResponse.json(
        opts.usage?.[String(params['accountId'])] ??
          accountUsageDto({ accountId: AccountId.parse(params['accountId']) }),
      ),
    ),
    http.get(daemonUrl('/accounts/pauses'), () => HttpResponse.json(opts.pauses ?? [])),
    http.post(daemonUrl('/accounts/:accountId/resume'), ({ params }) => {
      resumes.push(String(params['accountId']));
      return HttpResponse.json([]);
    }),
    http.get(daemonUrl('/accounts/:accountId/signin'), ({ params }) =>
      HttpResponse.json(accountSignInDto({ accountId: AccountId.parse(params['accountId']) })),
    ),
    http.get(daemonUrl('/accounts/:accountId/identity'), async ({ params }) => {
      const id = String(params['accountId']);
      identityCalls.push(id);
      await opts.identityGate;
      if (opts.identityStatus)
        return HttpResponse.json(
          { message: opts.identityStatus.message },
          { status: opts.identityStatus.status },
        );
      return HttpResponse.json(opts.identity?.[id] ?? accountIdentityDto());
    }),
    http.patch(daemonUrl('/accounts/:accountId'), async ({ params, request }) => {
      const id = String(params['accountId']);
      const body = AccountPatch.parse(await request.json());
      patches.push({ id, body });
      if (opts.patchRefusal)
        return HttpResponse.json(
          { message: opts.patchRefusal.message },
          { status: opts.patchRefusal.status },
        );
      const index = live.findIndex((a) => a.id === id);
      const current = live[index];
      if (!current) return HttpResponse.json({ message: 'no such account' }, { status: 404 });
      const next = AccountDto.parse({ ...current, ...body });
      live[index] = next;
      return HttpResponse.json(next);
    }),
    http.post(daemonUrl('/accounts/:accountId/archive'), ({ params }) => {
      const id = String(params['accountId']);
      archives.push(id);
      if (opts.archiveRefusal)
        return HttpResponse.json(
          { message: opts.archiveRefusal.message },
          { status: opts.archiveRefusal.status },
        );
      const index = live.findIndex((a) => a.id === id);
      const current = live[index];
      if (!current) return HttpResponse.json({ message: 'no such account' }, { status: 404 });
      const next = AccountDto.parse({ ...current, archived: true });
      live[index] = next;
      return HttpResponse.json(next);
    }),
    http.get(daemonUrl('/accounts/connecting'), async () => {
      if (connects.length > 0) await opts.slotGate;
      return HttpResponse.json(slot);
    }),
    http.post(daemonUrl('/accounts/:accountId/connect'), ({ params }) => {
      const id = String(params['accountId']);
      connects.push(id);
      if (opts.connectRefusal)
        return HttpResponse.json(
          { message: opts.connectRefusal.message },
          { status: opts.connectRefusal.status },
        );
      if (slot)
        return HttpResponse.json(
          { message: `Account "${slot.label}" is already connecting` },
          { status: 409 },
        );
      slot = { accountId: id, label: labelOf(id) };
      return HttpResponse.json(
        AccountConnectDto.parse({
          accountId: id,
          authUrl: opts.connectUrl === undefined ? SIGN_IN_URL : opts.connectUrl,
        }),
      );
    }),
    http.delete(daemonUrl('/accounts/:accountId/connect'), async ({ params }) => {
      const id = String(params['accountId']);
      cancels.push(id);
      await opts.cancelGate;
      if (slot?.accountId === id) {
        slot = null;
        // As the daemon does: a cancel the builder asked for ends the sign-in with an event.
        tell(id, { ok: false, message: 'The sign-in was cancelled.', cancelled: true });
      }
      return new HttpResponse(null, { status: 204 });
    }),
    eventStream.addEventListener('connection', ({ client }) => {
      sockets.push(client);
    }),
    ...baseHandlers(),
  );
  const { queryClient } = renderApp('/settings/accounts');
  return {
    patches,
    identityCalls,
    archives,
    connects,
    cancels,
    endLogin: (id, ok, message) => {
      slot = null;
      tell(id, { ok, message, cancelled: false });
    },
    holdSlot: (id) => {
      slot = { accountId: id, label: labelOf(id) };
    },
    restartDaemon: () => {
      slot = null;
      for (const client of eventStream.clients) client.close();
    },
    changeRemotely: (id, changes) => {
      const index = live.findIndex((a) => a.id === id);
      const current = live[index];
      if (!current) return;
      live[index] = AccountDto.parse({ ...current, ...changes });
      sockets
        .at(-1)
        ?.send(
          JSON.stringify(
            daemonEvent({ seq: 1, type: 'account.saved', entityType: 'account', entityId: id }),
          ),
        );
    },
    queryClient,
    get accountListCalls() {
      return accountListCalls;
    },
  };
}

const SIGN_IN_URL = 'https://auth.openai.com/oauth/authorize?state=abc';

/** Opens the Terminal fallback under Connect. */
function openTerminalSteps(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in from Terminal instead' }));
}

async function openDrawer(label: string) {
  const table = await screen.findByRole('table', { name: 'Accounts' });
  fireEvent.click(await within(table).findByRole('button', { name: `Open ${label}` }));
  return screen.findByRole('dialog', { name: (name) => name.startsWith(label) });
}

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

/** The accounts a Resume button was pressed for. */
const resumes: string[] = [];

/** The pop-up the app opens for a sign-in: the page is read from its first argument. */
let openSignIn: MockInstance<typeof window.open>;
let popup: Window;
beforeEach(() => {
  // A window of its own whose opener is set, as a real pop-up's is until the app clears it.
  const frame = document.createElement('iframe');
  document.body.append(frame);
  if (frame.contentWindow === null) throw new Error('the test page has no frame window');
  popup = frame.contentWindow;
  popup.opener = window;
  openSignIn = vi.spyOn(window, 'open').mockReturnValue(popup);
});

afterEach(() => {
  openSignIn.mockRestore();
  resumes.length = 0;
  writeText.mockClear();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('AccountDrawer', () => {
  it('shows the account’s pause with a Resume that lifts a refusal', async () => {
    const pause = accountPauseDto({ accountId: DEFAULT_ACCOUNT.id, reason: 'refused' });
    serve([DEFAULT_ACCOUNT], { pauses: [pause] });
    const dialog = await openDrawer('Claude plan');
    expect(await within(dialog).findByText(/Sessions refused/)).toBeTruthy();
    expect(within(dialog).getByText(new RegExp(`since ${formatMoment(pause.since)}`))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resume Claude plan' }));
    await waitFor(() => {
      expect(resumes).toEqual([DEFAULT_ACCOUNT.id]);
    });
  });

  it('shows a usage-limit pause in the drawer with no Resume', async () => {
    serve([DEFAULT_ACCOUNT], {
      pauses: [accountPauseDto({ reason: 'usage_limit', until: '2026-10-30T23:30:00.000Z' })],
    });
    const dialog = await openDrawer('Claude plan');
    expect(await within(dialog).findByText(/Usage limit reached/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Resume/ })).toBeNull();
  });

  it('shows a subscription’s sign-in command and copies it', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    serve([DEFAULT_ACCOUNT, accountDto({ label: 'Fresh login' })]);
    const dialog = await openDrawer('Fresh login');
    openTerminalSteps(dialog);
    expect(
      await within(dialog).findByText('CLAUDE_CONFIG_DIR=/data/accounts/a/claude claude'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy command' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('CLAUDE_CONFIG_DIR=/data/accounts/a/claude claude');
    });
    expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(within(dialog).getByText(/Sign in as the email this account should use/)).toBeTruthy();
  });

  it('adds a ChatGPT plan account and shows its sign-in command', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const account = accountDto({ label: 'ChatGPT Pro', kind: 'codex_signin' });
    const command = 'CODEX_HOME=/data/accounts/c/codex codex login';
    serve([DEFAULT_ACCOUNT, account]);
    server.use(
      http.get(daemonUrl('/accounts/:accountId/signin'), ({ params }) =>
        HttpResponse.json(
          accountSignInDto({ accountId: AccountId.parse(params['accountId']), command }),
        ),
      ),
    );
    const dialog = await openDrawer('ChatGPT Pro');
    expect(await within(dialog).findByRole('button', { name: 'Connect' })).toBeTruthy();
    // The Terminal steps are a fallback, closed until asked for.
    expect(within(dialog).queryByText(/Sign in as the email this account should use/)).toBeNull();
    expect(within(dialog).queryByText(command)).toBeNull();
    openTerminalSteps(dialog);
    expect(await within(dialog).findByText(command)).toBeTruthy();
    expect(within(dialog).getByText(/Sign-in asks which workspace to use/)).toBeTruthy();
    expect(within(dialog).getByText(/Pick the one whose plan should pay/)).toBeTruthy();
    expect(within(dialog).queryByText(/claude/i)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy command' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(command);
    });
  });

  describe('Connect for an account that signs in with a login', () => {
    const plan = accountDto({ label: 'ChatGPT Pro', kind: 'codex_signin' });
    const other = accountDto({ label: 'Company B', kind: 'codex_signin' });
    const seen = 'me@example.com · ws_123';
    const unconfirmed = accountIdentityDto({
      accountId: plan.id,
      email: 'me@example.com',
      refusal: { problem: 'unconfirmed', message: 'No identity recorded yet.', seenIdentity: seen },
    });
    const connectButton = (dialog: HTMLElement) =>
      within(dialog).findByRole('button', { name: 'Connect' });
    const waitingText = /Waiting for you to sign in/;
    const close = async (dialog: HTMLElement) => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    };

    it('opens the sign-in page, waits, then checks the identity itself so Confirm is next', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan], { identity: { [plan.id]: unconfirmed } });
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(await connectButton(dialog));
      expect(await within(dialog).findByText(waitingText)).toBeTruthy();
      expect(openSignIn).toHaveBeenCalledWith(SIGN_IN_URL, '_blank');
      // The opened page cannot reach back into the app.
      expect(popup.opener).toBeNull();
      expect(served.connects).toEqual([plan.id]);
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
      expect(served.identityCalls).toEqual([]);

      served.endLogin(plan.id, true, 'Signed in.');
      expect(await within(dialog).findByRole('button', { name: 'Confirm' })).toBeTruthy();
      expect(served.identityCalls).toEqual([plan.id]);
      expect(within(dialog).queryByText(waitingText)).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Connect' })).toBeTruthy();
    });

    it('shows why a sign-in failed and offers Connect again, without checking the identity', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan]);
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(await connectButton(dialog));
      await within(dialog).findByText(waitingText);
      served.endLogin(plan.id, false, 'The sign-in took too long. Try Connect again.');
      expect(await within(dialog).findByText(/took too long/)).toBeTruthy();
      expect(within(dialog).getByRole('button', { name: 'Connect' })).toBeTruthy();
      expect(served.identityCalls).toEqual([]);
    });

    it('cancels a waiting sign-in without an error and goes back to Connect', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan]);
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(await connectButton(dialog));
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Cancel' }));
      await waitFor(() => {
        expect(served.cancels).toEqual([plan.id]);
      });
      expect(await connectButton(dialog)).toBeTruthy();
      expect(within(dialog).queryByText(waitingText)).toBeNull();
      // The daemon announced the cancel; the builder asked for it, so nothing is shown as an error.
      expect(within(dialog).queryByRole('alert')).toBeNull();
      expect(within(dialog).queryByText(/cancelled/i)).toBeNull();
    });

    it('shows the daemon’s reason when it refuses, and offers Connect again', async () => {
      serve([DEFAULT_ACCOUNT, plan], {
        connectRefusal: { status: 409, message: 'Account "Plan B" has a session running' },
      });
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(await connectButton(dialog));
      expect(await within(dialog).findByText(/Plan B" has a session running/)).toBeTruthy();
      expect(within(dialog).getByRole('button', { name: 'Connect' })).toBeTruthy();
    });

    it('sends one request for a double click', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan]);
      const dialog = await openDrawer('ChatGPT Pro');
      const button = await connectButton(dialog);
      fireEvent.click(button);
      fireEvent.click(button);
      await within(dialog).findByText(waitingText);
      expect(served.connects).toEqual([plan.id]);
    });

    it('still waits, with Cancel, when the drawer is closed and opened again', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan]);
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(await connectButton(dialog));
      await within(dialog).findByText(waitingText);
      await close(dialog);

      const again = await openDrawer('ChatGPT Pro');
      expect(await within(again).findByText(waitingText)).toBeTruthy();
      expect(within(again).queryByRole('button', { name: 'Connect' })).toBeNull();
      fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => {
        expect(served.cancels).toEqual([plan.id]);
      });
      expect(await connectButton(again)).toBeTruthy();
      expect(openSignIn).toHaveBeenCalledTimes(1);
    });

    it('opens the page even when the drawer is closed before the daemon answers', async () => {
      let answer: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        answer = resolve;
      });
      serve([DEFAULT_ACCOUNT, plan]);
      server.use(
        http.post(daemonUrl('/accounts/:accountId/connect'), async ({ params }) => {
          await held;
          return HttpResponse.json({
            accountId: String(params['accountId']),
            authUrl: SIGN_IN_URL,
          });
        }),
      );
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(await connectButton(dialog));
      await close(dialog);
      answer();
      await waitFor(() => {
        expect(openSignIn).toHaveBeenCalledWith(SIGN_IN_URL, '_blank');
      });
    });

    it('shows the wait when another window already started this account’s sign-in', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan]);
      served.holdSlot(plan.id);
      const dialog = await openDrawer('ChatGPT Pro');
      expect(await within(dialog).findByText(waitingText)).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: 'Connect' })).toBeNull();
      expect(served.connects).toEqual([]);
    });

    it('names the account that is connecting on another account’s drawer, and cancels it from there', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan, other]);
      served.holdSlot(other.id);
      const dialog = await openDrawer('ChatGPT Pro');
      expect(await within(dialog).findByText(/Company B is connecting/)).toBeTruthy();
      expect((await connectButton(dialog)).hasAttribute('disabled')).toBe(true);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel Company B’s sign-in' }));
      await waitFor(() => {
        expect(served.cancels).toEqual([other.id]);
      });
      await waitFor(() => {
        expect(
          within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Connect' }).disabled,
        ).toBe(false);
      });
    });

    it('goes back to Connect when the daemon restarts and the sign-in is gone', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan]);
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(await connectButton(dialog));
      await within(dialog).findByText(waitingText);
      served.restartDaemon();
      await waitFor(
        () => {
          expect(within(dialog).queryByText(waitingText)).toBeNull();
        },
        { timeout: 15_000 },
      );
      expect(await connectButton(dialog)).toBeTruthy();
    });

    it('gives the real reason when the browser does not open, and Connect returns only after the cancel', async () => {
      openSignIn.mockReturnValueOnce(null);
      let finishCancel: () => void = () => undefined;
      const cancelHeld = new Promise<void>((resolve) => {
        finishCancel = resolve;
      });
      const served = serve([DEFAULT_ACCOUNT, plan], { cancelGate: cancelHeld });
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(await connectButton(dialog));
      await waitFor(() => {
        expect(openSignIn).toHaveBeenCalled();
      });
      // While the cancel is in flight the button is busy and no reason is shown yet.
      expect(within(dialog).queryByText(/browser did not open/)).toBeNull();
      expect(
        within(dialog).getByRole('button', { name: 'Connect' }).hasAttribute('data-loading'),
      ).toBe(true);
      finishCancel();
      expect(await within(dialog).findByText(/browser did not open/)).toBeTruthy();
      expect(within(dialog).queryByText(/cancelled/i)).toBeNull();
      expect(within(dialog).queryByText(waitingText)).toBeNull();
      expect(served.connects).toEqual([plan.id]);
      expect(
        within(dialog).getByRole('button', { name: 'Connect' }).hasAttribute('data-loading'),
      ).toBe(false);
    });

    it('asks for a confirming click before it replaces the login 10db already uses', async () => {
      const served = serve([DEFAULT_ACCOUNT]);
      const dialog = await openDrawer('Claude plan');
      fireEvent.click(await connectButton(dialog));
      expect(await within(dialog).findByText(/login 10db already uses/)).toBeTruthy();
      // It is also the builder’s own Claude Code login.
      expect(within(dialog).getByText(/your own Claude Code login/)).toBeTruthy();
      expect(served.connects).toEqual([]);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
      expect(within(dialog).queryByText(/login 10db already uses/)).toBeNull();
      fireEvent.click(await connectButton(dialog));
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Replace this login' }));
      await within(dialog).findByText(waitingText);
      expect(served.connects).toEqual([DEFAULT_ACCOUNT.id]);
    });

    it('takes Connect away from an account that is archived while its drawer is open', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan]);
      const dialog = await openDrawer('ChatGPT Pro');
      expect(await connectButton(dialog)).toBeTruthy();
      served.changeRemotely(plan.id, { archived: true });
      await waitFor(() => {
        expect(within(dialog).queryByRole('button', { name: 'Connect' })).toBeNull();
      });
      expect(
        within(dialog).queryByRole('button', { name: 'Sign in from Terminal instead' }),
      ).toBeNull();
    });

    it('connects a Claude subscription, which opens its own browser: no page is opened, and the identity is checked at the end', async () => {
      const claude = accountDto({ label: 'Fresh login' });
      const served = serve([DEFAULT_ACCOUNT, claude], {
        connectUrl: null,
        identity: { [claude.id]: accountIdentityDto({ accountId: claude.id }) },
      });
      const dialog = await openDrawer('Fresh login');
      fireEvent.click(await connectButton(dialog));
      expect(await within(dialog).findByText(waitingText)).toBeTruthy();
      expect(openSignIn).not.toHaveBeenCalled();
      served.endLogin(claude.id, true, 'Signed in.');
      await waitFor(() => {
        expect(served.identityCalls).toEqual([claude.id]);
      });
      // The Terminal command stays as a fallback.
      expect(
        within(dialog).getByRole('button', { name: 'Sign in from Terminal instead' }),
      ).toBeTruthy();
    });

    it('leaves the confirmation and Connect usable when the sign-in ends before Connect has settled', async () => {
      let release: () => void = () => undefined;
      const slotGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const served = serve([DEFAULT_ACCOUNT], { slotGate });
      const dialog = await openDrawer('Claude plan');
      fireEvent.click(await connectButton(dialog));
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Replace this login' }));
      await waitFor(() => {
        expect(served.connects).toEqual([DEFAULT_ACCOUNT.id]);
      });
      // The sign-in ends while Connect is still reading the slot.
      served.endLogin(DEFAULT_ACCOUNT.id, true, 'Signed in.');
      await waitFor(() => {
        expect(served.identityCalls).toEqual([DEFAULT_ACCOUNT.id]);
      });
      release();
      expect(await connectButton(dialog)).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: 'Replace this login' })).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
      expect(
        await within(dialog).findByRole('button', { name: 'Replace this login' }),
      ).toBeTruthy();
    });

    it('does not keep a refusal from Connect beside Confirm once another sign-in succeeds', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan], {
        identity: { [plan.id]: unconfirmed },
        connectRefusal: { status: 409, message: 'Account "Plan B" is already connecting' },
      });
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(await connectButton(dialog));
      expect(await within(dialog).findByText(/Plan B" is already connecting/)).toBeTruthy();
      served.endLogin(plan.id, true, 'Signed in.');
      expect(await within(dialog).findByRole('button', { name: 'Confirm' })).toBeTruthy();
      expect(within(dialog).queryByText(/already connecting/)).toBeNull();
    });

    it('does not bring a failed Cancel back in the next sign-in', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan]);
      server.use(
        http.delete(
          daemonUrl('/accounts/:accountId/connect'),
          () => HttpResponse.json({ message: 'Could not stop the sign-in' }, { status: 500 }),
          { once: true },
        ),
      );
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(await connectButton(dialog));
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Cancel' }));
      expect(await within(dialog).findByText(/Could not stop the sign-in/)).toBeTruthy();
      served.endLogin(plan.id, false, 'The sign-in took too long. Try Connect again.');
      fireEvent.click(await connectButton(dialog));
      await within(dialog).findByText(waitingText);
      expect(within(dialog).queryByText(/Could not stop the sign-in/)).toBeNull();
    });

    it('shows a failed Cancel on the drawer of another account', async () => {
      const served = serve([DEFAULT_ACCOUNT, plan, other]);
      served.holdSlot(other.id);
      server.use(
        http.delete(daemonUrl('/accounts/:accountId/connect'), () =>
          HttpResponse.json({ message: 'Could not stop Company B' }, { status: 500 }),
        ),
      );
      const dialog = await openDrawer('ChatGPT Pro');
      fireEvent.click(
        await within(dialog).findByRole('button', { name: 'Cancel Company B’s sign-in' }),
      );
      expect(await within(dialog).findByText(/Could not stop Company B/)).toBeTruthy();
    });

    it('offers no Connect to a keyed account', async () => {
      const keyed = accountDto({ label: 'Direct API', kind: 'anthropic_api_key', configDir: null });
      serve([DEFAULT_ACCOUNT, keyed]);
      const dialog = await openDrawer('Direct API');
      expect(await within(dialog).findByRole('button', { name: 'Check' })).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: 'Connect' })).toBeNull();
    });
  });

  it('offers Confirm for the email and workspace the probe saw', async () => {
    const account = accountDto({ label: 'ChatGPT Pro', kind: 'codex_signin' });
    const seen = 'me@example.com · ws_123';
    const served = serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: 'me@example.com',
          refusal: {
            problem: 'unconfirmed',
            message: 'ChatGPT Pro has no identity recorded yet.',
            seenIdentity: seen,
          },
        }),
      },
    });
    const dialog = await openDrawer('ChatGPT Pro');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    const confirm = await within(dialog).findByRole('button', { name: 'Confirm' });
    expect(within(dialog).getByText(`Sessions on this account will run as ${seen}.`)).toBeTruthy();
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { expectedIdentity: seen } }]);
    });
  });

  it('names a Codex account’s workspace, not an organization', async () => {
    const account = accountDto({
      label: 'ChatGPT Pro',
      kind: 'codex_signin',
      expectedIdentity: 'me@example.com · ws_123',
    });
    serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: 'me@example.com',
          organization: 'ws_123',
        }),
      },
    });
    const dialog = await openDrawer('ChatGPT Pro');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(await within(dialog).findByText('Workspace: ws_123')).toBeTruthy();
  });

  it('lists the models the account offers', async () => {
    const account = accountDto({
      label: 'ChatGPT Pro',
      kind: 'codex_signin',
      expectedIdentity: 'me@example.com · ws_123',
    });
    serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: 'me@example.com',
          models: ['gpt-5.5', 'gpt-5.5-mini'],
        }),
      },
    });
    const dialog = await openDrawer('ChatGPT Pro');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(await within(dialog).findByText('gpt-5.5')).toBeTruthy();
    expect(within(dialog).getByText('gpt-5.5-mini')).toBeTruthy();
  });

  it('lists no models when the account offers none', async () => {
    serve([DEFAULT_ACCOUNT]);
    const dialog = await openDrawer('Claude plan');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    await within(dialog).findByText('Signed in as builder@example.com');
    expect(within(dialog).queryByText(/Models/)).toBeNull();
  });

  it('says the default account’s login is the one 10db already uses', async () => {
    serve([DEFAULT_ACCOUNT]);
    const dialog = await openDrawer('Claude plan');
    openTerminalSteps(dialog);
    expect(await within(dialog).findByText(/login 10db already uses/)).toBeTruthy();
  });

  it('does not ask for the identity until Check sign-in is clicked', async () => {
    const served = serve([DEFAULT_ACCOUNT, accountDto({ label: 'Fresh login' })]);
    const dialog = await openDrawer('Fresh login');
    expect(await within(dialog).findByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(await within(dialog).findByText('No sessions this month')).toBeTruthy();
    const before = served.accountListCalls;
    await served.queryClient.invalidateQueries({ queryKey: accountKeys.all });
    expect(served.accountListCalls).toBeGreaterThan(before);
    expect(served.identityCalls).toEqual([]);
  });

  it('confirms exactly the email the probe saw', async () => {
    const account = accountDto({ label: 'Fresh login' });
    const served = serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: 'client@example.com',
          refusal: {
            problem: 'unconfirmed',
            message: 'Fresh login has no identity recorded yet.',
            seenIdentity: 'client@example.com',
          },
        }),
      },
    });
    const dialog = await openDrawer('Fresh login');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(
      await within(dialog).findByText('Fresh login has no identity recorded yet.'),
    ).toBeTruthy();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(served.patches).toEqual([
        { id: account.id, body: { expectedIdentity: 'client@example.com' } },
      ]);
    });
    await waitFor(() => {
      expect(within(dialog).queryByRole('button', { name: 'Confirm' })).toBeNull();
    });
    expect(within(dialog).queryByText('Fresh login has no identity recorded yet.')).toBeNull();
    expect(await screen.findByText('client@example.com')).toBeTruthy();
  });

  it('warns that a different recorded identity will be replaced', async () => {
    const account = accountDto({ label: 'Switched', expectedIdentity: 'old@example.com' });
    const served = serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: 'new@example.com',
          refusal: {
            problem: 'identity_mismatch',
            message: 'Switched is signed in as a different login.',
            seenIdentity: 'new@example.com',
          },
        }),
      },
    });
    const dialog = await openDrawer('Switched');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(
      await within(dialog).findByText('Switched is signed in as a different login.'),
    ).toBeTruthy();
    expect(
      within(dialog).getByText('Sessions on this account will run as new@example.com from now on.'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(served.patches).toEqual([
        { id: account.id, body: { expectedIdentity: 'new@example.com' } },
      ]);
    });
  });

  it('shows a matching identity without offering Confirm', async () => {
    serve([DEFAULT_ACCOUNT]);
    const dialog = await openDrawer('Claude plan');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(await within(dialog).findByText('Signed in as builder@example.com')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('offers Require for an API key that reports an organization', async () => {
    const account = accountDto({ label: 'Client key', kind: 'anthropic_api_key', secretSet: true });
    const served = serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: null,
          organization: 'Acme',
          subscription: false,
        }),
      },
    });
    const dialog = await openDrawer('Client key');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Require' }));
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { expectedIdentity: 'Acme' } }]);
    });
  });

  it('shows a gateway’s organization but never offers Require', async () => {
    const account = accountDto({
      label: 'Router',
      kind: 'gateway',
      secretSet: true,
      settings: { baseUrl: 'https://gateway.example.com' },
    });
    serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: null,
          organization: 'Acme',
          subscription: false,
        }),
      },
    });
    const dialog = await openDrawer('Router');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check' }));
    expect(await within(dialog).findByText('Organization: Acme')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Require' })).toBeNull();
  });

  it('does not carry one account’s check over to another', async () => {
    const a = accountDto({ label: 'Account A' });
    const b = accountDto({ label: 'Account B', id: mintId('Account') });
    serve([DEFAULT_ACCOUNT, a, b], {
      identity: {
        [a.id]: accountIdentityDto({
          accountId: a.id,
          email: 'a@example.com',
          refusal: {
            problem: 'unconfirmed',
            message: 'No identity recorded yet.',
            seenIdentity: 'a@example.com',
          },
        }),
        [b.id]: accountIdentityDto({
          accountId: b.id,
          email: 'b@example.com',
          refusal: {
            problem: 'unconfirmed',
            message: 'No identity recorded yet.',
            seenIdentity: 'b@example.com',
          },
        }),
      },
    });
    const dialogA = await openDrawer('Account A');
    fireEvent.click(await within(dialogA).findByRole('button', { name: 'Check sign-in' }));
    expect(await within(dialogA).findByRole('button', { name: 'Confirm' })).toBeTruthy();
    fireEvent.click(within(dialogA).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const dialogB = await openDrawer('Account B');
    await within(dialogB).findByRole('button', { name: 'Check sign-in' });
    expect(within(dialogB).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(within(dialogB).queryByText(/a@example.com/)).toBeNull();
    fireEvent.click(within(dialogB).getByRole('button', { name: 'Check sign-in' }));
    expect(await within(dialogB).findByRole('button', { name: 'Confirm' })).toBeTruthy();
  });

  it('shows the daemon’s message when the probe is refused', async () => {
    serve([DEFAULT_ACCOUNT, accountDto({ label: 'Busy' })], {
      identityStatus: { status: 409, message: 'Another sign-in check is already running.' },
    });
    const dialog = await openDrawer('Busy');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(
      await within(dialog).findByText('Another sign-in check is already running.'),
    ).toBeTruthy();
  });

  it('lists usage by project, with no dollar column for a subscription', async () => {
    const account = accountDto({ label: 'Fresh login' });
    serve([DEFAULT_ACCOUNT, account], {
      usage: {
        [account.id]: accountUsageDto({
          accountId: account.id,
          total: { tokensIn: 3000, tokensOut: 1500, tokensCached: 500, costUsd: null },
          byProject: [
            {
              projectId: mintId('Project'),
              projectName: 'Alpha',
              tokensIn: 2000,
              tokensOut: 1000,
              tokensCached: 300,
              costUsd: null,
            },
          ],
        }),
      },
    });
    const dialog = await openDrawer('Fresh login');
    const table = await within(dialog).findByRole('table', { name: 'Usage by project' });
    expect(within(dialog).getByText('October 2026')).toBeTruthy();
    expect(within(table).getByText('Alpha')).toBeTruthy();
    expect(within(table).getByText('2K')).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Cost' })).toBeNull();
    expect(within(table).queryByText(/\$/)).toBeNull();
  });

  it('shows dollars per project for a metered account and says when there are no sessions', async () => {
    const metered = accountDto({ label: 'Metered', kind: 'anthropic_api_key', secretSet: true });
    serve([DEFAULT_ACCOUNT, metered], {
      usage: {
        [metered.id]: accountUsageDto({
          accountId: metered.id,
          total: { tokensIn: 10, tokensOut: 5, tokensCached: 0, costUsd: 12.5 },
          byProject: [
            {
              projectId: mintId('Project'),
              projectName: 'Beta',
              tokensIn: 10,
              tokensOut: 5,
              tokensCached: 0,
              costUsd: 12.5,
            },
          ],
        }),
      },
    });
    const dialog = await openDrawer('Metered');
    const table = await within(dialog).findByRole('table', { name: 'Usage by project' });
    expect(within(table).getByRole('columnheader', { name: 'Cost' })).toBeTruthy();
    expect(within(table).getByText('$12.50')).toBeTruthy();
  });

  it('says there were no sessions when the month is empty', async () => {
    serve([DEFAULT_ACCOUNT]);
    const dialog = await openDrawer('Claude plan');
    expect(await within(dialog).findByText('No sessions this month')).toBeTruthy();
  });

  it.each([
    { problem: 'wrong_credentials', message: 'Wrong credentials.' },
    { problem: 'signed_out', message: 'Signed out.' },
  ] as const)(
    'offers no Confirm for a $problem refusal even with an email',
    async ({ problem, message }) => {
      const account = accountDto({ label: 'Refused' });
      serve([DEFAULT_ACCOUNT, account], {
        identity: {
          [account.id]: accountIdentityDto({
            accountId: account.id,
            email: 'someone@example.com',
            refusal: { problem, message, seenIdentity: 'someone@example.com' },
          }),
        },
      });
      const dialog = await openDrawer('Refused');
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
      expect(await within(dialog).findByText(message)).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: 'Confirm' })).toBeNull();
    },
  );

  it('treats a recorded identity that differs only in case as matching', async () => {
    const account = accountDto({ label: 'Cased', expectedIdentity: 'Builder@Example.com' });
    serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({ accountId: account.id, email: 'builder@example.com' }),
      },
    });
    const dialog = await openDrawer('Cased');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(await within(dialog).findByText('Signed in as builder@example.com')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(within(dialog).queryByText(/will run as/)).toBeNull();
  });

  it('offers Require for a Bedrock account that reports an organization', async () => {
    const account = accountDto({ label: 'Cloud', kind: 'bedrock', secretSet: true });
    const served = serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: null,
          organization: 'Acme',
          subscription: false,
        }),
      },
    });
    const dialog = await openDrawer('Cloud');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Require' }));
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { expectedIdentity: 'Acme' } }]);
    });
  });

  it('says Claude Code is starting while the probe is in flight', async () => {
    let release: () => void = () => undefined;
    const identityGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve([DEFAULT_ACCOUNT, accountDto({ label: 'Slow' })], { identityGate });
    const dialog = await openDrawer('Slow');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(
      await within(dialog).findByText('Starting Claude Code to read the account…'),
    ).toBeTruthy();
    release();
    await waitFor(() => {
      expect(within(dialog).queryByText('Starting Claude Code to read the account…')).toBeNull();
    });
  });

  it.each([
    {
      name: 'the Close button',
      close: (dialog: HTMLElement) => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      },
    },
    {
      name: 'Escape',
      close: (dialog: HTMLElement) => {
        fireEvent.keyDown(dialog, { key: 'Escape' });
      },
    },
  ])('returns focus to the row’s open button after $name', async ({ close }) => {
    serve([DEFAULT_ACCOUNT]);
    const table = await screen.findByRole('table', { name: 'Accounts' });
    const opener = await within(table).findByRole('button', { name: 'Open Claude plan' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    close(dialog);
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('saves exactly the fields that changed and the row shows the new label', async () => {
    const account = accountDto({ label: 'Fresh login' });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Fresh login');
    const save = await within(dialog).findByRole('button', { name: 'Save Changes' });
    expect(save).toHaveProperty('disabled', true);
    expect(within(dialog).getByDisplayValue('Claude subscription')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Label' }), {
      target: { value: 'Renamed' },
    });
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { label: 'Renamed' } }]);
    });
    expect(await screen.findByRole('button', { name: 'Open Renamed', hidden: true })).toBeTruthy();
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Save Changes' })).toHaveProperty(
        'disabled',
        true,
      );
    });
  });

  it('shows the plain-word message for an invalid field without sending anything', async () => {
    const served = serve([DEFAULT_ACCOUNT, accountDto({ label: 'Fresh login' })]);
    const dialog = await openDrawer('Fresh login');
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Label' }), {
      target: { value: '' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    expect(await within(dialog).findByText('Enter a label')).toBeTruthy();
    expect(served.patches).toEqual([]);
  });

  it('shows the daemon’s message when a patch is refused', async () => {
    serve([DEFAULT_ACCOUNT, accountDto({ label: 'Fresh login' })], {
      patchRefusal: { status: 409, message: 'An account labelled "Taken" already exists' },
    });
    const dialog = await openDrawer('Fresh login');
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Label' }), {
      target: { value: 'Taken' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    expect(
      await within(dialog).findByText('An account labelled "Taken" already exists'),
    ).toBeTruthy();
  });

  it('clears a monthly cap by sending null', async () => {
    const account = accountDto({
      label: 'Metered',
      kind: 'anthropic_api_key',
      secretSet: true,
      monthlyCapUsd: 500,
    });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Metered');
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Monthly cap (USD)' }), {
      target: { value: '' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { monthlyCapUsd: null } }]);
    });
  });

  it('says what switching a Bedrock account to a profile does to the stored token', async () => {
    const account = accountDto({
      label: 'Cloud',
      kind: 'bedrock',
      secretSet: true,
      settings: { region: 'us-west-2', awsProfile: null },
    });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Cloud');
    expect(
      await within(dialog).findByText(/forgets any stored bearer token.*pasted again/),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('textbox', { name: 'Organization' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'AWS profile' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'AWS profile' }), {
      target: { value: 'client-b' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(served.patches).toEqual([
        { id: account.id, body: { settings: { region: 'us-west-2', awsProfile: 'client-b' } } },
      ]);
    });
  });

  it('takes a remote change into a clean form, so Save stays off', async () => {
    const account = accountDto({ label: 'Fresh login' });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Fresh login');
    const lanes = await within(dialog).findByRole('textbox', { name: 'Lane cap' });
    expect(lanes).toHaveProperty('value', '4');
    served.changeRemotely(account.id, { laneCap: 8 });
    await waitFor(() => {
      expect(within(dialog).getByRole('textbox', { name: 'Lane cap' })).toHaveProperty(
        'value',
        '8',
      );
    });
    expect(within(dialog).getByRole('button', { name: 'Save Changes' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('keeps the builder’s edits and takes the rest of a remote change', async () => {
    const account = accountDto({ label: 'Fresh login' });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Fresh login');
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Label' }), {
      target: { value: 'Mid edit' },
    });
    served.changeRemotely(account.id, { laneCap: 8 });
    await waitFor(() => {
      expect(within(dialog).getByRole('textbox', { name: 'Lane cap' })).toHaveProperty(
        'value',
        '8',
      );
    });
    expect(within(dialog).getByRole('textbox', { name: 'Label' })).toHaveProperty(
      'value',
      'Mid edit',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { label: 'Mid edit' } }]);
    });
  });

  it('archives after a confirmation and closes the drawer', async () => {
    const account = accountDto({ label: 'Old client' });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Old client');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive Account' }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive Old client?' });
    expect(
      within(confirm).getByText(
        "Old client stops taking projects. Archived accounts can't be restored.",
      ),
    ).toBeTruthy();
    expect(served.archives).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive Account' }));
    await waitFor(() => {
      expect(served.archives).toEqual([account.id]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add Account' }));
    });
  });

  it('closes only the confirmation on Escape, keeping the drawer and sending nothing', async () => {
    const account = accountDto({ label: 'Old client' });
    const archives: string[] = [];
    const onClose = vi.fn();
    server.use(
      http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT, account])),
      http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) =>
        HttpResponse.json(accountUsageDto({ accountId: AccountId.parse(params['accountId']) })),
      ),
      http.post(daemonUrl('/accounts/:accountId/archive'), ({ params }) => {
        archives.push(String(params['accountId']));
        return new HttpResponse(null, { status: 500 });
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<AccountDrawer accountId={account.id} opened onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: /Old client/ });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive Account' }));
    await screen.findByRole('dialog', { name: 'Archive Old client?' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Archive Old client?' })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(archives).toEqual([]);
  });

  it('forgets an open confirmation when its account is archived elsewhere', async () => {
    const first = accountDto({ label: 'First client' });
    const second = accountDto({ label: 'Second client' });
    const served = serve([DEFAULT_ACCOUNT, first, second]);
    const dialog = await openDrawer('First client');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive Account' }));
    await screen.findByRole('dialog', { name: 'Archive First client?' });
    served.changeRemotely(first.id, { archived: true });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Archive First client?' })).toBeNull();
    });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /First client/ })).toBeNull();
    });
    const next = await openDrawer('Second client');
    expect(within(next).getByRole('button', { name: 'Archive Account' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Archive Second client?' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Second client/ })).toBeNull();
    });
  });

  it('shows the daemon’s reason when an archive is refused, and keeps the drawer open', async () => {
    const account = accountDto({ label: 'In use' });
    serve([DEFAULT_ACCOUNT, account], {
      archiveRefusal: { status: 409, message: 'Move "Demo" to another account before archiving' },
    });
    const dialog = await openDrawer('In use');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive Account' }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive In use?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive Account' }));
    expect(
      await within(confirm).findByText('Move "Demo" to another account before archiving'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: (n) => n.startsWith('In use') })).toBeTruthy();
  });

  it('offers no Archive for the default account and says why', async () => {
    serve([DEFAULT_ACCOUNT]);
    const dialog = await openDrawer('Claude plan');
    expect(await within(dialog).findByText("The default account can't be archived.")).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Archive Account' })).toBeNull();
  });
});
