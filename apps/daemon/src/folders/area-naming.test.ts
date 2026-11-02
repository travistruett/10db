import { describe, expect, it } from 'vitest';
import { AreaCandidateKind, type AreaCandidate } from './area-candidates';
import { areasFromModel, areasFromStructure } from './area-naming';

const candidate = (kind: AreaCandidateKind, label: string): AreaCandidate => ({
  kind,
  label,
  globs: [`${label}/**`],
  files: 3,
  trees: [label],
  directs: [],
});

const rest = (): AreaCandidate => ({ ...candidate(AreaCandidateKind.Rest, '.'), globs: ['*'] });

describe('areasFromStructure names', () => {
  it.each([
    ['the rest comes last', ['root', 'root-files'], 'last'],
    ['the rest comes first', ['root', 'root-files'], 'first'],
    ['folders are named root-files-2', ['root', 'root-files', 'root-files-2'], 'last'],
  ])('gives no two areas one name when %s', (_, folders, place) => {
    const folderCandidates = folders.map((f) => candidate(AreaCandidateKind.Folder, f));
    const all = place === 'first' ? [rest(), ...folderCandidates] : [...folderCandidates, rest()];
    const names = areasFromStructure(all).map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives no two areas one name when folders slug to the same words', () => {
    const names = areasFromStructure(
      ['a/b-c', 'a-b/c', 'x/b-c', 'b_c'].map((f) => candidate(AreaCandidateKind.Folder, f)),
    ).map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('an area reason', () => {
  const CONTROL = /\p{Cc}/u;

  it('holds no control character, whatever the folder is called', () => {
    const labels = [
      'we\u001b[31mird',
      'nul\u0000l',
      'del\u007f',
      'next\u0085line',
      'tab\tnew\nline',
    ];
    const areas = areasFromStructure(labels.map((l) => candidate(AreaCandidateKind.Folder, l)));
    for (const area of areas) expect(area.reason, area.name).not.toMatch(CONTROL);
  });

  it('holds no control character when a model wrote it', () => {
    const candidates = [candidate(AreaCandidateKind.Folder, 'a')];
    const areas = areasFromModel(
      JSON.stringify({
        areas: [
          { name: 'x', reason: 'Bad\u001b[2J \u0000reason\u007f\u0085 here', candidates: [1] },
        ],
      }),
      candidates,
    );
    expect(areas?.[0]?.reason).not.toMatch(CONTROL);
    expect(areas?.[0]?.reason).toContain('reason');
  });
});
