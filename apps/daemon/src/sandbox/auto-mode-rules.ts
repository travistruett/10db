import { z } from 'zod';

/** The shape Claude Code reads from `settings.autoMode`: sentences its classifier weighs against a call. */
const AutoModeSettings = z.strictObject({
  hard_deny: z.array(z.string().min(1)).length(2),
  soft_deny: z.array(z.string().min(1)).length(1),
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
      gate,
      "Generating CPU load on the builder's Mac: busy loops, `yes`, stress tools or anything that spins cores.",
    ],
    soft_deny: [
      "Reading or writing outside the lane's worktree, except the paths the sandbox already allows.",
    ],
  });
}
