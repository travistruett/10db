import type { JudgeKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { judgeForCall, ReportedMode, startingJudge } from './call-judge';

describe('startingJudge', () => {
  it.each<[JudgeKind, boolean, JudgeKind]>([
    ['native', true, 'native'],
    ['native', false, 'rules'],
    ['tendb', true, 'tendb'],
    ['tendb', false, 'rules'],
    ['rules', true, 'rules'],
    ['rules', false, 'rules'],
  ])('%s with auto mode %s starts on %s', (capability, autoMode, judge) => {
    expect(startingJudge(capability, autoMode)).toBe(judge);
  });
});

describe('judgeForCall', () => {
  it.each<[string, JudgeKind, ReportedMode | null, JudgeKind]>([
    ['native with a call in auto mode stays native', 'native', ReportedMode.Auto, 'native'],
    ['native with a call outside auto mode is rules', 'native', ReportedMode.Other, 'rules'],
    ['native with no reported mode stays native', 'native', null, 'native'],
    ['tendb with a call in auto mode stays tendb', 'tendb', ReportedMode.Auto, 'tendb'],
    ['tendb with a call outside auto mode is rules', 'tendb', ReportedMode.Other, 'rules'],
    ['tendb with no reported mode stays tendb', 'tendb', null, 'tendb'],
    ['rules with a call in auto mode stays rules', 'rules', ReportedMode.Auto, 'rules'],
    ['rules with a call outside auto mode stays rules', 'rules', ReportedMode.Other, 'rules'],
    ['rules with no reported mode stays rules', 'rules', null, 'rules'],
  ])('%s', (_name, session, reported, judge) => {
    expect(judgeForCall(session, reported)).toBe(judge);
  });
});
