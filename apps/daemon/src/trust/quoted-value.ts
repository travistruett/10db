/** Characters a JSON string leaves raw that can end a line or hide text from a reader. */
const RAW_IN_JSON = /[\p{Cf}\u2028\u2029]/gu;

/**
 * A value 10db didn't write, as one JSON string a policy line holds: quotes, backslashes and control
 * characters escaped as JSON escapes them, and the line and paragraph separators and every format
 * character (a right-to-left override, a zero-width space) escaped as `\uXXXX` too, so the value
 * stays on its line and reads as it is.
 */
export function quotedValue(value: string): string {
  return JSON.stringify(value).replaceAll(
    RAW_IN_JSON,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  );
}
