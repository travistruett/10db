import { describe, expect, it } from 'vitest';
import { CASES_DIR, CaseTag, loadCases, loadEvalProject, PROJECT_FILE } from './case';

describe('the lane-pipeline eval set', () => {
  const cases = loadCases(CASES_DIR);
  const project = loadEvalProject(PROJECT_FILE);

  it('holds 10 to 15 cases with unique ids and titles', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.length).toBeLessThanOrEqual(15);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.title)).size).toBe(cases.length);
  });

  it('has a case for the plan-detail build and for every lane rule', () => {
    const tags = new Set(cases.flatMap((c) => c.tags));
    for (const tag of Object.values(CaseTag)) expect(tags, tag).toContain(tag);
  });

  it("names only the eval project's areas", () => {
    const areas = new Set(project.areas.map((a) => a.name));
    for (const c of cases) for (const area of c.areas) expect(areas, c.id).toContain(area);
  });
});
