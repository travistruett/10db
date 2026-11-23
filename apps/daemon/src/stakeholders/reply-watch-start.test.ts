import { createTestStore } from '@10db/db';
import { afterEach, expect, it, vi } from 'vitest';
import { offJudge } from '../../test/engine';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import { createSlackClient } from '../slack';
import { createReplyWatch } from './reply-watch';
import { createStakeholderSends } from './sends';
import { createSlackConnection } from './slack-connection';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

it('knows the Slack connection as soon as it starts, not an interval later', async () => {
  const clock = new ManualClock();
  const { store, close } = createTestStore(() => clock.now());
  closers.push(close);
  const state = createStateStore(store, createEventBus());
  const authTest: typeof fetch = () =>
    Promise.resolve(
      Response.json({ ok: true, team_id: 'T1', team: 'Acme', user_id: 'UBOT', url: 'https://x' }),
    );
  const slack = createSlackClient({
    fetch: authTest,
    token: () => Promise.resolve('xoxb-test'),
    clock,
    timeoutMs: 5_000,
  });
  const connection = createSlackConnection({ state });
  const watch = createReplyWatch({
    state,
    slack,
    inbox: {
      answerAs: () => {
        throw new Error('no reply is read while starting');
      },
    },
    judge: offJudge,
    sends: createStakeholderSends({ state, slack, clock, log: silentLogger }),
    clock,
    log: silentLogger,
    connection,
  });

  watch.start();
  // The clock never moves: only a check at start can find the token.
  await vi.waitFor(() => {
    expect(connection.get()).toMatchObject({ state: 'connected', teamName: 'Acme' });
  });
  await watch.stop();
});
