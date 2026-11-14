import {
  ShapeMessageAuthor,
  ShapeMessageKind,
  TaskMessageAuthor,
  TaskMessageKind,
  ToolCallView,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  planLinePreview,
  shapeItemOf,
  shapeMessageOf,
  taskItemOf,
  taskMessageOf,
} from './transcript-kinds';

const AT = '2026-11-12T10:00:00.000Z';

describe('a Plan row through an item and back', () => {
  const rows = Object.values(ShapeMessageKind).flatMap((kind) =>
    Object.values(ShapeMessageAuthor).map((author) => ({ author, kind })),
  );
  it.each(rows)('$author $kind', ({ author, kind }) => {
    const m = { author, kind, body: 'Read · src/a.ts', createdAt: AT };
    expect(shapeMessageOf(shapeItemOf(m, 'c'))).toEqual({ author, kind, body: m.body });
  });
});

describe('a thread row through an item and back', () => {
  const rows = Object.values(TaskMessageKind).flatMap((kind) =>
    Object.values(TaskMessageAuthor).map((author) => ({ author, kind })),
  );
  it.each(rows)('$author $kind', ({ author, kind }) => {
    const m = { author, kind, body: 'hello' };
    expect(taskMessageOf(taskItemOf(m))).toEqual(m);
  });
});

describe('planLinePreview', () => {
  it('keeps 100 code points, which an other call’s preview accepts', () => {
    const line = '🙂'.repeat(150);
    const preview = planLinePreview(line);
    expect(Array.from(preview)).toHaveLength(100);
    const item = shapeItemOf(
      { author: 'claude', kind: 'tool', body: line, createdAt: AT },
      'toolu_1',
    );
    expect(ToolCallView.parse(item.body)).toMatchObject({
      kind: 'other',
      title: line,
      inputPreview: preview,
    });
  });
});
