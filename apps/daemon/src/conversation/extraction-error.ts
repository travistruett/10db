/** A document that can't be turned into text, in words the builder reads. */
export class ExtractionError extends Error {
  override readonly name = 'ExtractionError';
}
