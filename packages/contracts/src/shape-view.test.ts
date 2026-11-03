import { describe, expect, it } from 'vitest';
import {
  CONTRACT_SCHEMAS,
  mintId,
  ShapeConvertInput,
  ShapeEditInput,
  ShapeUnpinInput,
  ShapeMessageInput,
  ShapeProposalDto,
  ShapeViewDto,
  ShapeAttachmentDto,
  ShapeWithdrawInput,
} from './index';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §4, §11.

const AT = '2026-11-02T12:00:00.000Z';
const shapeId = mintId('Shape');
const source = mintId('ShapeMessage');

const base = {
  id: mintId('ShapeProposal'),
  state: 'pending',
  round: 1,
  pinned: [],
  mark: null,
  sourceMessageIds: [source],
  converted: null,
  createdAt: AT,
  updatedAt: AT,
};

const looseBody = {
  key: 'thin-scrollbars',
  title: 'Thin scrollbars',
  criteria: ['Scrollbars are 6 px'],
  areas: ['desktop'],
  size: 'S',
  ceremony: 'direct',
  sourceMessageIds: [source],
};

describe('a proposal row’s round mark and sources', () => {
  it.each(['new', 'changed', 'moved', null])('takes the mark %j', (mark) => {
    expect(
      ShapeProposalDto.safeParse({ ...base, mark, key: 'a', kind: 'task', body: looseBody })
        .success,
    ).toBe(true);
  });

  it('refuses a mark that is not one of the three', () => {
    expect(
      ShapeProposalDto.safeParse({
        ...base,
        mark: 'stale',
        key: 'a',
        kind: 'task',
        body: looseBody,
      }).success,
    ).toBe(false);
  });
});

describe('ShapeEditInput', () => {
  it('takes the fields to set', () => {
    expect(ShapeEditInput.parse({ fields: { size: 'M' } })).toEqual({ fields: { size: 'M' } });
  });

  it('takes a goal task’s field by its path', () => {
    expect(ShapeEditInput.safeParse({ fields: { 'tasks.density.size': 'M' } }).success).toBe(true);
  });

  it('refuses an edit that sets nothing', () => {
    expect(ShapeEditInput.safeParse({ fields: {} }).success).toBe(false);
  });

  it.each(['key', 'sourceMessageIds', 'kind', 'goalId'])('refuses to edit %s', (field) => {
    expect(ShapeEditInput.safeParse({ fields: { [field]: 'x' } }).success).toBe(false);
  });
});

describe('ShapeUnpinInput', () => {
  it('names a field, or none to unpin the whole row', () => {
    expect(ShapeUnpinInput.parse({ field: 'size' })).toEqual({ field: 'size' });
    expect(ShapeUnpinInput.parse({})).toEqual({});
  });
});

describe('ShapeProposalDto', () => {
  it('parses a row with the body of its kind, defaults applied', () => {
    const row = ShapeProposalDto.parse({
      ...base,
      key: 'thin-scrollbars',
      kind: 'task',
      body: looseBody,
    });
    expect(row.kind).toBe('task');
    if (row.kind === 'task') expect(row.body.dependsOn).toEqual([]);
  });

  it('refuses a body that is not its kind’s', () => {
    expect(
      ShapeProposalDto.safeParse({ ...base, key: 'x', kind: 'decision', body: looseBody }).success,
    ).toBe(false);
  });

  it('carries what a converted row became', () => {
    const goalId = mintId('Goal');
    const row = ShapeProposalDto.parse({
      ...base,
      state: 'accepted',
      key: 'thin-scrollbars',
      kind: 'task',
      body: looseBody,
      converted: { goalId: null, taskIds: [mintId('Task')], decisionId: null },
    });
    expect(row.converted?.taskIds).toHaveLength(1);
    expect(goalId).toBeTruthy();
  });
});

describe('ShapeViewDto', () => {
  it('parses a conversation with its transcript, proposals and turn', () => {
    const view = ShapeViewDto.parse({
      shape: {
        id: shapeId,
        projectId: mintId('Project'),
        title: 'Density',
        state: 'proposed',
        origin: 'app',
        proposeUnlocked: true,
        round: 1,
        createdAt: AT,
        updatedAt: AT,
      },
      messages: [
        { id: source, shapeId, author: 'builder', kind: 'text', body: 'Hi', createdAt: AT },
      ],
      proposals: [{ ...base, key: 'thin-scrollbars', kind: 'task', body: looseBody }],
      heard: ['Thinner scrollbars'],
      files: [
        {
          id: mintId('ShapeFile'),
          shapeId,
          name: 'brief.md',
          mediaType: 'text/markdown',
          size: 12,
          storedPath: '/data/shapes/x/files/brief.md',
          createdAt: AT,
        },
      ],
      turn: { running: false, queued: 0, proposing: false, rehearsing: false },
      sizes: [
        {
          proposalId: mintId('ShapeProposal'),
          key: 'scrollbars',
          size: 'M',
          hours: 2,
          from: 'basis',
          taskId: null,
          actualHours: null,
          missized: false,
        },
      ],
      ceremony: [
        {
          proposalId: base.id,
          key: 'thin-scrollbars',
          ceremony: 'spec',
          reasons: ['one_way_path'],
          skippedByYou: false,
          specWritten: false,
          spec: null,
        },
      ],
      findings: [
        {
          id: mintId('ShapeFinding'),
          shapeId,
          effortKey: 'thin-scrollbars',
          taskKey: null,
          reviewer: 'scope',
          kind: 'finding',
          severity: 'medium',
          text: 'Names no migration',
          state: 'open',
          how: null,
          round: 1,
          taskHash: null,
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      rehearsals: [{ proposalId: base.id, key: 'thin-scrollbars', hash: 'abc', rehearsed: false }],
      preview: {
        lanes: [
          {
            items: [
              {
                key: 'thin-scrollbars',
                title: 'Thin scrollbars',
                startHours: 0,
                endHours: 2,
                existing: false,
                critical: true,
              },
            ],
          },
        ],
        criticalPath: ['thin-scrollbars'],
        clashes: [],
        tasks: 1,
        totalLaneHours: 2,
        scheduleHours: 2,
        nonLaneHoursPerTask: null,
        endEstimateHours: 2,
      },
      attachments: [
        {
          id: mintId('ShapeAttachment'),
          key: 'thin-scrollbars',
          goalId: null,
          taskId: null,
          attachment: { kind: 'mermaid', source: 'flowchart LR\n  a --> b' },
        },
      ],
    });
    expect(view.attachments[0]?.attachment.kind).toBe('mermaid');
    expect(view.preview.criticalPath).toEqual(['thin-scrollbars']);
    expect(view.proposals).toHaveLength(1);
    expect(view.findings[0]?.reviewer).toBe('scope');
    expect(view.ceremony[0]?.reasons).toEqual(['one_way_path']);
    expect(view.sizes[0]?.size).toBe('M');
    expect(view.heard).toEqual(['Thinner scrollbars']);
    expect(view.files[0]?.name).toBe('brief.md');
  });

  it('is in the contract schemas the generator writes', () => {
    expect(Object.keys(CONTRACT_SCHEMAS)).toContain('shape-view-dto');
  });

  it('refuses an attachment whose chart names a URL (§10.3)', () => {
    const attachment = (spec: Record<string, unknown>) =>
      ShapeAttachmentDto.safeParse({
        id: mintId('ShapeAttachment'),
        key: 'thin-scrollbars',
        goalId: null,
        taskId: null,
        attachment: { kind: 'chart', spec },
      }).success;
    expect(attachment({ mark: 'bar', data: { values: [] } })).toBe(true);
    expect(attachment({ mark: 'bar', data: { url: 'https://example.com/x.json' } })).toBe(false);
  });
});

describe('the builder’s actions', () => {
  it.each([
    ['an empty message', () => ShapeMessageInput.safeParse({ text: '' })],
    ['a convert of nothing', () => ShapeConvertInput.safeParse({ proposalIds: [] })],
    ['a withdrawal with no reason', () => ShapeWithdrawInput.safeParse({ reason: '' })],
  ])('refuses %s', (_, parse) => {
    expect(parse().success).toBe(false);
  });

  it('takes a convert that interrupts the turn', () => {
    expect(
      ShapeConvertInput.safeParse({ proposalIds: [mintId('ShapeProposal')], interrupt: true })
        .success,
    ).toBe(true);
  });
});
