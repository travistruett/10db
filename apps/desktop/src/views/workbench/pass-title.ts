/**
 * What a pass is called on screen: its pages, since a pass has no name the builder chooses. One page is
 * its label, two are "Board and Sessions", more are the first two and a count: "Board, Sessions + 4 more".
 * A pass with no page yet falls back to `fallback`.
 */
export function passTitle(pages: readonly { readonly label: string }[], fallback: string): string {
  const [first, second] = pages;
  if (first === undefined) return fallback;
  if (second === undefined) return first.label;
  if (pages.length === 2) return `${first.label} and ${second.label}`;
  return `${first.label}, ${second.label} + ${String(pages.length - 2)} more`;
}
