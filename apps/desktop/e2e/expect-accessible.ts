import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Fails when axe finds a violation on the page. The palette is Selenized exactly, so its contrast is
 * Selenized's, not a WCAG ratio (docs/architecture/decisions/2026-10-28-selenized-exactly.md); every
 * other rule still runs.
 */
export async function expectAccessible(
  page: Page,
  label: string,
  /** CSS selectors of parts of the page a scan leaves out, each with its reason at the call. */
  exclude: readonly string[] = [],
): Promise<void> {
  const builder = new AxeBuilder({ page });
  for (const selector of exclude) builder.exclude(selector);
  const results = await builder
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast'])
    .analyze();
  // Each entry names the rule and the offending nodes, so a failure says what to fix.
  const found = results.violations.map(
    (v) => `${label}: ${v.id} (${v.help}) on ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(found).toEqual([]);
}
