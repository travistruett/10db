import type { JudgeKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { judgeForCall, ReportedMode, startingJudge } from './call-judge';

describe('startingJudge', () => {
  it.each<[string, JudgeKind, boolean, boolean, JudgeKind]>([
    ['native with auto mode starts native', 'native', true, false, 'native'],
    ['native without auto mode starts rules', 'native', false, true, 'rules'],
    ['tendb with a ready judge starts tendb', 'tendb', true, true, 'tendb'],
    ['tendb without one starts rules', 'tendb', true, false, 'rules'],
    ['auto mode off starts rules whatever the capability', 'tendb', false, true, 'rules'],
    ['rules stays rules', 'rules', true, true, 'rules'],
  ])('%s', (_name, capability, autoMode, tendbReady, judge) => {
    expect(startingJudge(capability, autoMode, tendbReady)).toBe(judge);
  });
});

describe('judgeForCall', () => {
  it.each<[string, JudgeKind, ReportedMode | null, boolean, JudgeKind]>([
    ['native with a call in auto mode stays native', 'native', ReportedMode.Auto, true, 'native'],
    ['native with a call outside auto mode is rules', 'native', ReportedMode.Other, false, 'rules'],
    [
      'native with a call outside auto mode falls to tendb when ready',
      'native',
      ReportedMode.Other,
      true,
      'tendb',
    ],
    ['native with no reported mode stays native', 'native', null, true, 'native'],
    ['tendb with a call in auto mode stays tendb', 'tendb', ReportedMode.Auto, true, 'tendb'],
    ['tendb with a call outside auto mode stays tendb', 'tendb', ReportedMode.Other, true, 'tendb'],
    ['tendb with no reported mode stays tendb', 'tendb', null, true, 'tendb'],
    ['rules with a call in auto mode stays rules', 'rules', ReportedMode.Auto, true, 'rules'],
    ['rules with a call outside auto mode stays rules', 'rules', ReportedMode.Other, true, 'rules'],
    ['rules with no reported mode stays rules', 'rules', null, true, 'rules'],
  ])('%s', (_name, session, reported, tendbReady, judge) => {
    expect(judgeForCall(session, reported, tendbReady)).toBe(judge);
  });
});
