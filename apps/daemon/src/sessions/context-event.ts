import type { SessionEvent } from './types';

/**
 * Context used, as 0–100. Computed from the token counts so it never depends on whether the SDK's
 * own `percentage` is a fraction or a percent; that field is only the fallback when no window is known.
 */
export function contextEvent(usage: {
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
}): Extract<SessionEvent, { type: 'context' }> {
  const raw =
    usage.maxTokens > 0
      ? (100 * usage.totalTokens) / usage.maxTokens
      : usage.percentage <= 1
        ? usage.percentage * 100
        : usage.percentage;
  return {
    type: 'context',
    percentage: Math.round(raw * 10) / 10,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
  };
}
