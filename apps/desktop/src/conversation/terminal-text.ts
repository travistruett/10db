// A command's output carries the terminal's escape codes (colours, cursor moves, links) when the tool
// colours its output; a `pre` would draw each ESC as a box and the code after it as text.

// Matched in order: an OSC string (a link or a window title) up to BEL or ESC \, or to the line's end
// when output was cut before its end, a CSI sequence
// (colours, cursor moves, modes), then any other two-byte escape.
const TERMINAL_CODE =
  // eslint-disable-next-line no-control-regex -- the escape character is what this matches.
  /\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/g;

/** The text as the terminal would show it, less its colours and cursor moves. */
export function withoutTerminalCodes(text: string): string {
  return text.replace(TERMINAL_CODE, '');
}
