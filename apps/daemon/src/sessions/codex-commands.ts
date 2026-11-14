import type { AgentCommand } from './types';

// Sessions spec §5.5: the slash commands a Codex session offers. `/compact` and `/review` are
// app-server calls of their own, never text to the model; `/model` is the composer's (M5a) and
// reaches Codex as an ordinary message.

export const CODEX_COMMANDS: readonly AgentCommand[] = [
  { name: 'compact', description: 'Summarize the conversation so far to free context' },
  {
    name: 'review',
    description: 'Review the changes in the checkout',
    argumentHint: '[instructions]',
  },
  { name: 'model', description: 'Choose the model for the next turn' },
];

export type CodexCommandCall =
  | { readonly method: 'thread/compact/start' }
  | {
      readonly method: 'review/start';
      readonly target:
        | { readonly type: 'uncommittedChanges' }
        | { readonly type: 'custom'; readonly instructions: string };
    };

/** The app-server call a message's slash command is, read from its first word; null for any other text. */
export function codexCommandOf(text: string): CodexCommandCall | null {
  const trimmed = text.trim();
  const [word = ''] = trimmed.split(/\s/, 1);
  const rest = trimmed.slice(word.length).trim();
  switch (word) {
    case '/compact':
      return { method: 'thread/compact/start' };
    case '/review':
      return {
        method: 'review/start',
        target:
          rest === '' ? { type: 'uncommittedChanges' } : { type: 'custom', instructions: rest },
      };
    default:
      return null;
  }
}
