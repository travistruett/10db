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

  describe('holds no format character (bidi override, zero-width)', () => {
    const FORMAT = /\p{Cf}/u;
    // Right-to-left override, zero-width space and joiner, the four bidi isolates, a BOM.
    const RLO = String.fromCodePoint(0x202e);
    const ZWSP = String.fromCodePoint(0x200b);
    const formats = [0x202e, 0x200b, 0x200d, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff].map((code) =>
      String.fromCodePoint(code),
    );

    it('whatever the folder is called', () => {
      const labels = formats.map((f) => `dir${f}name`);
      const areas = areasFromStructure(labels.map((l) => candidate(AreaCandidateKind.Folder, l)));
      expect(areas).toHaveLength(labels.length);
      for (const area of areas) expect(area.reason, area.name).not.toMatch(FORMAT);
    });

    it('when a model wrote it', () => {
      const candidates = [candidate(AreaCandidateKind.Folder, 'a')];
      const reason = `Holds ${formats.join('')}the${RLO} daemon${ZWSP} code`;
      const areas = areasFromModel(
        JSON.stringify({ areas: [{ name: 'x', reason, candidates: [1] }] }),
        candidates,
      );
      expect(areas?.[0]?.reason).not.toMatch(FORMAT);
      expect(areas?.[0]?.reason).toBe('Holds the daemon code');
    });

    it('is not a reason when nothing but format characters is left', () => {
      const candidates = [candidate(AreaCandidateKind.Folder, 'a')];
      const areas = areasFromModel(
        JSON.stringify({ areas: [{ name: 'x', reason: RLO + ZWSP, candidates: [1] }] }),
        candidates,
      );
      expect(areas).toBeNull();
    });
  });
});
