import { PersonInput, type PersonDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { benchmarkStatusDto } from '../../../test/benchmark-fixtures';
import { pickOption } from '../../../test/combobox';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import {
  personDto,
  slackConnection,
  slackContact,
  slackMember,
} from '../../../test/people-fixtures';
import { SLACK_MANIFEST } from './slack-manifest';

const connected = { state: 'connected', teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT' };
const unbound = personDto({ name: 'You', handle: 'me', isBuilder: true });
const bound = personDto({
  name: 'Mark Ellis',
  handle: 'me',
  isBuilder: true,
  slack: slackContact('U1'),
});

function serve(
  options: {
    readonly people?: PersonDto[];
    readonly connection?: Record<string, unknown>;
    readonly tokenRefusal?: string;
    readonly path?: string;
  } = {},
) {
  let people = options.people ?? [unbound];
  let connection = slackConnection({ state: 'none', ...options.connection });
  const saved: unknown[] = [];
  const tokens: string[] = [];
  const removals: string[] = [];
  server.use(
    http.get(daemonUrl('/people'), () => HttpResponse.json(people)),
    http.get(daemonUrl('/slack'), () => HttpResponse.json(connection)),
    http.get(daemonUrl('/benchmarks/status'), () => HttpResponse.json(benchmarkStatusDto())),
    http.get(daemonUrl('/slack/members'), () =>
      HttpResponse.json([
        slackMember(),
        slackMember({ userId: 'U2', name: 'ana', realName: 'Ana Ortiz', title: 'Design' }),
      ]),
    ),
    http.put(daemonUrl('/slack/token'), async ({ request }) => {
      tokens.push(z.object({ token: z.string() }).parse(await request.json()).token);
      if (options.tokenRefusal !== undefined)
        return HttpResponse.json(
          { error: 'invalid', message: options.tokenRefusal },
          { status: 400 },
        );
      connection = slackConnection(connected);
      return HttpResponse.json(connection);
    }),
    http.delete(daemonUrl('/slack/token'), () => {
      removals.push('token');
      connection = slackConnection({ state: 'none' });
      return HttpResponse.json(connection);
    }),
    http.put(daemonUrl('/people/:personId'), async ({ request, params }) => {
      const input = PersonInput.parse(await request.json());
      saved.push(input);
      people = people.map((p) =>
        p.id === params['personId']
          ? {
              ...p,
              name: input.name,
              slack: input.slack ? slackContact(input.slack.userId, input.slack) : null,
            }
          : p,
      );
      return HttpResponse.json(people.find((p) => p.id === params['personId']));
    }),
    ...baseHandlers(),
  );
  const { queryClient } = renderApp(options.path ?? '/settings/integrations');
  return { saved, tokens, removals, queryClient };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings › Integrations: Slack', () => {
  it('lays out the card: what it is for, and what stops without it', async () => {
    serve();
    const slack = within(await screen.findByRole('group', { name: 'Slack' }));
    expect(
      slack.getByText('Asks the people who answer your questions, and reads their replies.'),
    ).toBeTruthy();
    expect(
      slack.getByText(
        'Without it: Questions for other people stay in your Inbox; nothing is sent.',
      ),
    ).toBeTruthy();
  });

  it.each([
    ['not connected', { state: 'none' }, 'Not connected'],
    ['refused', { state: 'refused' }, 'Token refused'],
    ['unreachable', { state: 'unreachable' }, "Can't be reached"],
  ])('says in the header that Slack is %s', async (_name, connection, label) => {
    serve({ connection });
    const slack = within(await screen.findByRole('group', { name: 'Slack' }));
    expect(await slack.findByText(label)).toBeTruthy();
  });

  it('started with TENDB_SLACK=off, says so and offers no setup', async () => {
    serve({ connection: { state: 'off' } });
    const slack = within(await screen.findByRole('group', { name: 'Slack' }));
    expect(await slack.findByText('Off: 10db was started with TENDB_SLACK=off')).toBeTruthy();
    expect(slack.queryByLabelText('Bot User OAuth Token')).toBeNull();
    expect(slack.queryByRole('button')).toBeNull();
  });

  it("a link with ?focus=slack moves keyboard focus to the card's first control", async () => {
    serve({ path: '/settings/integrations?focus=slack' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy Manifest' }));
    });
  });

  it('not connected shows the three steps, and Copy Manifest copies the manifest', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    serve();
    await screen.findByText(/Paste the Bot User OAuth Token/);
    expect(screen.getByRole('link', { name: /Open Slack Apps/ }).getAttribute('href')).toBe(
      'https://api.slack.com/apps',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy Manifest' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(SLACK_MANIFEST);
    });
  });

  it('Connect needs nothing but a token while Slack is not connected', async () => {
    serve();
    fireEvent.change(await screen.findByLabelText('Bot User OAuth Token'), {
      target: { value: 'xoxb-abc' },
    });
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', false);
  });

  it("a refused token shows Slack's reason beside Connect and reads as not connected", async () => {
    const { tokens } = serve({ tokenRefusal: 'Slack refused the token: invalid_auth' });
    fireEvent.change(await screen.findByLabelText('Bot User OAuth Token'), {
      target: { value: 'xoxb-abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/Slack refused the token: invalid_auth/)).toBeTruthy();
    expect(tokens).toEqual(['xoxb-abc']);
    expect(screen.queryByText(/posts as @10db/)).toBeNull();
  });

  it.each([
    ['accepted', {}],
    ['refused', { tokenRefusal: 'Slack refused the token: invalid_auth' }],
  ])(
    'keeps no trace of the token in query state once Connect settles: %s',
    async (_name, options) => {
      const { queryClient } = serve(options);
      const field = await screen.findByLabelText('Bot User OAuth Token');
      fireEvent.change(field, { target: { value: 'xoxb-secret-token' } });
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      await waitFor(() => {
        expect(
          screen.queryByText(/posts as @10db/) ?? screen.queryByText(/Slack refused the token/),
        ).toBeTruthy();
      });
      await waitFor(() => {
        const held = queryClient
          .getMutationCache()
          .getAll()
          .map((m) => JSON.stringify(m.state.variables ?? null));
        expect(held.join('')).not.toContain('xoxb-secret-token');
      });
      // A refused token stays in the field to fix; an accepted one is gone with the field.
      if ('tokenRefusal' in options)
        expect(screen.getByLabelText('Bot User OAuth Token')).toHaveProperty(
          'value',
          'xoxb-secret-token',
        );
    },
  );

  it('connected is one line, with Disconnect in the menu rather than a button', async () => {
    serve({ people: [bound], connection: connected });
    expect(await screen.findByText("Acme · posts as @10db · you're @mark")).toBeTruthy();
    expect(screen.queryByLabelText('Bot User OAuth Token')).toBeNull();
    expect(screen.queryByText('Which one is you?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Slack options' }));
    expect(await screen.findByRole('menuitem', { name: 'Disconnect', hidden: true })).toBeTruthy();
  });

  it('connected, with the builder not yet picked, asks to finish setup', async () => {
    serve({ connection: connected });
    expect(await screen.findByText(/Finish setup: pick yourself/)).toBeTruthy();
    expect(screen.getByRole('button', { name: "That's Me" })).toHaveProperty('disabled', true);
  });

  it("picking saves the builder's Slack contact and takes the name from the member", async () => {
    const { saved } = serve({ connection: connected });
    await screen.findByText(/Finish setup/);
    await pickOption(
      screen.getByLabelText('Which one is you?', { selector: 'input' }),
      /Mark Ellis/,
    );
    fireEvent.click(screen.getByRole('button', { name: "That's Me" }));
    await waitFor(() => {
      expect(saved).toEqual([
        {
          handle: 'me',
          name: 'Mark Ellis',
          slack: { teamId: 'T1', userId: 'U1', sendMode: 'review', dailyLimit: 10 },
        },
      ]);
    });
    expect(await screen.findByText("Acme · posts as @10db · you're @mark")).toBeTruthy();
    expect(screen.queryByText(/Finish setup/)).toBeNull();
  });

  it('Change Who You Are in the menu picks again, and Cancel puts the line back', async () => {
    const { saved } = serve({ people: [bound], connection: connected });
    fireEvent.click(await screen.findByRole('button', { name: 'Slack options' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Change Who You Are', hidden: true }),
    );
    expect(screen.queryByText(/Finish setup/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Which one is you?')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Slack options' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Change Who You Are', hidden: true }),
    );
    await pickOption(
      screen.getByLabelText('Which one is you?', { selector: 'input' }),
      /Ana Ortiz/,
    );
    fireEvent.click(screen.getByRole('button', { name: "That's Me" }));
    await waitFor(() => {
      expect(saved).toEqual([
        {
          handle: 'me',
          name: 'Ana Ortiz',
          slack: { teamId: 'T1', userId: 'U2', sendMode: 'review', dailyLimit: 10 },
        },
      ]);
    });
  });

  it('Disconnect asks first: Cancel keeps Slack, Disconnect removes the token', async () => {
    const { removals } = serve({ people: [bound], connection: connected });
    fireEvent.click(await screen.findByRole('button', { name: 'Slack options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Disconnect', hidden: true }));
    const ask = await screen.findByRole('dialog', { name: 'Disconnect Slack?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(removals).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Slack options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Disconnect', hidden: true }));
    const again = await screen.findByRole('dialog', { name: 'Disconnect Slack?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => {
      expect(removals).toEqual(['token']);
    });
    expect(await screen.findByText(/Paste the Bot User OAuth Token/)).toBeTruthy();
  });
});
