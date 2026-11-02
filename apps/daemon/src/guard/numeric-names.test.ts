import { describe, expect, it } from 'vitest';
import { expandsIndirectly } from './arithmetic-words';
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
      ['a flag word that is all a variable', 's=1; declare $x r=s; r=y; echo $((s))'],
      ['a flag word in quotes from a variable', 's=1; declare "$x" r=s; echo $((s))'],
      ['a flag word from a substitution', 's=1; local $(echo -n) r=s; echo $((s))'],
      ['a flag word from backticks', 's=1; typeset `echo -n` r=s; echo $((s))'],
      ['a glob that may match a flag file: ?', 'touch ./-n; s=1; declare ?n r=s; echo $((s))'],
      ['a glob that may match a flag file: *', 'touch ./-n; s=1; declare *n r=s; echo $((s))'],
      ['a glob that may match a flag file: [-]', 'touch ./-n; s=1; declare [-]n r=s; echo $((s))'],
      ['a glob in typeset', 'touch ./-n; s=1; typeset ?n r=s; echo $((s))'],
      ['a glob in local', 'touch ./-n; s=1; local ?n r=s; echo $((s))'],
      ['a glob behind command', 'touch ./-n; s=1; command declare ?n r=s; echo $((s))'],
    ];
    it.each(rows)('%s', (_, command) => {
      expect(names(command)).toEqual([]);
    });

    it('does not take a quoted glob character for a glob', () => {
      expect(names("s=1; declare '?n'=1; echo $((s))")).toEqual(['s']);
      expect(names('s=1; declare "*n"=1; echo $((s))')).toEqual(['s']);
      expect(names('s=1; declare x=*; echo $((s))')).toEqual(['s']);
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
      // bash `jobs -x cmd` runs cmd in the current shell, so a builtin it runs can set names
      ['jobs -x getopts', 'OPTARG=1; jobs -x getopts a: o -a x; echo $((OPTARG))'],
      ['hash', 's=1; hash -p x y; echo $((s))'],
    ];
    it.each(rows)('%s', (_, command) => {
      expect(names(command)).toEqual([]);
    });
  });

  describe('zsh indirection and evaluation flags can reach a name', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['${(P)name}', 's=1; r=s; echo ${(P)r}; echo $((s))'],
      ['${(P)name} in quotes', 's=1; r=s; echo "${(P)r}"; echo $((s))'],
      ['${(P@)name}', 's=1; r=s; echo ${(P@)r}; echo $((s))'],
      ['${(kP)name}', 's=1; r=s; echo ${(kP)r}; echo $((s))'],
      ['${(P)name} in a substitution', 's=1; echo $(echo ${(P)r}); echo $((s))'],
      ['${(e)name} evaluates the value', 's=1; echo ${(e)r}; echo $((s))'],
      ['${(%)name} expands the value as a prompt', 's=1; echo ${(%)r}; echo $((s))'],
      ['${(L)name::=x} assigns', "s=1; : ${(L)s::='a[$(touch y)]'}; echo $((s))"],
      ['${(A)name=x} assigns', 's=1; : ${(A)s=x}; echo $((s))'],
      ['${=name::=x} assigns', 's=1; : ${=s::=x}; echo $((s))'],
      ['${^name:=x} assigns', 's=1; : ${^s:=x}; echo $((s))'],
      ['${~name=x} assigns', 's=1; : ${~s=x}; echo $((s))'],
      ['${+name} with flags and a prefix', 's=1; : ${(U)==s::=x}; echo $((s))'],
      ['${#name::=x} assigns', 's=1; : ${#s::=x}; echo $((s))'],
      // A word holding `(` makes the parse uncertain today, so these give up; the rows pin it.
      ['a glob qualifier runs code', "s=1; echo /*(e:'s=x':); echo $((s))"],
      ['a glob qualifier in a longer word', "s=1; echo /tmp/*.log(Ne:'s=x':); echo $((s))"],
      ['a glob qualifier calls a function', 's=1; echo /*(+f); echo $((s))'],
      ['a glob qualifier with other flags first', 's=1; echo /*(.+f); echo $((s))'],
    ];
    it.each(rows)('%s', (_, command) => {
      expect(names(command)).toEqual([]);
    });

    it('reaches a name from a positional parameter, which no assignment in the command names', () => {
      expect(names('s=1; echo ${(P)1}; echo $((s))')).toEqual([]);
      expect(names('s=1; echo ${(P)${1}}; echo $((s))')).toEqual([]);
    });

    it('expandsIndirectly reads the zsh flags that look a name up or evaluate the value', () => {
      for (const word of ['${(P)r}', '"${(P)r}"', '${(P@)r}', '${(kP)r}', '${(e)r}', '${(%)r}'])
        expect(expandsIndirectly(word), word).toBe(true);
      for (const word of ['${(U)r}', '${(j:,:)r}', '${r}', '${!r}x'.replace('!', '')])
        expect(expandsIndirectly(word), word).toBe(false);
      expect(expandsIndirectly('${!r}')).toBe(true);
    });
  });

  describe('a zsh builtin or keyword the scan does not understand', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['print -v', 's=1; print -v s x; echo $((s))'],
      ['print -v joined', 's=1; print -vs x; echo $((s))'],
      ['print -rv', 's=1; print -rv s x; echo $((s))'],
      ['vared', 's=1; vared s; echo $((s))'],
      ['zparseopts', 's=1; zparseopts -E -D -- a=s; echo $((s))'],
      ['getln', 's=1; getln s; echo $((s))'],
      ['strftime -s', 's=1; strftime -s s %Y 0; echo $((s))'],
      ['zstat -A', 's=1; zstat -A a x; echo $((s))'],
      ['autoload', 's=1; autoload -U f; f; echo $((s))'],
      ['functions', 's=1; functions f=g; f; echo $((s))'],
      ['unfunction', 's=1; unfunction f; echo $((s))'],
      ['zmodload', 's=1; zmodload zsh/datetime; echo $((s))'],
      ['setopt', 's=1; setopt PROMPT_SUBST; echo $((s))'],
      ['emulate', 's=1; emulate -L sh; echo $((s))'],
      ['sysread', 's=1; sysread -s 1 s; echo $((s))'],
      ['zle', 's=1; zle -N w; echo $((s))'],
      ['noglob', 's=1; noglob eval "s=x"; echo $((s))'],
      ['nocorrect', 's=1; nocorrect eval "s=x"; echo $((s))'],
      ['sched', 's=1; sched +1 "s=x"; echo $((s))'],
      ['compdef', 's=1; compdef _f g; echo $((s))'],
      ['zsh -c', 's=1; zsh -c "s=x"; echo $((s))'],
      ['behind command', 's=1; command vared s; echo $((s))'],
      ['behind a runner', 's=1; env -i print -v s x; echo $((s))'],
      ['print -v behind repeat', "s=1; repeat 1 print -vs 'a[$(touch y)]'; echo $((s))"],
      ['printf -v behind repeat', 's=1; repeat 1 printf -vs x; echo $((s))'],
      ['zparseopts behind repeat', 's=1; repeat 1 zparseopts -D -E -- a=s; echo $((s))'],
      ['print -v behind repeat with a counted name', 's=1; repeat $n print -vs x; echo $((s))'],
      ['print -v behind nested repeat', 's=1; repeat 1 repeat 2 print -vs x; echo $((s))'],
      ['print -v behind the - modifier', 's=1; - print -vs x; echo $((s))'],
      ['vared behind the - modifier', 's=1; - vared s; echo $((s))'],
      ['print -v behind command and repeat', 's=1; command - print -vs x; echo $((s))'],
      [
        'print with a flag from a name',
        "s=1; F=-v; N=x; print $F ${N/x/s} 'a[$(touch y)]'; echo $((s))",
      ],
      ['print with a flag from a substitution', 's=1; print $(echo -v) s x; echo $((s))'],
      ['print with a quoted flag from a name', 's=1; print "$F" s x; echo $((s))'],
      ['printf with a flag from a name', 's=1; printf $F s x; echo $((s))'],
      ['print with a flag from backticks', 's=1; print `echo -v` s x; echo $((s))'],
    ];
    it.each(rows)('%s', (_, command) => {
      expect(names(command)).toEqual([]);
    });
  });

  describe('a zsh builtin or keyword the scan reads', () => {
    it('keeps the names of a command using print without -v', () => {
      expect(names('s=1; print -r -- hello; echo $((s))')).toEqual(['s']);
      expect(names('s=1; print hello; whence -p node; echo $((s))')).toEqual(['s']);
      expect(names('s=1; repeat 2 print -r hi; - print hi; echo $((s))')).toEqual(['s']);
      expect(names('s=1; f=x; print -r -- $f; printf %s $f; echo $((s))')).toEqual(['s']);
      expect(names('s=1; echo ${#f} ${=f} ${#s} ${=s}; echo $((s))')).toEqual(['s']);
      expect(names('s=1; print - $f; print -r hi $f; echo $((s))')).toEqual(['s']);
    });

    it('reads integer and float like declare', () => {
      expect(names('s=1; integer n=2; echo $((s))')).toEqual(['s']);
      expect(names('s=1; float f=2; echo $((s))')).toEqual(['s']);
      expect(names('n=1; s=1; integer n; echo $((n + s))')).toEqual(['s']);
      expect(names('s=1; integer -n r=s; r=x; echo $((s))')).toEqual([]);
      expect(names('s=1; typeset -n r=s; echo $((s))')).toEqual([]);
    });

    it('reads repeat, which runs the command after its count, and gives up on foreach', () => {
      // `foreach f (a b)` sets `f` from a word list the scan does not read.
      expect(names('s=1; foreach f (a b); echo $f; end; echo $((s))')).toEqual([]);
      expect(names('s=1; foreach s (a b); echo $s; end; echo $((s))')).toEqual([]);
      expect(names('s=1; repeat 2 echo hi; echo $((s))')).toEqual(['s']);
      expect(names('s=1; repeat 2 s=x; echo $((s))')).toEqual([]);
    });
  });

  describe('a builtin or keyword that sets a name it does not name as a word', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['read with no name sets REPLY', 'REPLY=1; read < f; echo $((REPLY))'],
      ['read -r with no name', 'REPLY=1; read -r < f; echo $((REPLY))'],
      ['select sets REPLY', 'REPLY=1; select x in a b; do break; done < f; echo $((REPLY))'],
      ['=~ sets BASH_REMATCH', 'BASH_REMATCH=1; [[ x =~ y ]]; echo $((BASH_REMATCH))'],
      ['=~ sets zsh MATCH', 'MATCH=1; [[ x =~ y ]]; echo $((MATCH))'],
      ['=~ sets zsh match', 'match=1; [[ x =~ y ]]; echo $((match))'],
      ['=~ sets zsh MBEGIN', 'MBEGIN=1; [[ x =~ y ]]; echo $((MBEGIN))'],
      ['=~ sets zsh MEND', 'MEND=1; [[ x =~ y ]]; echo $((MEND))'],
      ['cd sets PWD and OLDPWD', 'PWD=1; OLDPWD=1; cd x; echo $((PWD + OLDPWD))'],
      ['zsh read -A with no name sets reply', 'reply=1; read -A < f; echo $((reply))'],
      ['zsh read -c with no name sets reply', 'reply=1; read -c < f; echo $((reply))'],
      ['zsh cd sets dirstack', 'dirstack=1; cd x; echo $((dirstack))'],
      ['zsh pushd sets dirstack', 'dirstack=1; pushd x; echo $((dirstack))'],
    ];
    it.each(rows)('%s', (_, command) => {
      expect(names(command)).toEqual([]);
    });

    it('keeps the other names of such a command', () => {
      expect(names('s=1; REPLY=1; read < f; echo $((s))')).toEqual(['s']);
      expect(names('s=1; MATCH=1; [[ x =~ y ]]; echo $((s))')).toEqual(['s']);
    });
  });
});
