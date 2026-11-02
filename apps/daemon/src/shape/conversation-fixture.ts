import {
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  type PlanDraft,
  type ProjectDto,
  type ShapeDto,
  type ShapeMessageId,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  createTestStore,
  insertPerson,
  insertShape,
  insertShapeMessage,
  seedProject,
  type Store,
} from '@10db/db';

/** A store with a project and an open conversation, for the tests of the shape module. */
export interface ConversationFixture {
  readonly store: Store;
  readonly project: ProjectDto;
  readonly shape: ShapeDto;
  /** A builder message in the conversation, as a proposal may cite it. */
  say(text?: string): ShapeMessageId;
  close(): void;
}

export function seedConversation(): ConversationFixture {
  const { store, close } = createTestStore();
  const project = seedProject(store, { name: 'alpha' });
  // Goals are owned by the builder, whom the daemon seeds at start.
  store.write((ctx) => insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true }));
  const shape = store.write((ctx) =>
    insertShape(ctx, project.id, { title: 'Board polish', origin: ShapeOrigin.App }),
  ).value;
  return {
    store,
    project,
    shape,
    close,
    say: (text = 'Make the board denser.') =>
      store.write((ctx) =>
        insertShapeMessage(ctx, shape.id, {
          author: ShapeMessageAuthor.Builder,
          kind: ShapeMessageKind.Text,
          body: text,
        }),
      ).value.id,
  };
}

/** The value, or a failure that says what was missing; a test's way past `undefined`. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing: ${what}`);
  return value;
}

/** A draft of loose tasks, each citing `source`; the project's areas are `api` and `ui`. */
export function looseDraft(source: ShapeMessageId, ...keys: string[]): Record<string, unknown> {
  return {
    looseTasks: keys.map((key) => ({
      key,
      title: `Task ${key}`,
      criteria: ['It works'],
      areas: ['api'],
      size: 'S',
      ceremony: 'direct',
      sourceMessageIds: [source],
    })),
  };
}

export type RawDraft = Record<string, unknown> | PlanDraft;
