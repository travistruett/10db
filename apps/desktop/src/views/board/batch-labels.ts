import { BatchState } from '@10db/contracts';
import type { MantineColor } from '@mantine/core';

const B = BatchState;

/** DESIGN.md status colors: blue in progress, red failed, green shipped, gray idle or over. */
export const BATCH_COLORS: Readonly<Record<BatchState, MantineColor>> = {
  [B.Cutting]: 'blue',
  [B.Open]: 'blue',
  [B.Shipping]: 'blue',
  [B.Shipped]: 'green',
  [B.Closed]: 'gray',
  [B.Failed]: 'red',
  [B.Abandoned]: 'gray',
};

export const BATCH_LABELS: Readonly<Record<BatchState, string>> = {
  [B.Cutting]: 'Cutting branch',
  [B.Open]: 'Open',
  [B.Shipping]: 'Shipping',
  [B.Shipped]: 'Shipped',
  [B.Closed]: 'Closed: no changes',
  [B.Failed]: 'Not shipped',
  [B.Abandoned]: 'Abandoned',
};
