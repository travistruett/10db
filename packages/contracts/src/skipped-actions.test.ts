import { describe, expect, it } from 'vitest';
import { mintId } from './ids';
import type { Approval } from './skipped-actions';
import { approvalOf, SkipKind, SkippedActionDto } from './skipped-actions';

const row = {
  id: mintId('SkippedAction'),
  workstreamId: mintId('Workstream'),
  toolName: 'Bash',
  summary: 'vercel deploy --prod',
  kind: 'deploy',
  limit: null,
  reason: 'a deploy',
  source: 'guard',
  approval: 'exact',
  createdAt: '2026-11-13T09:00:00.000Z',
};

describe('SkippedActionDto', () => {
  it('a null limit parses', () => {
    expect(SkippedActionDto.parse(row).limit).toBeNull();
  });

  it('an unknown kind fails', () => {
    expect(SkippedActionDto.safeParse({ ...row, kind: 'shrug' }).success).toBe(false);
  });
});

describe('approvalOf', () => {
  const expected: Readonly<Record<SkipKind, Approval>> = {
    classifier: 'intent',
    escalation: 'exact',
    default_mode_card: 'exact',
    deploy: 'exact',
    web_or_mcp: 'exact',
    unknown_tool: 'exact',
    monitor_socket: 'exact',
    read_outside: 'exact',
    endless_loop: 'exact',
    host: 'seed_host',
    config_write: 'none',
    docker_off: 'none',
    secret_read: 'none',
    editor_config_write: 'none',
    home_rc_write: 'none',
    unread_hazard: 'none',
    hazard_card: 'none',
    monitor_no_command: 'none',
    unread_edit_path: 'none',
    safety_check: 'none',
    question: 'none',
  };
  it.each(Object.values(SkipKind))('%s', (kind) => {
    expect(approvalOf(kind, false)).toBe(expected[kind]);
  });

  it('a classifier denial whose summary was cut is not approvable: the builder never saw all of it', () => {
    expect(approvalOf('classifier', true)).toBe('none');
  });
});
