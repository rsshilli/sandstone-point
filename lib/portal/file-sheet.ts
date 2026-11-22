import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Cell, NewSignupRequest, OwnerContact, SheetSource, SheetValues } from './sheet';

/**
 * A stand-in for the Google Sheet, kept in a JSON file with the same rows and columns. Used for
 * local development and tests so no real owner's details are needed. The first read copies the
 * committed fake data (`seedFile`) to a working file, which writes then change.
 */
export class FileSheetSource implements SheetSource {
  /**
   * @param workingFile the JSON file that reads and writes use (gitignored)
   * @param seedFile the committed fake data copied into `workingFile` when it doesn't exist yet
   */
  constructor(
    private readonly workingFile: string,
    private readonly seedFile: string,
  ) {}

  /** @inheritdoc */
  async readValues(): Promise<SheetValues> {
    return this.load();
  }

  /** @inheritdoc */
  async appendRequest(request: NewSignupRequest): Promise<void> {
    const values = this.load();
    values.requests.push([request.submitted, request.name, request.email, request.phone, request.lotsClaimed, 'Pending', '', '', '']);
    this.save(values);
  }

  /** @inheritdoc */
  async setRequestStatus(row: number, status: 'Approved' | 'Rejected', reviewer: string, reviewedOn: string): Promise<void> {
    const values = this.load();
    const cells = rowCells(values.requests, row, 9);
    cells[5] = status;
    cells[6] = reviewer;
    cells[7] = reviewedOn;
    this.save(values);
  }

  /** @inheritdoc */
  async setOwnerEmails(row: number, emails: string[]): Promise<void> {
    const values = this.load();
    rowCells(values.owners, row, 11)[4] = emails.join(', ');
    this.save(values);
  }

  /** @inheritdoc */
  async setOwnerContact(row: number, contact: OwnerContact): Promise<void> {
    const values = this.load();
    const cells = rowCells(values.owners, row, 11);
    if (contact.emails) {
      cells[4] = contact.emails.join(', ');
    }
    if (contact.phone !== undefined) {
      cells[5] = contact.phone;
    }
    if (contact.mailingAddress !== undefined) {
      cells[6] = contact.mailingAddress;
    }
    this.save(values);
  }

  /**
   * Reads the working file, creating it from the seed first if needed.
   * @returns every tab's rows
   */
  private load(): SheetValues {
    if (!existsSync(this.workingFile)) {
      mkdirSync(dirname(this.workingFile), { recursive: true });
      copyFileSync(this.seedFile, this.workingFile);
    }
    return JSON.parse(readFileSync(this.workingFile, 'utf8')) as SheetValues;
  }

  /**
   * Writes the working file.
   * @param values every tab's rows
   */
  private save(values: SheetValues): void {
    writeFileSync(this.workingFile, `${JSON.stringify(values, null, 2)}\n`);
  }
}

/**
 * Returns a tab row's cells for editing, padding it to the tab's width.
 * @param rows the tab's rows (index 0 = spreadsheet row 2)
 * @param row the spreadsheet row number
 * @param width how many columns the tab has
 * @returns the row's cell array (edits change the tab)
 */
function rowCells(rows: Cell[][], row: number, width: number): Cell[] {
  const cells = rows[row - 2];
  if (!cells) {
    throw new Error(`Row ${row} does not exist`);
  }
  while (cells.length < width) {
    cells.push('');
  }
  return cells;
}
