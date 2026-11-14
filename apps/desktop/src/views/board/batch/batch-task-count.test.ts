import { mintId, type WorkstreamDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchDto, workstreamDto } from '../../../test/fixtures';
import { batchTaskCount } from './batch-task-count';

const batch = batchDto();
const member = (state: WorkstreamDto['state'], of = batch) =>
  workstreamDto({ batchId: of.id, projectId: of.projectId, state });

describe('batchTaskCount', () => {
  it('counts a task once, by its latest run, and leaves out cancelled runs', () => {
    const first = member('FAILED');
    const retried = workstreamDto({ ...first, id: workstreamDto().id, state: 'RUNNING' });
    expect(batchTaskCount(batch, [first, retried, member('CANCELLED'), member('DONE')])).toBe(2);
  });

  it("counts a pass's pages as one, which share the UI Workbench's branch, not a batch's", () => {
    const pass = batchDto({ passId: mintId('Pass') });
    expect(batchTaskCount(pass, [member('RUNNING', pass), member('WAITING_HUMAN', pass)])).toBe(1);
  });

  it('ignores the runs of other batches', () => {
    const other = batchDto();
    expect(batchTaskCount(batch, [member('RUNNING'), member('RUNNING', other)])).toBe(1);
  });
});
