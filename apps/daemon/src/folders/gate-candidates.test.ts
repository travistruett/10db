import { describe, expect, it } from 'vitest';
import { gateCandidates, GateSource, type FolderFiles } from './index';

const NONE: FolderFiles = {
  makefile: null,
  packageJson: undefined,
  lockfiles: [],
  cargoToml: false,
  goMod: false,
};

interface Row {
  readonly name: string;
  readonly files: Partial<FolderFiles>;
  readonly expected: readonly { command: string; source: GateSource }[];
}

const make = (command: string) => ({ command, source: GateSource.Makefile });
const pkg = (command: string) => ({ command, source: GateSource.PackageJson });

const rows: Row[] = [
  {
    name: 'makefile gate',
    files: { makefile: 'gate:\n\tpnpm test' },
    expected: [make('make gate')],
  },
  { name: 'double colon', files: { makefile: 'gate::' }, expected: [make('make gate')] },
  { name: 'prerequisites', files: { makefile: 'gate: lint test' }, expected: [make('make gate')] },
  { name: 'phony only', files: { makefile: '.PHONY: gate' }, expected: [] },
  { name: 'pattern', files: { makefile: '%:' }, expected: [] },
  {
    name: 'order',
    files: { makefile: 'test:\ncheck:\ngate:' },
    expected: [make('make gate'), make('make check'), make('make test')],
  },
  {
    name: 'pnpm by field',
    files: { packageJson: { scripts: { test: 'vitest' }, packageManager: 'pnpm@10.0.0' } },
    expected: [pkg('pnpm test')],
  },
  {
    name: 'yarn by lockfile',
    files: { packageJson: { scripts: { check: 'x' } }, lockfiles: ['yarn.lock'] },
    expected: [pkg('yarn run check')],
  },
  {
    name: 'bun',
    files: { packageJson: { scripts: { test: 'x' } }, lockfiles: ['bun.lock'] },
    expected: [pkg('bun run test')],
  },
  {
    name: 'npm default',
    files: { packageJson: { scripts: { gate: 'x' } } },
    expected: [pkg('npm run gate')],
  },
  {
    name: 'npm placeholder',
    files: { packageJson: { scripts: { test: 'echo "Error: no test specified" && exit 1' } } },
    expected: [],
  },
  {
    name: 'cargo',
    files: { cargoToml: true },
    expected: [{ command: 'cargo test', source: GateSource.Cargo }],
  },
  {
    name: 'go',
    files: { goMod: true },
    expected: [{ command: 'go test ./...', source: GateSource.Go }],
  },
  {
    name: 'several',
    files: {
      makefile: 'test:',
      packageJson: { scripts: { gate: 'x' }, packageManager: 'pnpm@10.0.0' },
      cargoToml: true,
    },
    expected: [
      make('make test'),
      pkg('pnpm run gate'),
      { command: 'cargo test', source: GateSource.Cargo },
    ],
  },
  { name: 'not an object', files: { packageJson: 'x' }, expected: [] },
];

describe('gateCandidates', () => {
  it.each(rows)('$name', ({ files, expected }) => {
    expect(gateCandidates({ ...NONE, ...files })).toEqual(expected);
  });
});
