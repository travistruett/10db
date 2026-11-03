import { mintId, type ShapeTaskSizeDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { goalHoursLine, sizeLine } from './size-line';

// Shape spec §8: "Sized M (~2 h) · took 5 h of lane time", the actual flagged when it is outside
// one bucket, and "size set by you" for a pinned bucket.

const size = (overrides: Partial<ShapeTaskSizeDto> = {}): ShapeTaskSizeDto => ({
  proposalId: mintId('ShapeProposal'),
  key: 'a',
  size: 'M',
  hours: 2,
  from: 'basis',
  taskId: null,
  actualHours: null,
  missized: false,
  ...overrides,
});

describe('sizeLine', () => {
  it.each([
    ['a proposal sized from its basis', size(), 'Sized M (~2 h)', false],
    ['a fraction of an hour', size({ size: 'S', hours: 0.5 }), 'Sized S (~0.5 h)', false],
    ['a pinned bucket', size({ from: 'pinned' }), 'Sized M (~2 h) · size set by you', false],
    [
      'a finished task inside one bucket',
      size({ taskId: mintId('Task'), actualHours: 2.6 }),
      'Sized M (~2 h) · took 2.6 h of lane time',
      false,
    ],
    [
      'a finished task outside one bucket',
      size({ taskId: mintId('Task'), actualHours: 10, missized: true }),
      'Sized M (~2 h) · took 10 h of lane time',
      true,
    ],
  ])('reads %s', (_name, input, text, flagged) => {
    expect(sizeLine(input)).toEqual({ text, flagged });
  });
});

describe('goalHoursLine', () => {
  it("sums its tasks' hours", () => {
    expect(goalHoursLine([size({ hours: 2 }), size({ hours: 0.5 })])).toBe('~2.5 h of lane time');
    expect(goalHoursLine([])).toBeNull();
  });
});
