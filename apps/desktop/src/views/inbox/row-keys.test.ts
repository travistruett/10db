import { describe, expect, it } from 'vitest';
import { RowKeyAction, rowKeyAction } from './row-keys';

describe('rowKeyAction: the keys on a focused table row', () => {
  it.each([
    ['Enter opens a closed row', 'Enter', false, RowKeyAction.Expand],
    ['Enter closes an open row', 'Enter', true, RowKeyAction.Collapse],
    ['→ opens a closed row', 'ArrowRight', false, RowKeyAction.Expand],
    ['→ leaves an open row open', 'ArrowRight', true, null],
    ['← closes an open row', 'ArrowLeft', true, RowKeyAction.Collapse],
    ['← leaves a closed row closed', 'ArrowLeft', false, null],
    ['↓ moves to the next row', 'ArrowDown', false, RowKeyAction.Next],
    ['↑ moves to the previous row', 'ArrowUp', true, RowKeyAction.Previous],
    ['another key does nothing', 'a', false, null],
    ['Space does nothing', ' ', false, null],
  ])('%s', (_name, key, expanded, action) => {
    expect(rowKeyAction(key, expanded)).toBe(action);
  });
});
