import type {
  AccountId,
  ConversationState,
  ConversationFileId,
  ConversationItemId,
  Effort,
  SessionId,
} from '@10db/contracts';
import type { ConversationItemRow, ConversationRow, WriteContext } from '@10db/db';
import type { WaitObserver } from '../inbox';
import type { ConversationReadSpec, ExploreSessionSpec, ShapeImage } from '../sessions';
import type { PictureLimits } from './picture-limits';

// Sessions spec §6.1: what an explore conversation's owner (Plan, and a chat once chats run) gives the
// engine. The engine owns the session's lifecycle; the owner says what a session is and what a turn
// starter reads as.

/** What one queued turn starter sends. `sent` runs in the write that marks it pushed. */
export interface Outgoing {
  readonly text: string;
  readonly images: readonly ShapeImage[];
  readonly blocks: readonly ConversationFileId[];
  sent(ctx: WriteContext): void;
}

/** What the engine has made of a start before the owner builds its session. */
interface ExploreStart {
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
  /**
   * Whether the session can write Your folder, as `turnStarting` answered for the turn that opened it; false
   * where absent. A warm session whose answer differs from the next turn's is closed first.
   */
  readonly writes?: boolean;
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

/**
 * A model the conversation can run on: its id, its display name, what the account launches it as, and
 * the effort it runs at.
 */
export interface ExploreModel {
  readonly model: string;
  readonly label: string;
  readonly launchId: string;
  readonly effort: Effort;
}

/** The owner's words for what the engine tells the builder; the engine's own where none are given. */
export interface ExploreWords {
  /** The notice that the next start is fresh, past the context limit. */
  readonly freshSession: string;
  /** The notice of a start that could not open a session, from why. */
  startFailed(reason: string): string;
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
   * What reading the agent's own conversation back needs after a restart; absent for an owner
   * whose agent keeps no conversation to read (Claude Code's).
   */
  readBackSpec?(
    conv: ConversationRow,
  ): Promise<Pick<ConversationReadSpec, 'account' | 'env' | 'cwd'>>;
  /** The model a pick runs on (null: the role's), for a warm session's switch and the change's notice. */
  describeModel(conv: ConversationRow, model: string | null): ExploreModel;
  readonly freshAtContextPct: number;
  /**
   * The picture limits the conversation's next session runs under, for the first message it is sent
   * before its launch is known; the account kind's own where absent.
   */
  limits?(conv: ConversationRow): PictureLimits;
  /**
   * Whether the next start may resume the agent session it would; false starts it fresh, from the
   * digest. Asked only when there is one to resume; resumed where absent.
   */
  keepsResume?(conv: ConversationRow): boolean;
  readonly words?: Partial<ExploreWords>;
  /**
   * Asked just before the engine reduces a builder message from a state outside a turn, when a starter waits
   * and no update hold parks it: the owner takes what the turn needs and says whether the turn writes. Not
   * every such reduce begins a turn, so `onState` releases what this took.
   */
  turnStarting?(conv: ConversationRow): { readonly writes: boolean };
  /**
   * Told after every reduce, a transition or not. Outside a turn (`starting`, `running`, `waiting_card` and
   * `stopping`) the owner gives back what `turnStarting` took.
   */
  onState?(conv: ConversationRow, state: ConversationState): void;
  /** Told when a starter begins and ends waiting on a hold, for a view that says so. */
  onParked?(conv: ConversationRow, parked: boolean): void;
}
