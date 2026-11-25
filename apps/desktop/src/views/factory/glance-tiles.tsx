import { Group, Paper, SimpleGrid, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { BarPart } from './factory-summary';
import { BarSwatch } from './stacked-bar';
import { StatusDot } from './status-dot';
import { WaitRing } from './task-line';

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
    <Paper variant="raised" radius="md" px={16} py={14}>
      <Group gap={8} align="baseline">
        <Text
          fz={24}
          fw={600}
          lh={1}
          c={n === 0 ? 'dimmed' : 'bright'}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {n}
        </Text>
        {of === undefined ? null : (
          <Text size="xs" c="dimmed">
            {of}
          </Text>
        )}
      </Group>
      <Group gap={6} mt={12} wrap="nowrap">
        {mark}
        <Text size="xs">{label}</Text>
      </Group>
    </Paper>
  );
}

/** Factory's five figures at a glance: what needs the builder, what broke, what runs, what waits to merge, what merged. */
export function GlanceTiles({ figures: f }: { readonly figures: GlanceFigures }) {
  return (
    <SimpleGrid component="section" aria-label="At a glance" cols={5} spacing={12}>
      <Tile
        n={f.needsYou}
        mark={<WaitRing />}
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
        mark={<BarSwatch part={BarPart.InReview} />}
        label={`${plural(f.inReview, 'pull request')} open`}
      />
      <Tile n={f.merged} mark={<StatusDot color="green" />} label="merged today" />
    </SimpleGrid>
  );
}
