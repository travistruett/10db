/**
 * Claude Code names a plugin's skills `<plugin>:<name>`, so a skill an instructions file names bare
 * arrives prefixed: the line tells the model which prefix is which. Codex's skills aren't prefixed.
 */
export const SKILL_NAMES_LINE =
  "Skills here are named <plugin>:<name>: the builder's own are yours:<name>, the project's are project:<name>. A skill your instructions name without a prefix is that skill.";

/**
 * What a Claude session's setup adds to its system prompt: the instructions, then the skill-name line
 * when plugin dirs come along. Null when there is neither.
 */
export function setupPromptText(
  instructions: string | null | undefined,
  plugins: readonly string[],
): string | null {
  const parts = [
    ...(instructions ? [instructions] : []),
    ...(plugins.length > 0 ? [SKILL_NAMES_LINE] : []),
  ];
  return parts.length === 0 ? null : parts.join('\n\n');
}
