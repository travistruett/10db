import { describe, expect, it } from 'vitest';
import type { CommittedFile } from '../folders';
import { callRuns, type CallRuns } from './call-runs';

const CHECKOUT = '/w/task-1';

const MAKEFILE = [
  'COMPOSE = docker compose -f app/docker-compose.yml',
  'UNUSED := never',
  '',
  'migration:',
  '\t$(COMPOSE) exec backend python manage.py makemigrations $(APP)',
  '',
  'client:',
  '\t$(MAKE) -C app api-client',
  '',
  'deep: d1',
  'd1: d2',
  'd2: d3',
  'd3:',
  '\techo d3',
  '',
].join('\n');
const APP_MAKEFILE = [
  'api-client: schema',
  '\t@cd .. && sh app/gen.sh',
  '',
  'schema:',
  '\tpython manage.py spectacular --file schema.json',
  '',
].join('\n');
const GEN = 'openapi-generator generate -i schema.json\n';
const GATE_QUERY = '#!/usr/bin/env python3\nimport argparse\n';
const SCRIPT = 'echo x\n';
const HALF = `# ${'x'.repeat(15_000)}\n`;

const FILES: Record<string, CommittedFile> = {
  Makefile: { kind: 'same', text: MAKEFILE },
  'app/Makefile': { kind: 'same', text: APP_MAKEFILE },
  'app/gen.sh': { kind: 'same', text: GEN },
  '.agents/bin/gate-query': { kind: 'same', text: GATE_QUERY },
  'scripts/x.py': { kind: 'same', text: SCRIPT },
  'x.sh': { kind: 'same', text: SCRIPT },
  'sub/x': { kind: 'same', text: SCRIPT },
  'a.sh': { kind: 'same', text: HALF },
  'b.sh': { kind: 'same', text: HALF },
  'differs.sh': { kind: 'differs' },
  'big.sh': { kind: 'same', text: `# ${'x'.repeat(17 * 1024)}\n` },
  'g/GNUmakefile': { kind: 'differs' },
  'g/Makefile': { kind: 'same', text: 'all:\n\techo all\n' },
  'm/makefile': { kind: 'differs', entry: 'Makefile' },
  'm/Makefile': { kind: 'same', text: 'all:\n\techo all\n' },
  'u/makefile': { kind: 'differs', entry: 'MAKEFILE' },
  'u/Makefile': { kind: 'same', text: 'all:\n\techo all\n' },
  'n/makefile': { kind: 'differs' },
  'n/Makefile': { kind: 'same', text: 'all:\n\techo all\n' },
  'both/Makefile': { kind: 'same', text: 'both: a b\n\na:\n\tsh a.sh\n\nb:\n\tsh b.sh\n' },
  'both/a.sh': { kind: 'same', text: HALF },
  'both/b.sh': { kind: 'same', text: HALF },
};
const read = (path: string): Promise<CommittedFile> =>
  Promise.resolve(FILES[path] ?? { kind: 'absent' });

const migration = {
  kind: 'make',
  makefile: 'Makefile',
  target: 'migration',
  prerequisites: [],
  recipe: '$(COMPOSE) exec backend python manage.py makemigrations $(APP)',
  variables: ['COMPOSE = docker compose -f app/docker-compose.yml'],
} as const;
const apiClient = {
  kind: 'make',
  makefile: 'app/Makefile',
  target: 'api-client',
  prerequisites: ['schema'],
  recipe: '@cd .. && sh app/gen.sh',
  variables: [],
} as const;
const schema = {
  kind: 'make',
  makefile: 'app/Makefile',
  target: 'schema',
  prerequisites: [],
  recipe: 'python manage.py spectacular --file schema.json',
  variables: [],
} as const;
const gen = { kind: 'script', path: 'app/gen.sh', text: GEN } as const;
const script = (path: string, text = SCRIPT) => ({ kind: 'script', path, text }) as const;
const step = (target: string, prerequisites: string[], recipe = '') =>
  ({ kind: 'make', makefile: 'Makefile', target, prerequisites, recipe, variables: [] }) as const;
const none: CallRuns = { runs: [], cut: false };

describe('callRuns', () => {
  it('gives the committed text of the make targets and repo scripts a command runs, bounded', async () => {
    const rows: [string, string, string, CallRuns][] = [
      [
        'a target and the variables it uses',
        'make migration APP=accounts',
        '',
        { runs: [migration], cut: false },
      ],
      [
        'make -C, a prerequisite and a script in a recipe',
        'make -C app api-client',
        '',
        { runs: [apiClient, schema, gen], cut: false },
      ],
      [
        '$(MAKE) in a recipe',
        'make -s client',
        '',
        {
          runs: [step('client', [], '$(MAKE) -C app api-client'), apiClient, schema, gen],
          cut: false,
        },
      ],
      [
        'the depth cap',
        'make deep',
        '',
        { runs: [step('deep', ['d1']), step('d1', ['d2']), step('d2', ['d3'])], cut: true },
      ],
      [
        'a repo script with flags',
        '.agents/bin/gate-query --open --json',
        '',
        { runs: [script('.agents/bin/gate-query', GATE_QUERY)], cut: false },
      ],
      [
        'an absolute path in the checkout',
        `${CHECKOUT}/.agents/bin/gate-query | jq .`,
        '',
        { runs: [script('.agents/bin/gate-query', GATE_QUERY)], cut: false },
      ],
      [
        'python3 and a path',
        'python3 scripts/x.py --all',
        '',
        { runs: [script('scripts/x.py')], cut: false },
      ],
      ['sh and a path', 'sh x.sh', '', { runs: [script('x.sh')], cut: false }],
      ['cd, then a script', 'cd sub && ./x', '', { runs: [script('sub/x')], cut: false }],
      ['from a folder of the checkout', '../x.sh', 'sub', { runs: [script('x.sh')], cut: false }],
      [
        'past the total cap',
        'make -C both both',
        '',
        {
          runs: [
            { ...step('both', ['a', 'b']), makefile: 'both/Makefile' },
            { ...step('a', [], 'sh a.sh'), makefile: 'both/Makefile' },
            script('both/a.sh', HALF),
            { ...step('b', [], 'sh b.sh'), makefile: 'both/Makefile' },
          ],
          cut: true,
        },
      ],
      [
        'a Makefile the folder holds where make asks for makefile',
        'make -C m all',
        '',
        { runs: [{ ...step('all', [], 'echo all'), makefile: 'm/Makefile' }], cut: false },
      ],
      ['another case of a makefile name', 'make -C u all', '', none],
      ['a makefile the base lacks', 'make -C n all', '', none],
      [
        'redirections between targets',
        'make migration >/dev/null 2> err.log client 2>&1',
        '',
        {
          runs: [
            migration,
            step('client', [], '$(MAKE) -C app api-client'),
            apiClient,
            schema,
            gen,
          ],
          cut: false,
        },
      ],
      ['a cd joined by ;', 'cd sub; ./x', '', { runs: [script('sub/x')], cut: false }],
      [
        'a subshell that holds both the cd and the call',
        '(cd sub && ./x) && ./x.sh',
        '',
        { runs: [script('sub/x')], cut: false },
      ],
      ['only the first call', 'sh x.sh && ./sub/x', '', { runs: [script('x.sh')], cut: false }],
      ['a cd in a subshell', '(cd sub); ./x', '', none],
      ['a cd that may not run', 'false && cd sub; ./x', '', none],
      ['a cd that failed', 'cd sub || ./x', '', none],
      ['a cd in a pipeline', 'cd sub | cat; ./x', '', none],
      ['a cd in the background', 'cd sub & ./x', '', none],
      ['a cd in a conditional', 'if false; then cd sub; fi; ./x', '', none],
      ['a command that may write the script first', 'cp notes/r.txt x.sh && ./x.sh', '', none],
      ['a checkout before make', 'git checkout other -- Makefile && make migration', '', none],
      ['a substitution in the call', './x.sh "$(cp e x.sh)"', '', none],
      ['a backtick substitution in the call', 'sh x.sh `cp e x.sh`', '', none],
      ['an exported MAKEFLAGS', "export MAKEFLAGS='-f other.mk'; make migration", '', none],
      ['a function named make', 'function make { ./other; }; make migration', '', none],
      ['a changed PATH', 'PATH=.:$PATH; make migration', '', none],
      ['a call in a loop', 'for i in 1 2; do ./x.sh; done', '', none],
      ['an environment prefix', 'FOO=1 ./x.sh', '', none],
      ['make -f', 'make -f o.mk x', '', none],
      ['make with no target', 'make', '', none],
      ['a variable in the program', '$D/x.sh', '', none],
      ['a path out of the repository', '../x.sh', '', none],
      ['a script the checkout changed', './differs.sh', '', none],
      ['a script over the cap', './big.sh', '', none],
      ['a changed GNUmakefile ahead of a Makefile', 'make -C g all', '', none],
      ['python3 -c', "python3 -c 'print(1)'", '', none],
      ['python3 -m', 'python3 -m scripts.x', '', none],
      ['a program on the PATH', 'gate-query --open', '', none],
      ['a cd that can not be read', 'cd "$D" && ./x.sh', '', none],
    ];
    for (const [name, command, dir, expected] of rows)
      expect
        .soft(
          await callRuns(command, dir === '' ? CHECKOUT : `${CHECKOUT}/${dir}`, CHECKOUT, read),
          name,
        )
        .toEqual(expected);
    expect
      .soft(await callRuns('./x.sh', '/elsewhere', CHECKOUT, read), 'outside the checkout')
      .toEqual(none);
  });
});
