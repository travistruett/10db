import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import { CATALOGUE_PROVIDERS, parseCatalogue } from './source';
import { readCatalogueSnapshot } from './snapshot';

const dirs: { cleanup: () => void }[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});
function snapshotFile(content: string | null): string {
  const dir = tempDir('catalogue-snapshot');
  dirs.push(dir);
  const file = join(dir.path, 'catalogue-snapshot.json');
  if (content !== null) writeFileSync(file, content);
  return file;
}

/** What the release script writes: models.dev's document cut to the providers 10db keeps. */
function filteredDocument(): Record<string, unknown> {
  const full = readModelsDevFixture() as Record<string, unknown>;
  return Object.fromEntries(CATALOGUE_PROVIDERS.map((provider) => [provider, full[provider]]));
}

describe('readCatalogueSnapshot', () => {
  it('reads the release’s filtered document as the catalogue it holds', () => {
    const read = readCatalogueSnapshot(snapshotFile(JSON.stringify(filteredDocument())));
    expect(read).not.toBeNull();
    expect(Object.keys(read?.providers ?? {})).toEqual([...CATALOGUE_PROVIDERS]);
    expect(read?.providers['anthropic']).toEqual(
      parseCatalogue(readModelsDevFixture()).providers['anthropic'],
    );
  });

  it.each<{ name: string; content: string | null }>([
    { name: 'absent, as in a build with no snapshot', content: null },
    { name: 'not JSON', content: '{ "anthropic": ' },
    {
      name: 'a document missing a provider',
      content: JSON.stringify({ anthropic: { models: {} } }),
    },
    { name: 'a list, not a document', content: '[]' },
  ])('is null when the file is $name, so the stored copy is used', ({ content }) => {
    expect(readCatalogueSnapshot(snapshotFile(content))).toBeNull();
  });
});
