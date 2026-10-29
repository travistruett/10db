/** xargs flags that take a value in the next word, BSD and GNU, short and long. */
export const XARGS_VALUE_FLAGS: readonly string[] = [
  '-n',
  '-I',
  '-J',
  '-P',
  '-L',
  '-R',
  '-S',
  '-s',
  '-d',
  '-E',
  '-a',
  '--max-args',
  '--max-procs',
  '--max-lines',
  '--max-chars',
  '--delimiter',
  '--eof',
  '--arg-file',
  '--process-slot-var',
];

/** xargs long flags that take no value in the next word, or carry it attached (`--replace=X`). */
export const XARGS_VALUELESS_LONG_FLAGS: readonly string[] = [
  '--replace',
  '--null',
  '--no-run-if-empty',
  '--interactive',
  '--open-tty',
  '--verbose',
  '--exit',
  '--show-limits',
  '--help',
  '--version',
];
