import type { ReactNode } from 'react';
import classes from './factory-overview.module.css';
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

function Tile({
  n,
  of,
  mark,
  label,
}: {
  readonly n: number;
  readonly of?: string | undefined;
  readonly mark: ReactNode;
  readonly label: string;
}) {
  return (
    <div className={classes['tile']}>
      <div className={classes['tileFigure']}>
        <span className={classes['tileNumber']}>{n}</span>
        {of === undefined ? null : <span className={classes['tileOf']}>{of}</span>}
      </div>
      <div className={classes['tileLabel']}>
        {mark}
        {label}
      </div>
    </div>
  );
}

/** Factory's five figures at a glance: what needs the builder, what broke, what runs, what waits to merge, what merged. */
export function GlanceTiles({ figures: f }: { readonly figures: GlanceFigures }) {
  return (
    <section aria-label="At a glance" className={classes['tiles']}>
      <Tile
        n={f.needsYou}
        mark={<span className={classes['ring']} />}
        label={`${plural(f.needsYou, 'needs', 'need')} you`}
      />
      <Tile
        n={f.failed}
        mark={<StatusDot color="red" />}
        label={
          f.failed === 0 ? 'failed' : `failed, in ${String(f.causes)} ${plural(f.causes, 'cause')}`
        }
      />
      <Tile
        n={f.running}
        of={f.laneCap === null ? undefined : `of ${String(f.laneCap)} lanes`}
        mark={<StatusDot color="blue" />}
        label={f.queued > 0 ? `running · ${String(f.queued)} queued` : 'running'}
      />
      <Tile
        n={f.inReview}
        mark={<span className={classes['swatch']} data-part="in_review" />}
        label={`${plural(f.inReview, 'pull request')} open`}
      />
      <Tile n={f.merged} mark={<StatusDot color="green" />} label="merged today" />
    </section>
  );
}
