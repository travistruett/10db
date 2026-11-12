import { getAppSetting, setAppSetting } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import type { MatchState } from './reply-match';

const KEY = 'stakeholder-reply-match';
/** The assignments kept: older ones belong to questions long answered. */
const KEEP = 500;

const Stored = z.object({
  assigned: z.record(z.string(), z.string()).default({}),
  asked: z.record(z.string(), z.object({ postTs: z.string(), forTs: z.string() })).default({}),
});

/** What the watch decided about messages typed at the top of a DM, as it was left; empty when nothing is stored. */
export function loadMatchState(state: StateStore): MatchState {
  const parsed = Stored.safeParse(getAppSetting(state.db, KEY));
  const stored = parsed.success ? parsed.data : { assigned: {}, asked: {} };
  return {
    assigned: new Map(Object.entries(stored.assigned)),
    asked: new Map(Object.entries(stored.asked)),
  };
}

/** Keeps the decisions across a restart, so a message already used for one question never answers another. */
export function saveMatchState(state: StateStore, match: MatchState): void {
  const assigned = Object.fromEntries([...match.assigned].slice(-KEEP));
  const asked = Object.fromEntries(match.asked);
  const next = JSON.stringify({ assigned, asked });
  if (JSON.stringify(getAppSetting(state.db, KEY)) === next) return;
  state.write((ctx) => {
    setAppSetting(ctx, KEY, { assigned, asked });
  });
}
