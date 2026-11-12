/**
 * `word` as one shell word: as it is when it holds only letters, digits and `. _ / -`, else in single
 * quotes, each single quote in it closed, escaped and reopened.
 */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
