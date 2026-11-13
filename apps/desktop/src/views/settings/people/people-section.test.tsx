import { mintId, PersonInput, type PersonDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { pickOption } from '../../../test/combobox';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import {
  BUILDER_PERSON,
  personDto,
  slackConnection,
  slackContact,
  slackMember,
} from '../../../test/people-fixtures';

const connected = { state: 'connected', teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT' };

interface Options {
  readonly people?: PersonDto[];
  readonly connection?: Record<string, unknown>;
  readonly removeRefusal?: string;
  readonly rules?: unknown[];
}

function serve(options: Options = {}) {
  let people = options.people ?? [BUILDER_PERSON];
  const saved: unknown[] = [];
  const connection = slackConnection(options.connection);
  server.use(
    http.get(daemonUrl('/people'), () => HttpResponse.json(people)),
    http.get(daemonUrl('/projects/:projectId/routing-rules'), () =>
      HttpResponse.json(options.rules ?? []),
    ),
    http.get(daemonUrl('/slack'), () => HttpResponse.json(connection)),
    http.get(daemonUrl('/slack/members'), () =>
      HttpResponse.json([
        slackMember(),
        slackMember({ userId: 'U2', name: 'ana', realName: 'Ana Ortiz', title: 'Design' }),
      ]),
    ),
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
  return { saved };
}

async function openAddPerson(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Add Person' }));
  return screen.findByRole('dialog', { name: 'Add Person' });
}

describe('Settings › People: the list', () => {
  it("lists the builder first as You, and only another person's row has Remove", async () => {
    serve({
      people: [personDto({ name: 'Priya Shah' }), BUILDER_PERSON],
      connection: connected,
    });
    await screen.findByText('You · Travis');
    const [, first] = screen.getAllByRole('row');
    expect(first?.textContent).toMatch(/You · Travis/);
    const builder = screen.getByRole('row', { name: /You · Travis/ });
    const priya = screen.getByRole('row', { name: /Priya Shah/ });
    expect(within(builder).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(within(priya).getByRole('button', { name: 'Remove Priya Shah' })).toBeTruthy();
  });

  it('shows how 10db reaches each person as a chip, and how it sends to them', async () => {
    serve({
      people: [
        BUILDER_PERSON,
        personDto({ name: 'Mark Ellis', slack: slackContact('U1', { sendMode: 'auto' }) }),
        personDto({ name: 'Ana Ortiz', slack: slackContact('U2') }),
        personDto({ name: 'Priya Shah' }),
      ],
      connection: connected,
    });
    const mark = await screen.findByRole('row', { name: /Mark Ellis/ });
    expect(await within(mark).findByText('Slack @mark')).toBeTruthy();
    expect(within(mark).getByText('Sent on its own')).toBeTruthy();
    const ana = screen.getByRole('row', { name: /Ana Ortiz/ });
    expect(await within(ana).findByText('Slack @ana')).toBeTruthy();
    expect(within(ana).getByText('Shown to you first')).toBeTruthy();
    const priya = screen.getByRole('row', { name: /Priya Shah/ });
    expect(within(priya).getByText('Not on Slack')).toBeTruthy();
    expect(within(priya).getByText('You pass it on')).toBeTruthy();
  });

  it('points at Integrations while Slack is not connected, or its setup is unfinished', async () => {
    serve();
    expect(await screen.findByText(/Slack isn't connected/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Connect it in Integrations' }).getAttribute('href'),
    ).toBe('/settings/integrations');
  });

  it("removing a routed person shows the daemon's refusal", async () => {
    serve({
      people: [BUILDER_PERSON, personDto({ name: 'Priya Shah' })],
      removeRefusal: 'Priya Shah answers questions; reroute them first.',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Priya Shah' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Person' }));
    expect(await screen.findByText(/reroute them first/)).toBeTruthy();
    expect(screen.getByText('Priya Shah')).toBeTruthy();
  });

  it('asks before removing a person, says what happens to their questions, and Cancel keeps them', async () => {
    serve({ people: [BUILDER_PERSON, personDto({ name: 'Priya Shah' })] });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Priya Shah' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Priya Shah?' });
    expect(
      within(dialog).getByText(
        /Their Slack contact is deleted\. Questions already sent to them stay in the Waiting tab\./,
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Remove Priya Shah?' })).toBeNull();
    });
    expect(screen.getByText('Priya Shah')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Priya Shah' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Person' }));
    await waitFor(() => {
      expect(screen.queryByText('Priya Shah')).toBeNull();
    });
  });

  it('keeps the timers in their own group, with the real-time note inside it', async () => {
    serve();
    const group = (await screen.findByRole('heading', { name: "When someone hasn't answered" }))
      .parentElement;
    expect(group).not.toBeNull();
    expect(within(group ?? document.body).getByText(/fires when it wakes/)).toBeTruthy();
  });
});

describe('Settings › People: Answers', () => {
  it('lists the routes a person answers as links to Who Answers, and the builder as everything not routed', async () => {
    const mark = personDto({ name: 'Mark Ellis', handle: 'mark' });
    const rule = (category: string, goal: boolean) => ({
      id: mintId('RoutingRule'),
      projectId: mintId('Project'),
      category,
      topic: null,
      goalId: goal ? mintId('Goal') : null,
      taskId: null,
      area: null,
      personId: mark.id,
      createdAt: '2026-10-13T12:00:00.000Z',
      updatedAt: '2026-10-13T12:00:00.000Z',
    });
    serve({
      people: [BUILDER_PERSON, mark, personDto({ name: 'Priya Shah' })],
      rules: [rule('product', true), rule('design', false)],
    });
    const link = await screen.findByRole('link', { name: /Demo · product \(a goal\), design/ });
    expect(link.getAttribute('href')).toBe('/settings/routing-rules');
    expect(
      within(screen.getByRole('row', { name: /You · Travis/ })).getByText('everything not routed'),
    ).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /Priya Shah/ })).getByText('—')).toBeTruthy();
  });
});

describe('Settings › People: Add Person', () => {
  it('finds a member, takes the name from them, and saves review mode with 10 a day', async () => {
    const { saved } = serve({ connection: connected });
    const dialog = await openAddPerson();
    await pickOption(within(dialog).getByLabelText('Find someone in Acme'), /Mark Ellis/);
    expect(within(dialog).getByLabelText('Name')).toHaveProperty('value', 'Mark Ellis');
    expect(within(dialog).queryByLabelText('Handle')).toBeNull();
    expect(
      within(dialog).getByRole('radio', { name: 'Show me each message first' }),
    ).toHaveProperty('checked', true);
    expect(within(dialog).getByText('The first message is always shown to you.')).toBeTruthy();
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

  it('an edited name is saved, and a handle someone has gets a number', async () => {
    const { saved } = serve({
      people: [BUILDER_PERSON, personDto({ name: 'Mark', handle: 'mark-e' })],
      connection: connected,
    });
    const dialog = await openAddPerson();
    await pickOption(within(dialog).getByLabelText('Find someone in Acme'), /Mark Ellis/);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mark E' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Send on its own' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Person' }));
    await waitFor(() => {
      expect(saved).toEqual([
        {
          handle: 'mark-e-2',
          name: 'Mark E',
          slack: { teamId: 'T1', userId: 'U1', sendMode: 'auto', dailyLimit: 10 },
        },
      ]);
    });
  });

  it('says what the limit counts, and No limit saves none', async () => {
    const { saved } = serve({ connection: connected });
    const dialog = await openAddPerson();
    expect(within(dialog).getByText("Replies in an existing thread don't count.")).toBeTruthy();
    await pickOption(within(dialog).getByLabelText('Find someone in Acme'), /Ana Ortiz/);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'No limit' }));
    expect(within(dialog).getByLabelText('New questions a day')).toHaveProperty('disabled', true);
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

  it('takes the daily limit in whole numbers only', async () => {
    const { saved } = serve({ connection: connected });
    const dialog = await openAddPerson();
    await pickOption(within(dialog).getByLabelText('Find someone in Acme'), /Ana Ortiz/);
    const limit = within(dialog).getByLabelText('New questions a day');
    fireEvent.change(limit, { target: { value: '2.5' } });
    expect((limit as HTMLInputElement).value).not.toContain('.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Person' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    const [person] = saved as { slack: { dailyLimit: number } }[];
    expect(Number.isInteger(person?.slack.dailyLimit)).toBe(true);
  });

  it('"Not on Slack? Add them by name" says what 10db does and saves no contact', async () => {
    const { saved } = serve({ connection: connected });
    const dialog = await openAddPerson();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Not on Slack? Add them by name' }));
    expect(within(dialog).getByText(/10db can't message them/)).toBeTruthy();
    expect(within(dialog).queryByText(/email/i)).toBeNull();
    expect(within(dialog).queryByText('Before 10db messages them')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Priya Shah' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Person' }));
    await waitFor(() => {
      expect(saved).toEqual([{ handle: 'priya-shah', name: 'Priya Shah', slack: null }]);
    });
  });

  it('opens on a name while Slack is not connected', async () => {
    serve();
    const dialog = await openAddPerson();
    expect(within(dialog).queryByLabelText(/Find someone/)).toBeNull();
    expect(within(dialog).getByText(/10db can't message them/)).toBeTruthy();
  });

  it('cannot save without a member or a name', async () => {
    serve({ connection: connected });
    const dialog = await openAddPerson();
    expect(within(dialog).getByRole('button', { name: 'Save Person' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it("the builder's row changes their member, keeping their handle, and has no Remove", async () => {
    const me = personDto({
      name: 'Mark Ellis',
      handle: 'me',
      isBuilder: true,
      slack: slackContact('U1'),
    });
    const { saved } = serve({ people: [me], connection: connected });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Mark Ellis' }));
    const dialog = await screen.findByRole('dialog');
    await pickOption(within(dialog).getByLabelText('Which one is you?'), /Ana Ortiz/);
    expect(within(dialog).getByLabelText('Name')).toHaveProperty('value', 'Ana Ortiz');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Person' }));
    await waitFor(() => {
      expect(saved).toEqual([
        {
          handle: 'me',
          name: 'Ana Ortiz',
          slack: { teamId: 'T1', userId: 'U2', sendMode: 'review', dailyLimit: 10 },
        },
      ]);
    });
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });
});
