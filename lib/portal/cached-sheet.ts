import type { NewSignupRequest, OwnerContact, SheetSource, SheetValues } from './sheet';

/**
 * Wraps a sheet source so repeated reads within a short window reuse one Google call. Any write
 * clears the cache, so the writer sees its own change straight away.
 */
export class CachedSheetSource implements SheetSource {
  private cached: { at: number; values: Promise<SheetValues> } | undefined;

  /**
   * @param inner the real source
   * @param maxAgeMs how long a read is reused
   * @param clock time source (injectable for tests)
   */
  constructor(
    private readonly inner: SheetSource,
    private readonly maxAgeMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** @inheritdoc */
  readValues(options?: { fresh?: boolean }): Promise<SheetValues> {
    if (options?.fresh || !this.cached || this.clock() - this.cached.at > this.maxAgeMs) {
      const values = this.inner.readValues();
      this.cached = { at: this.clock(), values };
      values.catch(() => {
        this.cached = undefined;
      });
    }
    return this.cached.values;
  }

  /** @inheritdoc */
  async appendRequest(request: NewSignupRequest): Promise<void> {
    await this.write(() => this.inner.appendRequest(request));
  }

  /** @inheritdoc */
  async setRequestStatus(row: number, status: 'Approved' | 'Rejected', reviewer: string, reviewedOn: string): Promise<void> {
    await this.write(() => this.inner.setRequestStatus(row, status, reviewer, reviewedOn));
  }

  /** @inheritdoc */
  async setOwnerEmails(row: number, emails: string[]): Promise<void> {
    await this.write(() => this.inner.setOwnerEmails(row, emails));
  }

  /** @inheritdoc */
  async setOwnerContact(row: number, contact: OwnerContact): Promise<void> {
    await this.write(() => this.inner.setOwnerContact(row, contact));
  }

  /**
   * Runs a write and drops the cache before and after it, so a read that ran during the write
   * can't keep the old values around.
   * @param action the write
   */
  private async write(action: () => Promise<void>): Promise<void> {
    this.cached = undefined;
    try {
      await action();
    } finally {
      this.cached = undefined;
    }
  }
}
