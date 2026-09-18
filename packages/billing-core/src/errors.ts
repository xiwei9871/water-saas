/**
 * Domain error for billing-core rule violations.
 *
 * Carries a stable machine-readable `code` so callers (API/worker) can map
 * failures to responses without string-matching `message`. Pure data — the
 * engine never throws anything else for expected bad input.
 */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
