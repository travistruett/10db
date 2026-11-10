import { ScreenKind, ScreenTheme, type TaskScreenDto } from '@10db/contracts';

// Workbench spec §4.6, §10: what a picture of the builder's app shows, in words, for its alt text.

const WHEN = {
  [ScreenKind.Before]: 'before',
  [ScreenKind.Turn]: 'after',
  [ScreenKind.After]: 'after sign-off',
} as const satisfies Record<ScreenKind, string>;

/**
 * "Settings after, turn 3, 1440 by 900": the page, when, the window, and a theme that is not the app's
 * own; a picture another task of the goal took says so.
 */
export function screenAlt(
  name: string,
  screen: Pick<TaskScreenDto, 'kind' | 'turnSeq' | 'theme' | 'width' | 'height'>,
  fromGoal = false,
): string {
  const parts = [`${name} ${WHEN[screen.kind]}`];
  if (fromGoal) parts.push('from an earlier task of this goal');
  if (screen.kind === ScreenKind.Turn && screen.turnSeq !== null)
    parts.push(`turn ${String(screen.turnSeq)}`);
  parts.push(`${String(screen.width)} by ${String(screen.height)}`);
  if (screen.theme !== ScreenTheme.Default) parts.push(`${screen.theme} theme`);
  return parts.join(', ');
}
