import { VITE_ORIGIN } from './factory-connection';

export const FactoryOptIn = { Enable: 'enable', Disable: 'disable' } as const;
export type FactoryOptIn = (typeof FactoryOptIn)[keyof typeof FactoryOptIn];

export interface FactoryOptInPlan {
  /** What to run; null where there is no installed app to opt in. */
  readonly command: { readonly file: string; readonly args: readonly string[] } | null;
  /** What the builder does next. */
  readonly message: string;
}

const VARIABLE = 'TENDB_DEV_UI_ORIGIN';
const RELAUNCH = 'Quit 10db (⌘Q) and open it again.';

/**
 * Turns the installed app's dev UI opt-in on or off in launchd's user environment, which every app
 * opened from the Dock, Finder or Spotlight starts with, until the Mac restarts. It never quits or
 * opens 10db itself: quitting stops running work, so the builder chooses when.
 */
export function factoryOptInPlan(
  action: FactoryOptIn,
  platform: NodeJS.Platform,
): FactoryOptInPlan {
  if (platform !== 'darwin')
    return {
      command: null,
      message: `pnpm dev:factory:${action} does nothing here: the installed 10db app is macOS only.`,
    };
  switch (action) {
    case FactoryOptIn.Enable:
      return {
        command: { file: 'launchctl', args: ['setenv', VARIABLE, VITE_ORIGIN] },
        message: `10db will accept the dev UI at ${VITE_ORIGIN} the next time it starts.\n${RELAUNCH} This lasts until you restart your Mac; run this again after a restart.`,
      };
    case FactoryOptIn.Disable:
      return {
        command: { file: 'launchctl', args: ['unsetenv', VARIABLE] },
        message: `10db will refuse the dev UI the next time it starts.\n${RELAUNCH}`,
      };
  }
}
