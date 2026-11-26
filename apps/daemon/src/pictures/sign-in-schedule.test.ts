import { ProjectId } from '@10db/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { SIGN_IN_CHECK_EVERY_MS, startSignInSchedule } from './sign-in-schedule';

// Value: protects=a project's sign-in is checked at start, on a change and every day, only while it has
// an app address and a dev login; fails_when=a trigger is dropped or a project with nothing to sign in
// to is checked; why_new=the card a failed sign-in raises depends on these three triggers;
// no_claim=the check itself or the card, which the daemon's HTTP test covers.

const WITH_LOGIN = {
  id: ProjectId.parse('prj_01a21647-9af3-7313-80f1-d3445266457d'),
  appUrl: 'http://localhost:5173',
  devLoginCommand: 'echo x',
  archivedAt: null,
} as const;
const WITHOUT_LOGIN = {
  ...WITH_LOGIN,
  id: ProjectId.parse('prj_01a21647-9af3-7313-80f1-d3445266457e'),
  devLoginCommand: null,
} as const;

describe('the sign-in schedule', () => {
  it('checks at start, when a project changes and every day, and stands down for a project with no login', async () => {
    const clock = new ManualClock();
    const checked: string[] = [];
    const stood: string[] = [];
    const projects = [WITH_LOGIN, WITHOUT_LOGIN];
    const schedule = startSignInSchedule({
      clock,
      logger: silentLogger,
      ready: Promise.resolve(),
      projects: () => projects,
      project: (id) => projects.find((p) => p.id === id) ?? WITH_LOGIN,
      check: (id, fresh) => {
        checked.push(`${id.slice(-1)}${fresh ? ' fresh' : ''}`);
        return Promise.resolve();
      },
      nothingToCheck: (id) => {
        stood.push(id.slice(-1));
      },
    });
    await vi.waitFor(() => {
      expect(checked).toEqual(['d']);
    });

    schedule.changed(WITH_LOGIN.id);
    schedule.changed(WITHOUT_LOGIN.id);
    expect(checked).toEqual(['d', 'd fresh']);
    expect(stood).toEqual(['e']);

    // The day's timer is set once the start's check ends.
    await vi.waitFor(() => {
      expect(clock.pendingTimers()).toBe(1);
    });
    clock.advance(SIGN_IN_CHECK_EVERY_MS);
    await vi.waitFor(() => {
      expect(checked).toEqual(['d', 'd fresh', 'd']);
    });

    schedule.stop();
    clock.advance(SIGN_IN_CHECK_EVERY_MS);
    expect(checked).toHaveLength(3);
  });
});
