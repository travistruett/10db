import { describe, expect, it } from 'vitest';
import { VITE_ORIGIN } from './factory-connection';
import { FactoryOptIn, factoryOptInPlan } from './factory-opt-in';

const RELAUNCH = 'Quit 10db (⌘Q) and open it again.';

describe('factoryOptInPlan', () => {
  it.each([
    {
      name: 'enable on macOS sets the variable in launchd',
      action: FactoryOptIn.Enable,
      platform: 'darwin' as const,
      args: ['setenv', 'TENDB_DEV_UI_ORIGIN', VITE_ORIGIN],
      says: [`${RELAUNCH} This lasts until you restart your Mac; run this again after a restart.`],
    },
    {
      name: 'disable on macOS removes it from launchd',
      action: FactoryOptIn.Disable,
      platform: 'darwin' as const,
      args: ['unsetenv', 'TENDB_DEV_UI_ORIGIN'],
      says: [RELAUNCH],
    },
  ])('$name', ({ action, platform, args, says }) => {
    const plan = factoryOptInPlan(action, platform);
    expect(plan.command).toEqual({ file: 'launchctl', args });
    for (const line of says) expect(plan.message).toContain(line);
  });

  it.each([
    { name: 'enable on Linux', action: FactoryOptIn.Enable, platform: 'linux' as const },
    { name: 'disable on Linux', action: FactoryOptIn.Disable, platform: 'linux' as const },
    { name: 'enable on Windows', action: FactoryOptIn.Enable, platform: 'win32' as const },
  ])('$name runs nothing and says the installed app is macOS only', ({ action, platform }) => {
    const plan = factoryOptInPlan(action, platform);
    expect(plan.command).toBeNull();
    expect(plan.message).toMatch(/macOS only/);
    expect(plan.message).not.toContain(RELAUNCH);
  });
});
