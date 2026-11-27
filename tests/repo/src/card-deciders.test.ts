import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cardBuilders, undeclaredBuilders } from './card-builders';
import { repoRoot } from './workspace';

/** Daemon source whose card builders are checked; a test's fixtures are compiled against the same types. */
const SOURCE = 'apps/daemon/src/**/*.ts';

describe('every card builder declares its decider', () => {
  it('finds a builder that declares none and passes one that does', () => {
    const bare = `export const a = { tier: CardTier.Ask, urgency: Urgency.High, title: 'x' };`;
    const declared = `export const a = {
      tier: CardTier.Status,
      closesWhen: BY_ANSWER,
      decision: decidedByBuilder(BuilderOwns.YourHands),
      body: \`\${one} { two\`,
      nested: { decision: 'not this one' },
    };`;
    const decidedInside = `export const a = { tier: CardTier.Ask, nested: { decision: 'inner' } };`;
    const notice = `postNotice(ctx, { tier: CardTier.Notice, line: 'told' });`;
    expect(undeclaredBuilders(bare)).toHaveLength(1);
    expect(undeclaredBuilders(declared)).toHaveLength(0);
    expect(undeclaredBuilders(decidedInside)).toHaveLength(1);
    expect(cardBuilders(notice)).toHaveLength(0);
  });

  it('holds for every card builder in the daemon', () => {
    const undeclared = globSync(SOURCE, { cwd: repoRoot })
      .filter((file) => !file.endsWith('.test.ts'))
      .flatMap((file) =>
        undeclaredBuilders(readFileSync(`${repoRoot}/${file}`, 'utf8')).map(
          (builder) => `${file}:${String(builder.line)}`,
        ),
      );
    expect(undeclared, 'card builders with no `decision` (who decides the card)').toEqual([]);
  });
});
