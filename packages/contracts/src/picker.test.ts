import { describe, expect, it } from 'vitest';
import { mintId } from './ids';
import { PICK_MAX, PickerProposalDto, PickSize } from './picker';

const AT = '2026-10-21T12:00:00.000Z';
const task = {
  id: mintId('Task'),
  projectId: mintId('Project'),
  title: 'T',
  description: '',
  acceptanceCriteria: ['x'],
  areas: ['api'],
  riskTags: [],
  flowId: null,
  landing: { kind: 'base' },
  workspaceMode: 'shared',
  placementReason: null,
  status: 'open',
  boardOrder: 1,
  boardColumnId: null,
  dependsOn: [],
  boardStatus: 'ready',
  workstreamId: null,
  createdAt: AT,
  updatedAt: AT,
};

describe('PickSize', () => {
  it.each([
    { raw: '1', ok: true },
    { raw: String(PICK_MAX), ok: true },
    { raw: '0', ok: false },
    { raw: String(PICK_MAX + 1), ok: false },
    { raw: '2.5', ok: false },
    { raw: 'two', ok: false },
    { raw: undefined, ok: false },
  ])('parses $raw: $ok', ({ raw, ok }) => {
    expect(PickSize.safeParse(raw).success).toBe(ok);
  });
});

describe('PickerProposalDto', () => {
  it('parses a proposal with a left-out candidate whose plan failed', () => {
    const parsed = PickerProposalDto.parse({
      projectId: task.projectId,
      size: 2,
      candidates: [
        {
          task,
          proposed: false,
          resumed: false,
          unblocks: 0,
          claims: [{ kind: 'area', name: 'api' }],
          conflict: 'The standard flow is missing; restart 10db to seed it',
          plan: null,
          planError: 'The standard flow is missing; restart 10db to seed it',
        },
      ],
    });
    expect(parsed.candidates[0]?.planError).toMatch(/standard flow/);
  });
});
