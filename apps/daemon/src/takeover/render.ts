import { singleQuoted } from '../sandbox';
import {
  isArgFromFile,
  TakeoverRefusedError,
  type TakeoverArg,
  type TakeoverCommand,
} from '../sessions';

// Sessions spec §7.5: what the builder's terminal runs. Every value reaches the shell single-quoted; the one
// double-quoted word is an argument read from a file, `"<prefix>$(cat -- '<file>')"`.

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PREFIX_NAME = /^[A-Za-z0-9_]+$/;
const KEYCHAIN_FAILED = '10db could not read this account’s key from the Keychain.';
const HAND_BACK_REMINDER = 'Back in 10db, click Hand Back.';

export interface RenderedTakeover {
  /** A script that deletes itself first, for Terminal and iTerm to open. */
  readonly script: string;
  /**
   * The same commands as one line for zsh or bash, leaving nothing exported in the builder's shell. Not for fish,
   * which reads a backslash inside single quotes differently from a value that holds a quote.
   */
  readonly line: string;
}

function clean(text: string, what: string): string {
  if (text.includes('\0')) throw new TakeoverRefusedError(`${what} holds a NUL byte`);
  return text;
}

function nameOf(name: string, what: string): string {
  if (!VARIABLE_NAME.test(name)) throw new TakeoverRefusedError(`${what} is not a variable name`);
  return name;
}

const quoted = (text: string, what: string): string => singleQuoted(clean(text, what));

/** `prefix` as literal text inside double quotes. */
const inDoubleQuotes = (prefix: string): string =>
  clean(prefix, 'an argument prefix').replace(/[\\"$`]/g, (c) => `\\${c}`);

function argOf(arg: TakeoverArg): string {
  if (!isArgFromFile(arg)) return quoted(arg, 'an argument');
  return `"${inDoubleQuotes(arg.prefix)}$(cat -- ${quoted(arg.file, 'an argument file')})"`;
}

/** The commands after the script's own deletion, one statement each. */
function statements(cmd: TakeoverCommand): string[] {
  const out: string[] = [`cd -- ${quoted(cmd.cwd, 'the folder')} || exit 1`];
  for (const prefix of cmd.unsetPrefixes) {
    if (!PREFIX_NAME.test(prefix)) throw new TakeoverRefusedError('a prefix is not a name prefix');
    out.push(
      `for v in $(/usr/bin/env | /usr/bin/sed -n 's/^\\(${prefix}[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$v"; done`,
    );
  }
  // A sealed file holds secret values: it is read once and gone before the agent starts.
  for (const file of cmd.sources) {
    const sealed = quoted(file, 'a sealed file');
    out.push(`. ${sealed}`, `rm -- ${sealed}`);
  }
  for (const { variable, account } of cmd.keychain) {
    const name = nameOf(variable, 'a Keychain variable');
    out.push(
      `${name}=$(/usr/bin/security find-generic-password -s 10db -a ${quoted(account, 'a Keychain account')} -w) || { echo ${singleQuoted(KEYCHAIN_FAILED)}; exit 1; }`,
      `export ${name}`,
    );
  }
  const unsets = cmd.unset.flatMap((name) => ['-u', singleQuoted(nameOf(name, 'an unset name'))]);
  const sets = Object.entries(cmd.set).map(([name, value]) =>
    singleQuoted(`${nameOf(name, 'a set name')}=${clean(value, 'a value')}`),
  );
  if (cmd.argv.length === 0) throw new TakeoverRefusedError('there is nothing to run');
  out.push(['/usr/bin/env', ...unsets, '--', ...sets, ...cmd.argv.map(argOf)].join(' '));
  out.push('echo', `echo ${singleQuoted(HAND_BACK_REMINDER)}`);
  return out;
}

export function renderTakeover(cmd: TakeoverCommand): RenderedTakeover {
  const body = statements(cmd);
  return {
    script: ['#!/bin/sh', 'rm -- "$0"', ...body, ''].join('\n'),
    line: `/bin/sh -c ${singleQuoted(body.join('; '))}`,
  };
}
