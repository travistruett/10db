import type { NetworkHostSource } from '@10db/contracts';

/** Where an allowed host came from, in the words the builder reads. */
export function networkHostSourceText(source: NetworkHostSource): string {
  switch (source.kind) {
    case 'file':
      return `Found in ${source.file}`;
    case 'card':
      return 'Allowed from a card';
    case 'builder':
      return 'Added by you';
  }
}
