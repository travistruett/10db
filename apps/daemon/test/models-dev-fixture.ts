import { readFileSync } from 'node:fs';

/** The hand-picked extract of models.dev's real file in `test/fixtures/catalogue.json`. */
export function readModelsDevFixture(): unknown {
  return JSON.parse(readFileSync(new URL('fixtures/catalogue.json', import.meta.url), 'utf8'));
}
