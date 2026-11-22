import { createTestStore, insertPerson, listPeople } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { slackBotAccount, LEGACY_SLACK_BOT_ACCOUNT } from '../environment';
import { createEventBus, createStateStore } from '../events';
import { cleanUpSlackSignIns, createSlackConnection, readSlackWorkspaces } from '../stakeholders';
import { createMemoryKeychain } from '../../test/fixtures';
import { createStakeholderApiServices } from './stakeholder-services';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function world() {
  const clock = new ManualClock();
  const { store, close } = createTestStore(() => clock.now());
  closers.push(close);
  const state = createStateStore(store, createEventBus());
  const keychain = createMemoryKeychain();
  return { clock, state, keychain };
}

const withContact = (handle: string, teamId: string) =>
  ({ handle, name: handle, slack: { teamId, userId: `U-${handle}` } }) as const;

describe('Slack sign-ins by workspace', () => {
  it('stores the token under its team id and clears the old item and contacts of no signed-in workspace', async () => {
    const { clock, state, keychain } = world();
    state.write((ctx) => {
      insertPerson(ctx, withContact('ana', 'T-OLD'));
      insertPerson(ctx, withContact('bo', 'T-NEW'));
    });
    keychain.write(LEGACY_SLACK_BOT_ACCOUNT, 'xoxb-old');
    const fetchAuth: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          ok: true,
          team_id: 'T-NEW',
          team: 'Acme',
          user_id: 'UBOT',
          url: 'https://x',
        }),
      );
    const services = createStakeholderApiServices({
      state,
      keychain,
      slack: null,
      sends: {} as never,
      connection: createSlackConnection({ state }),
      clock,
      fetch: fetchAuth,
      reconnect: () => Promise.resolve(),
      githubLogin: () => Promise.resolve(null),
    });
    await services.setSlackToken({ token: 'xoxb-new' });

    expect(keychain.read(slackBotAccount('T-NEW'))).toBe('xoxb-new');
    expect(readSlackWorkspaces(state.db)).toEqual([{ teamId: 'T-NEW', teamName: 'Acme' }]);

    cleanUpSlackSignIns({ state, keychain });

    expect(keychain.read(LEGACY_SLACK_BOT_ACCOUNT)).toBeNull();
    expect(keychain.read(slackBotAccount('T-NEW'))).toBe('xoxb-new');
    expect(listPeople(state.db).map((p) => [p.handle, p.slack !== null])).toEqual(
      expect.arrayContaining([
        ['bo', true],
        ['ana', false],
      ]),
    );
  });
});
