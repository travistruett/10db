import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { InitializeResponse as GeneratedInitializeResponse } from './codex-generated/ts/InitializeResponse';
import type { AccountRateLimitsUpdatedNotification } from './codex-generated/ts/v2/AccountRateLimitsUpdatedNotification';
import type { ConfigReadResponse as GeneratedConfigReadResponse } from './codex-generated/ts/v2/ConfigReadResponse';
import type { GetAccountRateLimitsResponse } from './codex-generated/ts/v2/GetAccountRateLimitsResponse';
import type { GetAccountResponse } from './codex-generated/ts/v2/GetAccountResponse';
import type { HooksListResponse as GeneratedHooksListResponse } from './codex-generated/ts/v2/HooksListResponse';
import type { ItemCompletedNotification } from './codex-generated/ts/v2/ItemCompletedNotification';
import type { ModelListResponse as GeneratedModelListResponse } from './codex-generated/ts/v2/ModelListResponse';
import type { ThreadResumeResponse } from './codex-generated/ts/v2/ThreadResumeResponse';
import type { ThreadStartResponse } from './codex-generated/ts/v2/ThreadStartResponse';
import type { ThreadTokenUsageUpdatedNotification } from './codex-generated/ts/v2/ThreadTokenUsageUpdatedNotification';
import type { ThreadTurnsListResponse } from './codex-generated/ts/v2/ThreadTurnsListResponse';
import type { TurnCompletedNotification } from './codex-generated/ts/v2/TurnCompletedNotification';
import type { TurnStartedNotification } from './codex-generated/ts/v2/TurnStartedNotification';
import type { TurnStartResponse as GeneratedTurnStartResponse } from './codex-generated/ts/v2/TurnStartResponse';
import {
  AccountReadResponse,
  ConfigReadResponse,
  HooksListResponse,
  InitializeResponse,
  ItemCompleted,
  MODEL_ITEMS,
  ModelListResponse,
  RateLimitsReadResponse,
  RateLimitsUpdated,
  ThreadResponse,
  ThreadTurnsPage,
  TokenUsageUpdated,
  TurnCompleted,
  TurnStarted,
  TurnStartResponse,
} from './codex-protocol';

/** JSON carries every integer as a number; ts-rs writes a 64-bit one as bigint. */
type Wire<T> = T extends bigint
  ? number
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

// Everything the pinned Codex can send for a method, 10db's schema accepts.
expectTypeOf<Wire<GeneratedInitializeResponse>>().toExtend<z.input<typeof InitializeResponse>>();
expectTypeOf<Wire<GetAccountResponse>>().toExtend<z.input<typeof AccountReadResponse>>();
expectTypeOf<Wire<GetAccountRateLimitsResponse>>().toExtend<
  z.input<typeof RateLimitsReadResponse>
>();
expectTypeOf<Wire<AccountRateLimitsUpdatedNotification>>().toExtend<
  z.input<typeof RateLimitsUpdated>
>();
expectTypeOf<Wire<GeneratedModelListResponse>>().toExtend<z.input<typeof ModelListResponse>>();
expectTypeOf<Wire<GeneratedConfigReadResponse>>().toExtend<z.input<typeof ConfigReadResponse>>();
// timeoutSec is a bigint in the generated type and a number on the wire.
expectTypeOf<Wire<GeneratedHooksListResponse>>().toExtend<z.input<typeof HooksListResponse>>();
expectTypeOf<Wire<ThreadStartResponse>>().toExtend<z.input<typeof ThreadResponse>>();
expectTypeOf<Wire<ThreadResumeResponse>>().toExtend<z.input<typeof ThreadResponse>>();
expectTypeOf<Wire<GeneratedTurnStartResponse>>().toExtend<z.input<typeof TurnStartResponse>>();
expectTypeOf<Wire<TurnStartedNotification>>().toExtend<z.input<typeof TurnStarted>>();
expectTypeOf<Wire<TurnCompletedNotification>>().toExtend<z.input<typeof TurnCompleted>>();
expectTypeOf<Wire<ThreadTokenUsageUpdatedNotification>>().toExtend<
  z.input<typeof TokenUsageUpdated>
>();
expectTypeOf<Wire<ItemCompletedNotification>>().toExtend<z.input<typeof ItemCompleted>>();
expectTypeOf<Wire<ThreadTurnsListResponse>>().toExtend<z.input<typeof ThreadTurnsPage>>();

const GENERATED = join(import.meta.dirname, 'codex-generated');

/** Each generated type whose payloads `generate:codex` samples, and the runtime schema that reads it. */
const ROWS: readonly { readonly type: string; readonly runtime: z.ZodType }[] = [
  { type: 'InitializeResponse', runtime: InitializeResponse },
  { type: 'GetAccountResponse', runtime: AccountReadResponse },
  { type: 'GetAccountRateLimitsResponse', runtime: RateLimitsReadResponse },
  { type: 'AccountRateLimitsUpdatedNotification', runtime: RateLimitsUpdated },
  { type: 'ModelListResponse', runtime: ModelListResponse },
  { type: 'ConfigReadResponse', runtime: ConfigReadResponse },
  { type: 'HooksListResponse', runtime: HooksListResponse },
  { type: 'ThreadStartResponse', runtime: ThreadResponse },
  { type: 'ThreadResumeResponse', runtime: ThreadResponse },
  { type: 'TurnStartResponse', runtime: TurnStartResponse },
  { type: 'TurnStartedNotification', runtime: TurnStarted },
  { type: 'TurnCompletedNotification', runtime: TurnCompleted },
  { type: 'ThreadTokenUsageUpdatedNotification', runtime: TokenUsageUpdated },
  { type: 'ItemCompletedNotification', runtime: ItemCompleted },
  { type: 'ThreadTurnsListResponse', runtime: ThreadTurnsPage },
];

/**
 * Item types in `MODEL_ITEMS` that the pinned Codex does not have, each with the version it was
 * checked on. A name the pin gains comes off this list.
 */
const ABSENT_FROM_PIN: ReadonlySet<string> = new Set<string>();

const JsonSchemaFile = z.record(z.string(), z.unknown());
const FixtureFile = z.array(z.unknown());

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function schemaFile(type: string): z.ZodType {
  return z.fromJSONSchema(
    JsonSchemaFile.parse(readJson(join(GENERATED, 'schema', `${type}.json`))),
  );
}

function fixtureFile(type: string): unknown[] {
  return FixtureFile.parse(readJson(join(GENERATED, 'fixtures', `${type}.json`)));
}

const ThreadItemTypes = z.object({
  definitions: z.object({
    ThreadItem: z.object({
      oneOf: z.array(
        z.object({ properties: z.object({ type: z.object({ enum: z.array(z.string()) }) }) }),
      ),
    }),
  }),
});

describe('the runtime Codex schemas', () => {
  it.each(ROWS)('read every payload the generated schema allows for $type', ({ type, runtime }) => {
    const generated = schemaFile(type);
    const payloads = fixtureFile(type);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(generated.safeParse(payload).success, JSON.stringify(payload)).toBe(true);
      expect(runtime.safeParse(payload).success, JSON.stringify(payload)).toBe(true);
    }
  });

  it('has a fixture file for every row, and a row for every fixture file', () => {
    const fixtures = readdirSync(join(GENERATED, 'fixtures'))
      .map((name) => name.replace(/\.json$/, ''))
      .sort();
    expect(fixtures).toEqual(ROWS.map((row) => row.type).sort());
  });

  it('names in MODEL_ITEMS only item types the pinned Codex has, apart from the ones known absent', () => {
    const document = ThreadItemTypes.parse(
      readJson(join(GENERATED, 'schema', 'ItemCompletedNotification.json')),
    );
    const itemTypes = new Set(
      document.definitions.ThreadItem.oneOf.flatMap((branch) => branch.properties.type.enum),
    );
    expect([...MODEL_ITEMS].filter((t) => !itemTypes.has(t) && !ABSENT_FROM_PIN.has(t))).toEqual(
      [],
    );
    expect([...ABSENT_FROM_PIN].filter((t) => itemTypes.has(t))).toEqual([]);
  });
});
