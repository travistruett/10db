import { describe, expect, it } from 'vitest';
import { startsEndlessBackgroundLoop } from './background-loops';

const ENDLESS: readonly (readonly [string, string])[] = [
  ['the incident: busy loops in a subshell', '(while :; do :; done) &'],
  [
    'twelve of them from a for loop, then the tests',
    'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do (while :; do :; done) & done; pnpm test',
  ],
  ['a while true loop backgrounded', 'while true; do x=1; done &'],
  ['a loop split over lines', 'while :\ndo :\ndone &'],
  ['a loop with a redirection before the ampersand', 'while :; do x; done 2>&1 &'],
  ['yes, which never ends', 'yes > /dev/null &'],
  ['yes in a loop', 'while true; do yes > /dev/null; done &'],
  ['yes behind nohup', 'nohup yes >/dev/null 2>&1 &'],
  ['cat of /dev/zero', 'cat /dev/zero > /dev/null &'],
  ['dd with no count', 'dd if=/dev/urandom of=/dev/null &'],
  ['until false', 'until false; do :; done &'],
  ['a test bracket that is always true', 'while [ 1 ]; do :; done &'],
  ['a double bracket', 'while [[ 1 -eq 1 ]]; do :; done &'],
  ['arithmetic that is always true', 'while ((1)); do :; done &'],
  ['a C-style for with no end', 'for ((;;)); do :; done &'],
  ['a brace group', '{ while :; do :; done; } &'],
  ['a zsh disown ampersand', 'while :; do :; done &!'],
  ['a script run by sh -c, backgrounded', 'sh -c "while :; do :; done" &'],
  ['a script run by bash -c with single quotes', "bash -c 'while true; do :; done' &"],
  ['an eval', 'eval "while :; do :; done" &'],
  ['a loop after other work', 'echo start; pnpm test & while :; do :; done &'],
  ['the loop inside a script with its own ampersand', "sh -c 'while :; do :; done &'"],
  ['a python busy loop', "python3 -c 'while True: pass' &"],
  ['a node busy loop', "node -e 'for(;;){}' &"],
  ['a perl busy loop', "perl -e '1 while 1' &"],
  ['coproc', 'coproc while :; do :; done'],
  ['nice with a niceness', 'nice -n 19 yes > /dev/null &'],
  ['nice with a joined niceness', 'nice -n19 yes > /dev/null &'],
  ['env with a cleared environment', 'env -i yes &'],
  ['env unsetting a name, then an assignment', 'env -u HOME A=1 yes &'],
  ['caffeinate holding the Mac awake', 'caffeinate -i yes &'],
  ['caffeinate with a timeout value', 'caffeinate -t 60 yes &'],
  ['stdbuf with a joined mode', 'stdbuf -oL yes &'],
  ['stdbuf with a separate mode', 'stdbuf -o L yes &'],
  ['exec with a name', 'exec -a loop yes &'],
  ['time -p', 'time -p yes &'],
  ['options ended by a double dash', 'nice -n 5 -- yes &'],
  ['wrappers stacked with options', 'nohup nice -n 19 env -i yes &'],
];

const ALLOWED: readonly (readonly [string, string])[] = [
  ['a plain command', 'pnpm test'],
  ['a background job that ends', 'pnpm test & wait'],
  ['a foreground endless-looking loop', 'while :; do :; done'],
  ['yes in the foreground', 'yes | head -n 3'],
  ['a loop that reads input, backgrounded', 'while read line; do echo $line; done < file.txt &'],
  ['a for over a list, backgrounded', 'for f in a b c; do build $f; done &'],
  ['a counted loop', 'i=0; while [ $i -lt 5 ]; do i=$((i+1)); done &'],
  ['the words in a quoted argument', 'git commit -m "stop the while true loop &"'],
  ['the words in an echo', 'echo while true; echo done &'],
  ['a redirection of stderr', 'pnpm test 2>&1'],
  ['an and-list', 'make a && make b'],
  ['an and-list with a loop in it', 'make a && while :; do break; done'],
  ['dd with a count', 'dd if=/dev/zero of=/dev/null count=10 &'],
  ['cat of a file', 'cat /dev/null &'],
  ['a comment', 'ls # while true; do :; done &'],
  ['an unbalanced quote', 'echo "while true &'],
  ['nothing', ''],
  ['sh -c with a bounded script, backgrounded', "sh -c 'for i in 1 2; do :; done' &"],
  ['&> redirect', 'pnpm test &> out.log'],
  ['a pipe-ampersand', 'pnpm test |& tee out.log'],
  ['a wrapper with options around a command that ends', 'nice -n 19 pnpm test &'],
  ['env with options around a command that ends', 'env -i PATH=/bin make &'],
];

describe('startsEndlessBackgroundLoop', () => {
  it.each(ENDLESS)('flags %s', (_name, command) => {
    expect(startsEndlessBackgroundLoop(command)).toBe(true);
  });

  it.each(ALLOWED)('allows %s', (_name, command) => {
    expect(startsEndlessBackgroundLoop(command)).toBe(false);
  });

  it('takes time linear in a long command', () => {
    const command = `${'while :; do x; '.repeat(20_000)} done &`;
    const started = performance.now();
    startsEndlessBackgroundLoop(command);
    startsEndlessBackgroundLoop('"'.repeat(200_000));
    startsEndlessBackgroundLoop('('.repeat(200_000));
    // A shell flag the old pattern backtracked over quadratically.
    startsEndlessBackgroundLoop(`sh -${'c'.repeat(100_000)}X`);
    // Many C-style fors whose parens never close.
    startsEndlessBackgroundLoop('for (( '.repeat(50_000));
    // Many wrappers, each with options.
    startsEndlessBackgroundLoop('nice -n 1 '.repeat(50_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('does not recurse without bound into nested scripts', () => {
    const command = `${'eval '.repeat(50)}while :; do :; done &`;
    expect(startsEndlessBackgroundLoop(command)).toBe(true);
  });
});
