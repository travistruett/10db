import { describe, expect, it } from 'vitest';
import {
  CONTRACT_SCHEMAS,
  mintId,
  ShapeConvertInput,
  ShapeMessageInput,
  ShapeProposalDto,
  ShapeViewDto,
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
      turn: { running: false, queued: 0, proposing: false },
    });
    expect(view.proposals).toHaveLength(1);
    expect(view.heard).toEqual(['Thinner scrollbars']);
  });

  it('is in the contract schemas the generator writes', () => {
    expect(Object.keys(CONTRACT_SCHEMAS)).toContain('shape-view-dto');
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
