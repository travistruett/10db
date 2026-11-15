/** A failure the skill reports in words to whoever ran it; `status` is the HTTP status when one caused it. */
export class TendbError extends Error {
  override readonly name: string = 'TendbError';
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** The command line named no command, or one the skill doesn't have. */
export class UnknownCommandError extends TendbError {
  override readonly name = 'UnknownCommandError';
}
