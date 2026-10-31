import { z } from 'zod';

/**
 * Claude Code splices its built-in rules in where this entry stands. A list without it replaces them,
 * which would drop the defaults that block force pushes, publishes and `curl | bash`.
 */
const DEFAULTS = '$defaults';

/** The shape Claude Code reads from `settings.autoMode`: sentences its classifier weighs against a call. */
const AutoModeSettings = z.strictObject({
  hard_deny: z.tuple([z.literal('$defaults'), z.string().min(1), z.string().min(1)]),
  soft_deny: z.tuple([z.literal('$defaults'), z.string().min(1)]),
});
export type AutoModeSettings = z.infer<typeof AutoModeSettings>;

/**
 * The denials a builder kept typing as card answers, for the classifier of a lane in auto mode. The gate
 * and CPU rules are hard denies: a soft deny yields to a prompt that names the command, and briefings name
 * the gate when they forbid it. Paths are soft because the sandbox already bounds them.
 */
export function autoModeRules(gateCommand: string | null): AutoModeSettings {
  const command = (gateCommand ?? '').replaceAll(/\s+/g, ' ').trim();
  // A JSON string quotes any command, backticks and quotes included, so it cannot break the sentence.
  const gate =
    command === ''
      ? "Running the project's full gate: 10db runs it after the step, so a lane never does."
      : `Running the project's full gate, the command ${JSON.stringify(command)}: 10db runs it after the step, so a lane never does.`;
  return AutoModeSettings.parse({
    hard_deny: [
      DEFAULTS,
      gate,
      "Generating CPU load on the builder's Mac: busy loops, `yes`, stress tools or anything that spins cores.",
    ],
    soft_deny: [
      DEFAULTS,
      "Reading or writing outside the lane's worktree, except the paths the sandbox already allows.",
    ],
  });
}
