import { PersonInput, type PersonDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pickOption } from '../../../test/combobox';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import {
  BUILDER_PERSON,
  personDto,
  slackConnection,
  slackContact,
  slackMember,
} from '../../../test/people-fixtures';
import { SLACK_MANIFEST } from './slack-manifest';

interface Options {
  readonly people?: PersonDto[];
  readonly connection?: Record<string, unknown>;
  readonly tokenRefusal?: string;
  readonly removeRefusal?: string;
}

function serve(options: Options = {}) {
  let people = options.people ?? [BUILDER_PERSON];
  const saved: unknown[] = [];
  const tokens: string[] = [];
  let connection = slackConnection(options.connection);
  server.use(
    http.get(daemonUrl('/people'), () => HttpResponse.json(people)),
    http.get(daemonUrl('/slack'), () => HttpResponse.json(connection)),
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
      connection = slackConnection({
        state: 'connected',
        teamId: 'T1',
        teamName: 'Acme',
        botUserId: 'UBOT',
      });
      return HttpResponse.json(connection);
    }),
    http.post(daemonUrl('/people'), async ({ request }) => {
      const input = PersonInput.parse(await request.json());
      saved.push(input);
      const created = personDto({
        name: input.name,
        handle: input.handle,
        slack: input.slack ? slackContact(input.slack.userId, input.slack) : null,
      });
      people = [...people, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.put(daemonUrl('/people/:personId'), async ({ request, params }) => {
      const input = PersonInput.parse(await request.json());
      saved.push(input);
      people = people.map((p) => (p.id === params['personId'] ? { ...p, name: input.name } : p));
      return HttpResponse.json(people.find((p) => p.id === params['personId']));
    }),
    http.delete(daemonUrl('/people/:personId'), ({ params }) => {
      if (options.removeRefusal !== undefined)
        return HttpResponse.json(
          { error: 'conflict', message: options.removeRefusal },
          { status: 409 },
        );
      people = people.filter((p) => p.id !== params['personId']);
      return HttpResponse.json({});
    }),
    ...baseHandlers(),
  );
  renderApp('/settings/people');
  return { saved, tokens };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings › People: the Slack connection', () => {
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

  it("a refused token shows Slack's reason beside Connect and reads as not connected", async () => {
    const { tokens } = serve({ tokenRefusal: 'Slack refused the token: invalid_auth' });
    fireEvent.change(await screen.findByLabelText('Bot User OAuth Token'), {
      target: { value: 'xoxb-abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/Slack refused the token: invalid_auth/)).toBeTruthy();
    expect(tokens).toEqual(['xoxb-abc']);
    expect(screen.queryByText(/Connected to/)).toBeNull();
  });

  it('connected shows the workspace and the bot', async () => {
    serve({
      connection: {
        state: 'connected',
        teamId: 'T1',
        teamName: 'Acme',
        botUserId: 'UBOT',
        checkedAt: '2026-10-13T12:00:00.000Z',
      },
    });
    expect(await screen.findByText(/Connected to Acme/)).toBeTruthy();
    expect(screen.queryByLabelText('Bot User OAuth Token')).toBeNull();
  });

  it("asks for the builder's name before Connect while it is the seeded You", async () => {
    const you = personDto({ name: 'You', handle: 'me', isBuilder: true });
    const { saved } = serve({ people: [you] });
    const name = await screen.findByLabelText('Your name');
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', true);
    fireEvent.change(name, { target: { value: 'Travis' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Name' }));
    await waitFor(() => {
      expect(saved).toEqual([{ handle: 'me', name: 'Travis', slack: null }]);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText('Your name')).toBeNull();
    });
  });
});

describe('Settings › People: the list', () => {
  it("the builder's row has no Remove, and another person's has", async () => {
    serve({ people: [BUILDER_PERSON, personDto({ name: 'Priya Shah' })] });
    await screen.findByText('Travis');
    const builder = screen.getByRole('row', { name: /Travis/ });
    const priya = screen.getByRole('row', { name: /Priya Shah/ });
    expect(within(builder).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(within(priya).getByRole('button', { name: 'Remove Priya Shah' })).toBeTruthy();
  });

  it('shows how each person is reached and sent to', async () => {
    serve({
      people: [
        BUILDER_PERSON,
        personDto({ name: 'Mark Ellis', slack: slackContact('U1', { sendMode: 'auto' }) }),
        personDto({ name: 'Priya Shah' }),
      ],
    });
    await screen.findByText('Mark Ellis');
    const mark = screen.getByRole('row', { name: /Mark Ellis/ });
    expect(within(mark).getByText('Send Without Asking')).toBeTruthy();
    const priya = screen.getByRole('row', { name: /Priya Shah/ });
    expect(within(priya).getByText('not in Slack')).toBeTruthy();
  });

  it("removing a routed person shows the daemon's refusal", async () => {
    serve({
      people: [BUILDER_PERSON, personDto({ name: 'Priya Shah' })],
      removeRefusal: 'Priya Shah answers questions; reroute them first.',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Priya Shah' }));
    expect(await screen.findByText(/reroute them first/)).toBeTruthy();
    expect(screen.getByText('Priya Shah')).toBeTruthy();
  });
});

describe('Settings › People: Add Person', () => {
  const connected = { state: 'connected', teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT' };

  it('picks a member, proposes the handle, and saves review mode with 10 questions a day', async () => {
    const { saved } = serve({ connection: connected });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Person' }));
    const dialog = await screen.findByRole('dialog');
    await pickOption(within(dialog).getByLabelText('Slack member'), /Mark Ellis/);
    expect(within(dialog).getByLabelText('Name')).toHaveProperty('value', 'Mark Ellis');
    expect(within(dialog).getByLabelText('Handle')).toHaveProperty('value', 'mark-ellis');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Person' }));
    await waitFor(() => {
      expect(saved).toEqual([
        {
          handle: 'mark-ellis',
          name: 'Mark Ellis',
          slack: { teamId: 'T1', userId: 'U1', sendMode: 'review', dailyLimit: 10 },
        },
      ]);
    });
  });

  it('describes what the daily limit counts, and Off saves no limit', async () => {
    const { saved } = serve({ connection: connected });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Person' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Replies, follow-ups and the conversation in a thread never count/),
    ).toBeTruthy();
    await pickOption(within(dialog).getByLabelText('Slack member'), /Ana Ortiz/);
    fireEvent.click(within(dialog).getByRole('switch', { name: 'No limit' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Person' }));
    await waitFor(() => {
      expect(saved).toEqual([
        {
          handle: 'ana-ortiz',
          name: 'Ana Ortiz',
          slack: { teamId: 'T1', userId: 'U2', sendMode: 'review', dailyLimit: null },
        },
      ]);
    });
  });

  it('"Someone not in Slack" saves a person with no contact', async () => {
    const { saved } = serve({ connection: connected });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Person' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Someone not in Slack' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Priya Shah' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Person' }));
    await waitFor(() => {
      expect(saved).toEqual([{ handle: 'priya-shah', name: 'Priya Shah', slack: null }]);
    });
  });

  it('cannot save without a member or a name', async () => {
    serve({ connection: connected });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Person' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Save Person' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
