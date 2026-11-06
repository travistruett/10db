import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountKind,
  ScreenName,
  ShapeMessageKind,
  ShapeToolInputs,
  type SeeScreenInput,
  type ShapeId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pngImage, pngOfSize } from '../../test/png';
import {
  createScreens,
  pictureLimitsFor,
  type PictureLimits,
  type ScreenOutcome,
  type ScreenService,
} from '../screens';
import type { FakeShapeTurn } from '../sessions';
import { must } from './conversation-fixture';
import { inlineImageIds, pathImageReasons, pathReasonText } from './dropped-files';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §5.4. A conversation's picture and PDF budget is sized from the request limit of the account it
// runs on: 128 MB on the Claude API, 20 MB on Amazon Bedrock (docs checked 2026-11-05). A resumed session
// resends every earlier picture to the account that resumes it, so an account change between turns, such as
// a plan falling back to Bedrock, is held to the new account's limits too.

const MIB = 1024 * 1024;
const CLAUDE = pictureLimitsFor(AccountKind.ClaudeSubscription);
const BEDROCK = pictureLimitsFor(AccountKind.Bedrock);

let f: ServiceFixture;
afterEach(async () => {
  await f.close();
});
const shapeId = () => f.c.shape.id;

/** A whole 100 x 80 PNG of exactly this many bytes, which the daemon can read the size of. */
const wholePng = (bytes: number): Buffer => {
  const base = pngOfSize(100, 80);
  return pngOfSize(100, 80, bytes - base.length - 12);
};
const PNG = pngOfSize(100, 80);
const drop = (name: string, bytes: Uint8Array) =>
  f.service.addFile(shapeId(), { name, mediaType: '', bytes });

async function nextTurn(text = 'Here you go'): Promise<FakeShapeTurn> {
  const seen: { turn: FakeShapeTurn | null } = { turn: null };
  f.adapter.shapeBehaviour = (turn) => {
    seen.turn = turn;
    return Promise.resolve({ text: 'ok' });
  };
  f.service.send(shapeId(), text);
  await f.service.settled(shapeId());
  return must(seen.turn, 'a turn');
}

const notices = (): string[] =>
  f.service
    .view(shapeId())
    .messages.filter((m) => m.kind === ShapeMessageKind.Notice)
    .map((m) => m.body);

const read = (path: string, pages?: string) =>
  must(f.adapter.shapeSessions[0], 'a session').spec.preToolUse({
    toolName: 'Read',
    input: pages === undefined ? { file_path: path } : { file_path: path, pages },
  });
const reasonOf = (answer: ReturnType<typeof read>): string =>
  answer.decision === 'deny' ? answer.reason : '';

/** A 4000 x 2500 picture of 1 MiB: over the 3000 px side cap, so it goes as a path, and a Read is charged its size. */
const retina = (): Buffer => {
  const base = pngOfSize(4000, 2500);
  return pngOfSize(4000, 2500, MIB - base.length - 12);
};

const drawn = (bytes: number): ScreenOutcome => {
  const image = pngImage(1200, 900);
  return {
    ok: true,
    image: {
      mediaType: 'image/png',
      data: pngImage(1200, 900, bytes - image.length - 12).toString('base64'),
      width: 1200,
      height: 900,
    },
  };
};

describe('the budget on a Claude plan', () => {
  beforeEach(() => {
    f = createServiceFixture();
  });

  it('sends a picture up to the Claude API’s per-image size inline, within an 18 MiB message', async () => {
    // Over the 2 MiB a 32 MB request allowed an image, within the 10 MB as base64 the Claude API takes.
    for (let i = 0; i < 3; i += 1) drop(`big${String(i)}.png`, wholePng(5 * MIB));
    drop('fourth.png', wholePng(5 * MIB));
    const turn = await nextTurn('Four');
    expect(turn.images).toHaveLength(3);
    expect(turn.message).not.toMatch(/too large to show/);
    expect(turn.message).toMatch(
      /fourth\.png\) — left out to keep this message within the image limit; Read it/,
    );
  });

  it('sends a picture of exactly 3000 px a side inline, and one of 3001 px as a path', async () => {
    drop('edge.png', pngOfSize(3000, 2000));
    drop('over.png', pngOfSize(3001, 100));
    const turn = await nextTurn('Both');
    expect(turn.images).toHaveLength(1);
    expect(turn.message).toMatch(/over\.png\) — too large to show inline; Read it/);
    expect(turn.message).not.toMatch(/edge\.png\) — /);
  });

  it('lets Reads fill a pool sized from 128 MB, and refuses the one past it naming that limit', async () => {
    const big = drop('big.png', retina());
    await nextTurn('Hello');
    const pool = (CLAUDE.inlineMaxBytes + CLAUDE.readReserveBytes) / MIB;
    // 84 MiB, where the 32 MB budget held 21.
    for (let i = 0; i < pool; i += 1) expect(read(big.storedPath)).toEqual({ decision: 'allow' });
    const refused = read(big.storedPath);
    expect(refused).toMatchObject({ decision: 'deny' });
    expect(reasonOf(refused)).toContain("the Claude API's 128 MB request limit");
    expect(reasonOf(refused)).not.toMatch(/32 ?MB/);
  });

  it('holds 72 MiB of inline pictures, and says the 128 MB limit when it leaves one out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'limits-'));
    try {
      const storedPath = join(dir, 'p.png');
      writeFileSync(storedPath, PNG);
      const file = { id: 'a', name: 'p.png', size: 3 * MIB, storedPath };
      expect(inlineImageIds([file], 69 * MIB, CLAUDE).has('a')).toBe(true);
      expect(inlineImageIds([file], 69 * MIB + 1, CLAUDE).has('a')).toBe(false);
      const reasons = pathImageReasons([file], [file], 70 * MIB, CLAUDE);
      expect(reasons.get('a')).toBe('conversation-full');
      expect(pathReasonText('conversation-full', CLAUDE)).toContain('128 MB');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the budget on a Bedrock account', () => {
  beforeEach(() => {
    f = createServiceFixture({ accountKind: AccountKind.Bedrock });
  });

  it('sends a picture of 3.5 MiB inline, and a 4 MiB one as a path: Bedrock takes 3.75 MB of one image', async () => {
    drop('fits.png', wholePng(3.5 * MIB));
    drop('over.png', wholePng(4 * MIB));
    const turn = await nextTurn('Both');
    expect(turn.images).toHaveLength(1);
    expect(turn.message).toMatch(/over\.png\) — too large to show inline; Read it/);
  });

  it('keeps a message to 6 MiB of pictures', async () => {
    for (let i = 0; i < 3; i += 1) drop(`m${String(i)}.png`, wholePng(3 * MIB));
    const turn = await nextTurn('Three');
    expect(turn.images).toHaveLength(2);
    expect(turn.message).toMatch(
      /m2\.png\) — left out to keep this message within the image limit/,
    );
  });

  it('tells the builder which pictures the conversation’s total left out, stating the 20 MB limit', async () => {
    for (let i = 0; i < 2; i += 1) drop(`a${String(i)}.png`, wholePng(3 * MIB));
    expect((await nextTurn('One')).images).toHaveLength(2);
    // 6 MiB are carried, so 2 MiB of the 8 MiB total remain: neither 3 MiB picture fits.
    for (let i = 0; i < 2; i += 1) drop(`b${String(i)}.png`, wholePng(3 * MIB));
    const turn = await nextTurn('Two');
    expect(turn.images).toEqual([]);
    expect(turn.message).toContain("within the image limit (Amazon Bedrock's 20 MB request limit)");
    const told = notices().find((body) => body.startsWith('Left out of this message'));
    expect(told).toContain("Amazon Bedrock's 20 MB request limit");
    expect(told).toContain('b0.png, b1.png');
    for (const body of notices()) expect(body).not.toMatch(/32 ?MB/);
  });

  it('refuses the Read past an 11 MiB pool, stating the 20 MB limit', async () => {
    const big = drop('big.png', retina());
    await nextTurn('Hello');
    for (let i = 0; i < 11; i += 1) expect(read(big.storedPath)).toEqual({ decision: 'allow' });
    const refused = read(big.storedPath);
    expect(refused).toMatchObject({ decision: 'deny' });
    expect(reasonOf(refused)).toContain("Amazon Bedrock's 20 MB request limit");
    expect(reasonOf(refused)).not.toMatch(/32 ?MB/);
    // The picture's refusal reaches the builder too, with the same limit.
    expect(notices().some((body) => body.includes("Amazon Bedrock's 20 MB request limit"))).toBe(
      true,
    );
  });

  it('refuses a PDF read by 20 pages, which Bedrock’s pool can’t carry, stating the 20 MB limit', async () => {
    const doc = drop('doc.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1000)]));
    await nextTurn('Hello');
    const refused = read(doc.storedPath, '1-20');
    expect(refused).toMatchObject({ decision: 'deny' });
    expect(reasonOf(refused)).toContain("Amazon Bedrock's 20 MB request limit");
    expect(reasonOf(refused)).toContain('up to 11 pages fit');
    expect(read(doc.storedPath, '1-11')).toEqual({ decision: 'allow' });
  });

  it('refuses a screen past the total, stating the 20 MB limit', async () => {
    // The service holds the screen to the limits of the account its session runs on.
    await f.close();
    const window = ShapeToolInputs.see_screen.parse({ screen: ScreenName.Board, width: 1200 });
    const outcome = drawn(1_500_000);
    // The screens service reads the fixture's own state, which exists only once the fixture does.
    const screens: Pick<ScreenService, 'see'> = {
      see: (id, input, limits) =>
        createScreens({
          state: f.state,
          filesDir: f.filesDir,
          broker: {
            request: () => Promise.resolve(outcome),
            claim: () => Promise.resolve(null),
            deliver: () => false,
            refuse: () => false,
            tokenValid: () => false,
          },
        }).see(id, input, limits),
    };
    f = createServiceFixture({ accountKind: AccountKind.Bedrock, screens });
    for (let i = 0; i < 2; i += 1) drop(`a${String(i)}.png`, wholePng(3 * MIB));
    await nextTurn('Two pictures');
    const session = must(f.adapter.shapeSessions[0], 'a session');
    const tools = f.service.toolsFor({ sessionId: session.spec.sessionId, shapeId: shapeId() });
    const see = must(tools.see_screen, 'see_screen');
    // 6 MiB are carried, and a 1.5 MB screen is 1.43 MiB: one fits in the 8 MiB, a second does not.
    await see(window);
    await expect(see(window)).rejects.toThrow(/Amazon Bedrock's 20 MB request limit/);
  });
});

describe('when the account changes between turns', () => {
  const resumed = (n: number): boolean =>
    must(f.adapter.shapeSessions[n], `session ${String(n)}`).spec.resumeProviderSessionId !== null;
  const freshNotices = (): string[] =>
    notices().filter((body) => body.startsWith('Continued in a fresh session on '));

  beforeEach(() => {
    f = createServiceFixture();
  });

  it('starts from the digest, with no picture, when the pictures sent are more than the new account takes', async () => {
    // 12 MiB on a Claude plan; Bedrock takes 11 MiB of pictures in all.
    for (let i = 0; i < 4; i += 1) drop(`c${String(i)}.png`, wholePng(3 * MIB));
    expect((await nextTurn('Four')).images).toHaveLength(4);
    await f.restart();
    f.launchOn(AccountKind.Bedrock);
    drop('small.png', PNG);
    const turn = await nextTurn('Again');
    expect(resumed(1)).toBe(false);
    const { spec } = must(f.adapter.shapeSessions[1], 'a fresh session');
    expect(spec.prompt).toContain('continues in a fresh session');
    // The new session carries no earlier picture, so it sends only this turn's.
    expect(turn.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }]);
    const told = freshNotices();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('Bedrock');
    expect(told[0]).toContain("Amazon Bedrock's 20 MB request limit");
    expect(told[0]).toMatch(/12\.6 MB/);
    expect(told[0]).not.toMatch(/32 ?MB/);
  });

  it('does not charge the new session for the pictures the old one sent', async () => {
    for (let i = 0; i < 4; i += 1) drop(`c${String(i)}.png`, wholePng(3 * MIB));
    await nextTurn('Four');
    await f.restart();
    f.launchOn(AccountKind.Bedrock);
    for (let i = 0; i < 2; i += 1) drop(`n${String(i)}.png`, wholePng(3 * MIB));
    // 6 MiB fit Bedrock's message and conversation caps only if the 12 MiB of the old session are not carried.
    expect((await nextTurn('Again')).images).toHaveLength(2);
  });

  it('starts from the digest when a picture sent earlier is over the new account’s per-image size', async () => {
    drop('five.png', wholePng(5 * MIB));
    expect((await nextTurn('One')).images).toHaveLength(1);
    await f.restart();
    f.launchOn(AccountKind.Bedrock);
    await nextTurn('Again');
    expect(resumed(1)).toBe(false);
    const told = freshNotices();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/a picture sent earlier is over the 3\.7 MB one image can be there/);
  });

  it('starts from the digest when Reads and screens carried are more than the new account takes', async () => {
    const big = drop('big.png', retina());
    await nextTurn('Hello');
    for (let i = 0; i < 12; i += 1) expect(read(big.storedPath)).toEqual({ decision: 'allow' });
    await f.restart();
    f.launchOn(AccountKind.Bedrock);
    await nextTurn('Again');
    expect(resumed(1)).toBe(false);
    expect(freshNotices()).toHaveLength(1);
  });

  it('resumes the session, saying nothing, when what it carries fits the new account', async () => {
    drop('one.png', wholePng(2 * MIB));
    expect((await nextTurn('One')).images).toHaveLength(1);
    await f.restart();
    f.launchOn(AccountKind.Bedrock);
    await nextTurn('Again');
    expect(resumed(1)).toBe(true);
    expect(freshNotices()).toEqual([]);
  });

  it('resumes a session that began on Bedrock when the account moves to a larger one', async () => {
    await f.close();
    f = createServiceFixture({ accountKind: AccountKind.Bedrock });
    drop('one.png', wholePng(3 * MIB));
    await nextTurn('One');
    await f.restart();
    f.launchOn(AccountKind.AnthropicApiKey);
    await nextTurn('Again');
    expect(resumed(1)).toBe(true);
    expect(freshNotices()).toEqual([]);
  });

  it('holds a live session to the account it runs on, not the one the project has moved to', async () => {
    drop('one.png', PNG);
    await nextTurn('One');
    f.launchOn(AccountKind.Bedrock);
    // The running session is still on the Claude plan, which takes a 5 MiB picture inline.
    drop('five.png', wholePng(5 * MIB));
    expect((await nextTurn('Two')).images).toHaveLength(1);
    expect(f.adapter.shapeSessions).toHaveLength(1);
    expect(freshNotices()).toEqual([]);
  });

  it('holds a screen to the limits of the account its session runs on', async () => {
    await f.close();
    const seen: unknown[] = [];
    f = createServiceFixture({
      accountKind: AccountKind.Bedrock,
      screens: {
        see: (_id: ShapeId, _input: SeeScreenInput, limits: PictureLimits) => {
          seen.push(limits);
          return Promise.reject(new Error('stop'));
        },
      },
    });
    await nextTurn('Hello');
    const session = must(f.adapter.shapeSessions[0], 'a session');
    const tools = f.service.toolsFor({ sessionId: session.spec.sessionId, shapeId: shapeId() });
    await expect(
      must(
        tools.see_screen,
        'see_screen',
      )(ShapeToolInputs.see_screen.parse({ screen: ScreenName.Board, width: 900 })),
    ).rejects.toThrow('stop');
    expect(seen).toEqual([BEDROCK]);
  });
});
