// Expected business-rule violations. Their message is safe to show to the user; anything else is
// treated as an unexpected error and reported with a reference id only.
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}
