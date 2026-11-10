import { describe, expect, it } from 'vitest';
import { renderMayRead } from './render-access';

// Shape spec §5.5: a screen is drawn with a token that can read what the screen shows and nothing
// else. It is the 2026-11-02 design review's proxy (GET only, no digest) as a rule the daemon holds.

describe('what a render token may do', () => {
  it('reads the data a screen shows', () => {
    for (const path of [
      '/projects',
      '/projects/prj_1/tasks',
      '/projects/prj_1/batches',
      '/projects/prj_1/goals',
      '/projects/prj_1/shapes',
      '/projects/prj_1/board-columns',
      '/goals/gol_1',
      '/goals/gol_1/shape',
      '/tasks/tsk_1/shape',
      '/tasks/tsk_1/step-plan',
      '/shapes/shp_1',
      '/flows',
      '/workstreams',
      '/inbox',
    ])
      expect(renderMayRead('GET', path), path).toBe(true);
  });

  it('never reads a goal digest, which moves the goal’s last-opened mark', () => {
    expect(renderMayRead('GET', '/goals/gol_1/digest')).toBe(false);
  });

  it('never reads what probes the machine, an account’s login or a lane’s copy', () => {
    for (const path of [
      '/system',
      '/accounts/acc_1/identity',
      '/accounts/acc_1/signin',
      '/workstreams/wks_1/changes',
    ])
      expect(renderMayRead('GET', path), path).toBe(false);
  });

  it('never reads a Workbench pass, its turns or its preview, which no screen draws', () => {
    for (const path of [
      '/passes',
      '/passes/pas_1',
      '/pass-turns/ptn_1/activity',
      '/tasks/tsk_1/turns',
      '/projects/prj_1/pass-start',
      '/goals/gol_1/pass-pages',
    ])
      expect(renderMayRead('GET', path), path).toBe(false);
  });

  it('writes nothing: every other method is refused, on a path it may read', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL'])
      expect(renderMayRead(method, '/projects'), method).toBe(false);
  });

  it('reads nothing a pattern only resembles', () => {
    for (const path of [
      '/projects/prj_1/tasks/extra',
      '/projects/prj_1/tasks/',
      '//projects',
      '/projects/../system',
      '/events/stream',
      '/mcp',
      '/builder/mcp',
      '/shapes/shp_1/files',
      '/health/x',
    ])
      expect(renderMayRead('GET', path), path).toBe(false);
  });
});
