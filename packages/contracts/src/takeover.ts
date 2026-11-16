import { z } from 'zod';

// Sessions spec §7.5: a chat continued in the builder's own terminal, and how that terminal opens.

/** How Open in Terminal opens the agent: a Terminal window, an iTerm one, or a command the builder pastes. */
export const TerminalApp = { Terminal: 'terminal', ITerm: 'iterm', Copy: 'copy' } as const;
export type TerminalApp = (typeof TerminalApp)[keyof typeof TerminalApp];
export const TerminalAppSchema = z.enum(TerminalApp);

/** A chat that is in the builder's terminal. */
export const TakeoverDto = z.object({
  /** When the chat went to the terminal. */
  since: z.iso.datetime(),
  app: TerminalAppSchema,
  /** What the builder is told of this terminal, in the daemon's words. */
  notes: z.array(z.string()),
  /** The command to paste, with Copy the Command; null when a window was opened. */
  line: z.string().nullable(),
});
export type TakeoverDto = z.infer<typeof TakeoverDto>;

/** What Open in Terminal would do now: why it can't, and what the builder is told. */
export const TakeoverPreviewDto = z.object({
  refusal: z.string().nullable(),
  notes: z.array(z.string()),
});
export type TakeoverPreviewDto = z.infer<typeof TakeoverPreviewDto>;

/** The command a chat that is in the terminal runs again. */
export const TakeoverCommandDto = z.object({ line: z.string() });
export type TakeoverCommandDto = z.infer<typeof TakeoverCommandDto>;
