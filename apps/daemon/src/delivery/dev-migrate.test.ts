import { CardDecider, DecisionRule, type BatchDto } from '@10db/contracts';
import { patchProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { migrateAfterLanding } from './copy-landing-cards';

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness({ defaultRigor: 'standard' });
});
afterEach(() => {
  h.close();
});

/** A landing of one migration file into the base: the commit before it and the commit it made. */
function landing(title: string, file: string): { batch: BatchDto; from: string; to: string } {
  const batch = h.starter.startTask(h.addTask(title).id);
  const from = h.git$('rev-parse', 'HEAD');
  const to = h.commit(file, 'create table notes (id integer);\n');
  return { batch, from, to };
}

function setMigrate(command: string | null): void {
  h.store.write((w) => patchProject(w, h.project.id, { migrateCommand: command }));
}

const land = (l: { batch: BatchDto; from: string; to: string }) =>
  migrateAfterLanding(h.ctx, l.batch, h.project, l.from, l.to, new AbortController().signal);

describe('a landing that brings migrations', () => {
  it("runs the project's migrate command in its folder and posts an Activity row, with no card", async () => {
    setMigrate('echo "applied from $(pwd)"');
    await land(landing('Notes', 'db/migrations/0042_notes.sql'));

    expect(h.cards()).toEqual([]);
    const notice = h.only(h.notices().filter((n) => n.key.startsWith('migrate-after-landing:')));
    expect(notice.body).toContain('db/migrations/0042_notes.sql');
    expect(notice.body).toContain(`applied from ${h.repo}`);
    expect(notice.decision).toMatchObject({
      by: CardDecider.Rule,
      rule: DecisionRule.MigrateAfterLanding,
      undo: { state: 'final' },
    });
  });

  it('raises one card with the output when the command fails, however often the landing is seen', async () => {
    setMigrate('echo "relation notes already exists"; exit 3');
    const l = landing('Notes', 'db/migrations/0042_notes.sql');
    await land(l);
    await land(l);

    const card = h.only(h.cards());
    expect(card.title).toContain('failed after "Notes" landed');
    expect(card.body).toContain('exited 3');
    expect(card.body).toContain('relation notes already exists');
    expect(h.notices().filter((n) => n.key.startsWith('migrate-after-landing:'))).toEqual([]);
  });

  it('asks once per project how it migrates when no command is declared', async () => {
    await land(landing('Notes', 'db/migrations/0042_notes.sql'));
    const asked = h.only(h.cards());
    expect(asked.title).toBe(`Tell 10db how ${h.project.name} migrates`);
    h.inbox.resolve(asked.id, 'answered');

    await land(landing('Tags', 'db/migrations/0043_tags.sql'));
    expect(h.cards()).toEqual([]);
  });

  it('runs nothing for a landing that brings no migrations', async () => {
    setMigrate('exit 1');
    await land(landing('Copy', 'src/ui/copy.ts'));
    expect(h.cards()).toEqual([]);
  });
});
