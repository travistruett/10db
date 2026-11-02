/** Characters of an ID's random tail the short form keeps; the front is a timestamp shared by tasks made together. */
const TAIL = 8;

/** A task ID shortened to its prefix and tail (`tsk_…89abcdef`), enough to tell tasks apart by eye. */
export function shortTaskId(id: string): string {
  const prefix = id.slice(0, id.indexOf('_') + 1);
  const rest = id.slice(prefix.length);
  return rest.length <= TAIL ? id : `${prefix}…${rest.slice(-TAIL)}`;
}
