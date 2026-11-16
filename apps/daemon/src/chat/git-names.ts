import { BRANCH_PREFIX, InvalidError } from '@10db/contracts';

/** The longest branch name a chat's tool takes. */
const MAX_NAME = 200;

/**
 * Whether `name` is under 10db's own branches (a batch's, a pass's). Compared folded and normalised, since a
 * case-insensitive volume keeps `10DB/x` and `10db/x` as one ref file.
 */
export function isTenDbBranch(name: string): boolean {
  const folded = name.normalize('NFC').toLowerCase();
  return folded === BRANCH_PREFIX.slice(0, -1) || folded.startsWith(BRANCH_PREFIX);
}

/**
 * A branch name a chat's tool may create or switch to: not 10db's, not an option (`-`) or a refspec force
 * (`+`), no whitespace or control character, and short. Git's own rules (`check-ref-format`) run after this.
 */
export function chatBranchName(name: string): string {
  if (name.length === 0 || name.length > MAX_NAME)
    throw new InvalidError(`A branch name is 1 to ${String(MAX_NAME)} characters`);
  if (name.startsWith('-') || name.startsWith('+'))
    throw new InvalidError('A branch name never starts with - or +');
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/u.test(name))
    throw new InvalidError('A branch name holds no space or control character');
  if (isTenDbBranch(name))
    throw new InvalidError(
      `${BRANCH_PREFIX}… is 10db's own: its batches and passes live there, so a chat never makes or switches to one`,
    );
  return name;
}
