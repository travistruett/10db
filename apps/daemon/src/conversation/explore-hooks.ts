import type { AccountId, ConversationFileId, ConversationItemId, SessionId } from '@10db/contracts';
import type { ConversationItemRow, ConversationRow, WriteContext } from '@10db/db';
import type { WaitObserver } from '../inbox';
import type { ConversationReadSpec, ExploreSessionSpec, ShapeImage } from '../sessions';
import type { PictureLimits } from './picture-limits';

// Sessions spec §6.1: what an explore conversation's owner (Plan, and from M5a a chat) gives the
// engine. The engine owns the session's lifecycle; the owner says what a session is and what a turn
// starter reads as.

/** What one queued turn starter sends (call 5). `sent` runs in the write that marks it pushed. */
export interface Outgoing {
  readonly text: string;
  readonly images: readonly ShapeImage[];
  readonly blocks: readonly ConversationFileId[];
  sent(ctx: WriteContext): void;
}

/** What the engine has made of a start before the owner builds its session. */
export interface ExploreStart {
  readonly sessionId: SessionId;
  readonly mcpToken: string;
  /** The agent session to resume; null for a fresh one. */
  readonly resume: string | null;
  /** The digest a fresh session that follows the agent's speech is told, stored as an item. */
  readonly digest: string | null;
  /** The turn starters the session's first message carries. */
  readonly first: Outgoing;
  /** Told when a card the session waits on is raised and settled. */
  readonly observer: WaitObserver;
}

/** The owner's session, ready to open, and what it was prepared with. */
export interface ExploreLaunch {
  readonly spec: ExploreSessionSpec;
  readonly limits: PictureLimits;
  /** When the credentials its servers were given expire (ISO), or null. */
  readonly expiresAt: string | null;
  readonly accountId: AccountId;
  /** The model by its own id, for a refusal to mark. */
  readonly model: string;
  /** Ends what the session was prepared with; runs once, however often it is called. */
  release(): Promise<void>;
  /** Watches what runs under the agent's process, whose pid its start reports. */
  track(pid: number): void;
}

/** How a turn ended, and the turn starters it was begun with. */
export interface TurnEnd {
  readonly how: 'complete' | 'failed' | 'stopped' | 'ended';
  readonly starters: readonly ConversationItemId[];
}

/** A model the conversation can run on: its id, its display name, and what the account launches it as. */
export interface ExploreModel {
  readonly model: string;
  readonly label: string;
  readonly launchId: string;
}

export interface ExploreOwnerHooks {
  spec(conv: ConversationRow, start: ExploreStart): Promise<ExploreLaunch>;
  digest(conv: ConversationRow): string;
  outgoing(
    conv: ConversationRow,
    item: ConversationItemRow,
    session: {
      readonly fresh: boolean;
      readonly digest: string | null;
      readonly limits: PictureLimits;
    },
  ): Outgoing;
  onTurnEnded(conv: ConversationRow, end: TurnEnd): Promise<void>;
  /**
   * What reading the agent's own conversation back needs after a restart (rule 5); absent for an owner
   * whose agent keeps no conversation to read (Claude Code's).
   */
  readBackSpec?(
    conv: ConversationRow,
  ): Promise<Pick<ConversationReadSpec, 'account' | 'env' | 'cwd'>>;
  /** The model a pick runs on (null: the role's), for a warm session's switch and the change's notice. */
  describeModel(conv: ConversationRow, model: string | null): ExploreModel;
  readonly freshAtContextPct: number;
}
