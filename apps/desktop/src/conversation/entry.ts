import type { ToolCallView } from '@10db/contracts';
import type { ReactNode } from 'react';

// What the conversation kit draws: a view model each screen maps its own messages to, so the kit
// reads no wire type and no harness. Who denied a tool call is the call's own `deniedBy`.

export type ConversationEntry =
  | {
      readonly kind: 'builder';
      readonly id: string;
      readonly text: string;
      /** Pictures or mention chips the screen draws under the text. */
      readonly extra: ReactNode | null;
    }
  | {
      readonly kind: 'reply';
      readonly id: string;
      readonly text: string;
      readonly partial: boolean;
    }
  | {
      readonly kind: 'reasoning';
      readonly id: string;
      readonly text: string;
      readonly durationMs: number | null;
    }
  | { readonly kind: 'tool'; readonly id: string; readonly call: ToolCallView }
  | {
      readonly kind: 'notice';
      readonly id: string;
      readonly text: string;
      readonly tone: 'info' | 'error';
    }
  | {
      readonly kind: 'divider';
      readonly id: string;
      readonly text: string;
      readonly action: { readonly label: string; readonly onClick: () => void } | null;
    }
  /** A screen's own row, such as Plan's screenshot. */
  | { readonly kind: 'custom'; readonly id: string; readonly render: () => ReactNode };

export type ToolEntry = Extract<ConversationEntry, { kind: 'tool' }>;
