import { describe, expect, it } from 'vitest';
import {
  isSettingsSectionKey,
  SETTINGS_SECTIONS,
  SettingsScope,
  firstAppSection,
  SettingsSectionKey,
} from './sections';

const PLANNING_REMAINDER =
  "Not built yet: which persona runs each role, and the project's human members.";

describe('settings sections', () => {
  it('lists every section once, in the order and under the subheads the sidebar shows', () => {
    expect(SETTINGS_SECTIONS.map((s) => [s.scope, s.subhead, s.key, s.label])).toEqual([
      ['project', 'Project', 'general', 'General'],
      ['project', 'Project', 'board-columns', 'Board columns'],
      ['project', 'Planning', 'planning', 'Planning'],
      ['project', 'Planning', 'areas', 'Areas and hazards'],
      ['project', 'Planning', 'routing-rules', 'Who Answers'],
      ['project', 'Agents', 'billing', 'Billing'],
      ['project', 'Agents', 'team', 'Models by role'],
      ['project', 'Agents', 'project-trust', 'Trust'],
      ['project', 'Agents', 'network-hosts', 'Network hosts'],
      ['app', null, 'overview', 'Overview'],
      ['app', 'Models', 'accounts', 'Accounts'],
      ['app', 'Models', 'models', 'Models and scores'],
      ['app', 'Models', 'decisions', 'Decisions'],
      ['app', 'Models', 'personas-and-flows', 'Models by role'],
      ['app', 'Agents', 'lane-permissions', 'Lane permissions'],
      ['app', 'Agents', 'trust', 'Trust'],
      ['app', 'Connections', 'integrations', 'Integrations'],
      ['app', 'Connections', 'people', 'People'],
      ['app', 'This Mac', 'updates', 'Updates'],
      ['app', 'This Mac', 'keep-awake', 'Keep-awake'],
    ]);
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.key)).size).toBe(
      Object.values(SettingsSectionKey).length,
    );
  });

  it('names its scopes project and app', () => {
    expect(SettingsScope).toEqual({ Project: 'project', App: 'app' });
  });

  it("opens the sidebar's app-wide Settings on Overview", () => {
    expect(firstAppSection()).toBe(SettingsSectionKey.Overview);
  });

  it.each([
    { key: 'team', planned: PLANNING_REMAINDER },
    {
      key: 'personas-and-flows',
      planned: 'Not built yet: personas, their instructions and pins, and the flows of steps.',
    },
  ])('says what $key still lacks, with no plan named', ({ key, planned }) => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === key)?.planned).toBe(planned);
  });

  it.each([
    { key: 'overview', planned: false },
    { key: 'planning', planned: false },
    { key: 'general', planned: false },
    { key: 'board-columns', planned: false },
    { key: 'areas', planned: false },
    { key: 'network-hosts', planned: false },
    { key: 'billing', planned: false },
    { key: 'keep-awake', planned: false },
    { key: 'updates', planned: false },
    { key: 'lane-permissions', planned: false },
    { key: 'trust', planned: false },
    { key: 'project-trust', planned: false },
    { key: 'team', planned: true },
    { key: 'routing-rules', planned: false },
    { key: 'integrations', planned: false },
    { key: 'people', planned: false },
    { key: 'accounts', planned: false },
    { key: 'decisions', planned: false },
    { key: 'models', planned: false },
    { key: 'personas-and-flows', planned: true },
  ])('marks $key planned: $planned', ({ key, planned }) => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === key)?.planned !== null).toBe(planned);
  });

  it('lists every section as built, even Team and Personas and flows, whose editors are still to come', () => {
    expect(SETTINGS_SECTIONS.filter((s) => !s.built).map((s) => s.key)).toEqual([]);
  });

  it.each([
    { value: 'general', ok: true },
    { value: 'accounts', ok: true },
    { value: 'General', ok: false },
    { value: 'nope', ok: false },
  ])('recognizes $value as a section: $ok', ({ value, ok }) => {
    expect(isSettingsSectionKey(value)).toBe(ok);
  });
});
