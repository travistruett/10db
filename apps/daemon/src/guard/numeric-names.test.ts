import { describe, expect, it } from 'vitest';
import { numericNames } from './numeric-names';

const names = (command: string): string[] => [...numericNames(command)].sort();

describe('numericNames', () => {
  it('finds names set only to numbers', () => {
    expect(names('s=$(date +%s); make check; echo $(( $(date +%s) - s ))')).toEqual(['s']);
    expect(names('n=5; t=$((n+1)); echo $((t))')).toEqual(['n', 't']);
  });

  it('keeps the names of a read-only check that runs shell builtins it understands', () => {
    expect(names('s=1; cd src && echo $((s)) && test -f x && [[ -f y ]]; pwd')).toEqual(['s']);
    expect(names('s=1; pnpm exec prettier --check x; echo $((s))')).toEqual(['s']);
  });

  describe('a nameref can write any name through another', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['declare -n', "declare -n r=s; s=1; r='a[$(id)]'; echo $((s+1))"],
      ['typeset -n', 's=1; typeset -n r=s; r=x; echo $((s))'],
      ['local -n', 's=1; local -n r=s; r=x; echo $((s))'],
      ['a flag cluster', 's=1; declare -gn r=s; r=x; echo $((s))'],
      ['a cluster ending in n', 's=1; declare -nr r=s; r=x; echo $((s))'],
      ['a flag after the name', 's=1; declare r=s -n; r=x; echo $((s))'],
      ['a plus flag', 's=1; declare +n r; echo $((s))'],
      ['behind command', 's=1; command declare -n r=s; r=x; echo $((s))'],
      ['behind a runner with options', 's=1; env -i declare -n r=s; echo $((s))'],
      ['in a substitution', 's=1; echo $(declare -n r=s); echo $((s))'],
      ['a flag from a variable', 's=1; declare -$f r=s; echo $((s))'],
      ['a flag from a substitution', 's=1; declare "-$(echo n)" r=s; echo $((s))'],
      ['a quoted flag', "s=1; declare '-n' r=s; r=x; echo $((s))"],
    ];
    it.each(rows)('%s', (_, command) => {
      expect(names(command)).toEqual([]);
    });
  });

  describe('indirection and functions can rebind a name', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['${!name}', 's=1; r=s; echo ${!r}; echo $((s))'],
      ['${!name} in quotes', 's=1; r=s; echo "${!r}"; echo $((s))'],
      ['${!name} in a substitution', 's=1; echo $(echo ${!r}); echo $((s))'],
      ['${!name[0]}', 's=1; echo ${!a[0]}; echo $((s))'],
      ['a function', 's=1; f() { s=x; }; f; echo $((s))'],
      ['a function with a keyword', 's=1; function f { s=x; }; f; echo $((s))'],
      ['a function written with a space', 's=1; f () { s=x; }; f; echo $((s))'],
      ['a function on its own lines', 's=1\nf()\n{\n s=x\n}\nf\necho $((s))'],
    ];
    it.each(rows)('%s', (_, command) => {
      expect(names(command)).toEqual([]);
    });
  });

  describe('a builtin the scan does not understand', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['printf -v', 's=1; printf -v s %s x; echo $((s))'],
      ['printf -v joined', 's=1; printf -vs %s x; echo $((s))'],
      ['mapfile callback', "s=1; mapfile -C 'eval x' -c 1 a < f; echo $((s))"],
      ['enable', 's=1; enable -f ./x.so y; echo $((s))'],
      ['command eval', 's=1; command eval "s=x"; echo $((s))'],
      ['exec eval', 's=1; exec eval "s=x"; echo $((s))'],
      ['getopts', 's=1; getopts ab o; echo $((s))'],
      ['hash', 's=1; hash -p x y; echo $((s))'],
    ];
    it.each(rows)('%s', (_, command) => {
      expect(names(command)).toEqual([]);
    });
  });
});
