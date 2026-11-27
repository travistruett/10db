import { SimpleGrid } from '@mantine/core';
import { StatTile } from '../../shell/stat-tile';
import { BarPart } from './factory-summary';
import { BarSwatch } from './stacked-bar';
import { StatusDot } from './status-dot';

export interface GlanceFigures {
  readonly needsYou: number;
  readonly failed: number;
  readonly causes: number;
  readonly running: number;
  /** The Mac's lane cap across projects; null while it loads. */
  readonly laneCap: number | null;
  readonly queued: number;
  readonly inReview: number;
  readonly merged: number;
}

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/** Factory's five figures at a glance: what needs the builder, what broke, what runs, what waits to merge, what merged. */
export function GlanceTiles({
  figures: f,
  cols = 5,
}: {
  readonly figures: GlanceFigures;
  /** How many tiles sit in a row: five in the window, two on the phone. */
  readonly cols?: number;
}) {
  return (
    <SimpleGrid component="section" aria-label="At a glance" cols={cols} spacing={12}>
      <StatTile
        n={f.needsYou}
        mark={<StatusDot color="yellow" />}
        label={`${plural(f.needsYou, 'run waits', 'runs wait')} on you`}
      />
      <StatTile
        n={f.failed}
        mark={<StatusDot color="red" />}
        label={
          f.failed === 0 ? 'failed' : `failed, in ${String(f.causes)} ${plural(f.causes, 'cause')}`
        }
      />
      <StatTile
        n={f.running}
        of={f.laneCap === null ? undefined : `of ${String(f.laneCap)} lanes`}
        mark={<StatusDot color="blue" />}
        label={f.queued > 0 ? `running · ${String(f.queued)} queued` : 'running'}
      />
      <StatTile
        n={f.inReview}
        mark={<BarSwatch part={BarPart.InReview} />}
        label={`${plural(f.inReview, 'pull request')} open`}
      />
      <StatTile n={f.merged} mark={<StatusDot color="green" />} label="merged today" />
    </SimpleGrid>
  );
}
