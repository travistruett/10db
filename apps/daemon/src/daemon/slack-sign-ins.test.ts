import { createTestStore, insertPerson, listPeople } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { slackBotAccount, LEGACY_SLACK_BOT_ACCOUNT } from '../environment';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import {
  cleanUpSlackSignIns,
  createSlackConnection,
  createStakeholderSends,
  readSlackWorkspaces,
} from '../stakeholders';
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
      sends: createStakeholderSends({ state, slack: null, clock, log: silentLogger }),
      connection: createSlackConnection({ state }),
      clock,
      fetch: fetchAuth,
      reconnect: () => Promise.resolve(),
      githubLogin: () => Promise.resolve(null),
      linear: {
        get: () => ({ binding: null, check: null }),
        check: () => Promise.reject(new Error('not used')),
        unlink: () => ({ binding: null, check: null }),
        startImport: () => Promise.reject(new Error('not used')),
        cancel: () => Promise.reject(new Error('not used')),
      },
    });
    await services.setSlackToken({ token: 'xoxb-new' });

    expect(keychain.read(slackBotAccount('T-NEW'))).toBe('xoxb-new');
    expect(readSlackWorkspaces(state.db)).toEqual([{ teamId: 'T-NEW', teamName: 'Acme' }]);

    cleanUpSlackSignIns({ state, keychain, log: silentLogger });

    expect(keychain.read(LEGACY_SLACK_BOT_ACCOUNT)).toBeNull();
    expect(keychain.read(slackBotAccount('T-NEW'))).toBe('xoxb-new');
    expect(listPeople(state.db).map((p) => [p.handle, p.slack !== null])).toEqual(
      expect.arrayContaining([
        ['bo', true],
        ['ana', false],
      ]),
    );
  });

  it('keeps every contact when there is no old token to clear, and tries again when the Keychain is unreadable', () => {
    const { state, keychain } = world();
    state.write((ctx) => {
      insertPerson(ctx, withContact('cy', 'T-GONE'));
    });
    // Disconnected (no workspaces) and no old item: nothing is deleted.
    cleanUpSlackSignIns({ state, keychain, log: silentLogger });
    expect(listPeople(state.db).every((p) => p.slack !== null)).toBe(true);

    // A Keychain that throws neither stops the start nor deletes anything.
    const locked = {
      ...keychain,
      read: () => {
        throw new Error('locked');
      },
    };
    expect(() => {
      cleanUpSlackSignIns({ state, keychain: locked, log: silentLogger });
    }).not.toThrow();
    expect(listPeople(state.db).every((p) => p.slack !== null)).toBe(true);
  });
});
