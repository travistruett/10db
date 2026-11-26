import { z } from 'zod';

// Setting up a project's picture sign-in: the project's one sign-in card offers a task that writes a
// dev login, and that task's lane saves it through `save_dev_login`, which saves only a command the
// sign-in check signs the picture browser in with.

/** The lane tool the sign-in setup task saves its dev login through. */
export const SAVE_DEV_LOGIN_TOOL = 'save_dev_login';

/** One line the card shows. */
const Line = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((t) => !/\p{Cc}/u.test(t), 'one line, with no control characters');

export const SaveDevLoginInput = z
  .object({
    command: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        'The dev login command, run from the project folder. 10db checks it signs the picture browser in and saves it only then.',
      ),
    cannot: z
      .object({
        found: Line.describe('What you found in the repository about how users sign in.'),
        decide: Line.describe('What the builder must decide before a dev login can work.'),
      })
      .optional()
      .describe('Instead of a command: why no dev login can work as the project stands.'),
  })
  .refine((input) => (input.command === undefined) !== (input.cannot === undefined), {
    message: 'Give either command or cannot',
  });
export type SaveDevLoginInput = z.infer<typeof SaveDevLoginInput>;

export const SAVE_DEV_LOGIN_DESCRIPTION =
  "Saves the project's dev login command for pictures. 10db runs it from the project's own folder with TENDB_APP_URL set, opens the address it printed in the picture browser and loads the app's first page; it saves the command only when that signs in, and otherwise answers what went wrong and saves nothing. A command naming an email outside the reserved test domains (example.com, .test and the like) is refused unrun. When no command can work, call it with `cannot` instead: the builder's card says what you found and what they must decide.";

/** The answers the project's sign-in card offers; the card shows them as written. */
export const SignInSetupChoice = { SetUp: 'Set Up Sign-In', NotNow: 'Not Now' } as const;
export type SignInSetupChoice = (typeof SignInSetupChoice)[keyof typeof SignInSetupChoice];

/** The `detail` key of a sign-in card that offers Set Up Sign-In: the project it sets up. */
export const SIGN_IN_OFFER = 'signInOffer';
/** The `detail` key of the card of a sign-in being set up: the task setting it up. */
export const SIGN_IN_SETUP_TASK = 'signInSetupTask';
/**
 * The `detail` key of a sign-in card whose setup task found no dev login can work: what it found, what
 * the builder must decide, and the address and command that held for.
 */
export const SIGN_IN_CANNOT = 'signInCannot';
