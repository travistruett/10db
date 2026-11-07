import { readFileSync } from 'node:fs';
import { CatalogueError, parseCatalogue, type Catalogue } from './source';

/** The file beside the daemon bundle that holds the catalogue the release was built with. */
export const CATALOGUE_SNAPSHOT_FILE = 'catalogue-snapshot.json';

/**
 * The catalogue embedded in the release: models.dev's document cut to the providers 10db keeps, read through
 * the same boundary as a fetched one. Null when the file is absent (a build made without it) or does not hold
 * a catalogue, so the stored copy is used instead.
 */
export function readCatalogueSnapshot(file: string): Catalogue | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  try {
    return parseCatalogue(raw);
  } catch (error) {
    if (error instanceof CatalogueError) return null;
    throw error;
  }
}
