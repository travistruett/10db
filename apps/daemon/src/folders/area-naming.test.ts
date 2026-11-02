import { describe, expect, it } from 'vitest';
import { AreaCandidateKind, type AreaCandidate } from './area-candidates';
import { areasFromModel, areasFromStructure, namingPrompt } from './area-naming';

const candidate = (kind: AreaCandidateKind, label: string): AreaCandidate => ({
  kind,
  label,
  globs: [`${label}/**`],
  files: 3,
  trees: [label],
  directs: [],
});

const rest = (): AreaCandidate => ({ ...candidate(AreaCandidateKind.Rest, '.'), globs: ['*'] });

describe('namingPrompt', () => {
  it('says the kind=rest candidate holds every file no other area holds', () => {
    const prompt = namingPrompt([candidate(AreaCandidateKind.Folder, 'a'), rest()]);
    expect(prompt).toContain('kind=rest');
    expect(prompt).toMatch(/kind=rest[^\n]*holds every file no other area holds/u);
  });
});

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

  describe('cut to 300 characters', () => {
    const LONE_SURROGATE = /\p{Cs}/u;
    const EMOJI = String.fromCodePoint(0x1f600);
    const reasonFromModel = (reason: string): string | undefined =>
      areasFromModel(JSON.stringify({ areas: [{ name: 'x', reason, candidates: [1] }] }), [
        candidate(AreaCandidateKind.Folder, 'a'),
      ])?.[0]?.reason;

    it('does not end in half an astral character when one straddles the cut', () => {
      // Code units 298 and 299 are the two halves of the emoji; the cut falls between them.
      const reason = reasonFromModel(`${'a'.repeat(298)}${EMOJI}${'b'.repeat(20)}`);
      expect(reason).not.toMatch(LONE_SURROGATE);
      expect(reason).toBe(`${'a'.repeat(298)}…`);
    });

    it('keeps an astral character that ends just before the cut', () => {
      const reason = reasonFromModel(`${'a'.repeat(297)}${EMOJI}${'b'.repeat(20)}`);
      expect(reason).not.toMatch(LONE_SURROGATE);
      expect(reason).toBe(`${'a'.repeat(297)}${EMOJI}…`);
    });

    it('does not end in half an astral character when a folder label is long', () => {
      const label = `${'a'.repeat(298)}${EMOJI}${'b'.repeat(40)}`;
      for (const area of areasFromStructure([candidate(AreaCandidateKind.Folder, label)])) {
        expect(area.reason, area.name).not.toMatch(LONE_SURROGATE);
      }
    });
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
