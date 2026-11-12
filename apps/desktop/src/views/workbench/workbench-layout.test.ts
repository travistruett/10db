import { describe, expect, it } from 'vitest';
import { WorkbenchLayout, workbenchLayout } from './workbench-layout';

describe('workbenchLayout', () => {
  it.each<{ name: string; width: number; layout: WorkbenchLayout }>([
    { name: 'a window beside the browser is narrow', width: 480, layout: WorkbenchLayout.Narrow },
    { name: 'one pixel short of the fold is narrow', width: 899, layout: WorkbenchLayout.Narrow },
    { name: 'the fold itself is wide', width: 900, layout: WorkbenchLayout.Wide },
    { name: 'a full window is wide', width: 1280, layout: WorkbenchLayout.Wide },
    { name: 'a window not yet measured is narrow', width: 0, layout: WorkbenchLayout.Narrow },
  ])('$name', ({ width, layout }) => {
    expect(workbenchLayout(width)).toBe(layout);
  });
});
