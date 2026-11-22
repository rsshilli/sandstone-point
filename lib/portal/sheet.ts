/**
 * The owner-records spreadsheet as the portal sees it: the four tabs, their columns, and the
 * interface both the real Google Sheet and the local fake-data file implement.
 *
 * Column layout (row 1 is headers, data starts on row 2):
 * - Owners: A Owner ID, B Name on tax record, C First name, D Last name, E Email, F Phone,
 *   G Mailing address, H Role (Owner/Admin), I Gate code, J Status (Active/Inactive), K Notes
 * - Lots: A Lot, B Owner IDs, C Owner names (formula, first and last), D Owner names on tax record
 *   (formula), E Lot status, F Annual dues, G Balance owed (formula), H Notes, I Tax map number,
 *   J Street
 * - Payments: A Date, B Lot, C Description, D Charge, E Payment, F Method, G Recorded by
 * - Sign-up requests: A Submitted, B Name, C Email, D Phone, E Lot(s) claimed, F Status,
 *   G Reviewed by, H Reviewed on, I Notes
 */

/** Tab names exactly as they appear in the spreadsheet. */
export const TABS = {
  owners: 'Owners',
  lots: 'Lots',
  payments: 'Payments',
  requests: 'Sign-up requests',
} as const;

/** The A1 ranges read for each tab (row 2 down, all used columns). */
export const READ_RANGES = {
  owners: `${TABS.owners}!A2:K`,
  lots: `${TABS.lots}!A2:J`,
  payments: `${TABS.payments}!A2:G`,
  requests: `'${TABS.requests}'!A2:I`,
} as const;

/** One cell value as Google returns it (numbers unformatted, dates as formatted text). */
export type Cell = string | number | boolean | null | undefined;

/** The raw rows of every tab, starting at row 2. */
export interface SheetValues {
  owners: Cell[][];
  lots: Cell[][];
  payments: Cell[][];
  requests: Cell[][];
}

/** A person (or company) on the Owners tab. */
export interface Owner {
  /** Spreadsheet row number (2 = first data row). */
  row: number;
  id: string;
  taxName: string;
  firstName: string;
  lastName: string;
  /** Lower-cased login emails; the Email cell may hold several, separated by commas. */
  emails: string[];
  phone: string;
  role: 'Owner' | 'Admin';
  gateCode: string;
  active: boolean;
}

/** A lot on the Lots tab. */
export interface Lot {
  lot: string;
  ownerIds: string[];
  status: string;
  annualDues: number;
}

/** A charge or payment on the Payments tab. */
export interface LedgerEntry {
  date: string;
  lot: string;
  description: string;
  charge: number;
  payment: number;
  method: string;
}

/** A row on the Sign-up requests tab. */
export interface SignupRequest {
  row: number;
  submitted: string;
  name: string;
  email: string;
  phone: string;
  lotsClaimed: string;
  status: 'Pending' | 'Approved' | 'Rejected' | string;
  reviewedBy: string;
  reviewedOn: string;
}

/** Everything the portal reads, parsed. */
export interface SheetData {
  owners: Owner[];
  lots: Lot[];
  ledger: LedgerEntry[];
  requests: SignupRequest[];
}

/** A new sign-up request, as written to the sheet. */
export interface NewSignupRequest {
  submitted: string;
  name: string;
  email: string;
  phone: string;
  lotsClaimed: string;
}

/**
 * Where the portal's data lives. Both implementations write values as plain text, never as
 * formulas, so nothing a visitor types can run in the sheet.
 */
export interface SheetSource {
  /**
   * Reads all four tabs.
   * @param options `fresh` skips any cache; used just before a write, so it lands on the right row
   */
  readValues(options?: { fresh?: boolean }): Promise<SheetValues>;
  /**
   * Adds a row to the Sign-up requests tab with status Pending.
   * @param request the request to add
   */
  appendRequest(request: NewSignupRequest): Promise<void>;
  /**
   * Sets a request's Status, Reviewed by and Reviewed on cells.
   * @param row the request's spreadsheet row
   * @param status Approved or Rejected
   * @param reviewer the admin's email
   * @param reviewedOn the date, YYYY-MM-DD
   */
  setRequestStatus(row: number, status: 'Approved' | 'Rejected', reviewer: string, reviewedOn: string): Promise<void>;
  /**
   * Replaces an owner's Email cell.
   * @param row the owner's spreadsheet row
   * @param emails the full list of emails to store
   */
  setOwnerEmails(row: number, emails: string[]): Promise<void>;
}

/**
 * Reads and parses every tab.
 * @param source where the sheet lives
 * @param fresh skip any cache (before a write)
 * @returns the parsed data
 */
export async function readSheet(source: SheetSource, fresh = false): Promise<SheetData> {
  return parseSheet(await source.readValues({ fresh }));
}

/**
 * Turns raw tab rows into typed records, skipping blank rows.
 * @param values the raw rows of each tab
 * @returns the parsed data
 */
export function parseSheet(values: SheetValues): SheetData {
  return {
    owners: values.owners.map((cells, index) => parseOwner(cells, index + 2)).filter((owner): owner is Owner => owner !== undefined),
    lots: values.lots.map(parseLot).filter((lot): lot is Lot => lot !== undefined),
    ledger: values.payments.map(parseLedgerEntry).filter((entry): entry is LedgerEntry => entry !== undefined),
    requests: values.requests
      .map((cells, index) => parseRequest(cells, index + 2))
      .filter((request): request is SignupRequest => request !== undefined),
  };
}

/**
 * Parses one Owners row.
 * @param cells the row's cells
 * @param row the spreadsheet row number
 * @returns the owner, or undefined for a row without an Owner ID
 */
function parseOwner(cells: Cell[], row: number): Owner | undefined {
  const id = text(cells[0]);
  if (!id) {
    return undefined;
  }
  return {
    row,
    id,
    taxName: text(cells[1]),
    firstName: text(cells[2]),
    lastName: text(cells[3]),
    emails: splitEmails(text(cells[4])),
    phone: text(cells[5]),
    role: text(cells[7]).toLowerCase() === 'admin' ? 'Admin' : 'Owner',
    gateCode: text(cells[8]),
    // Only the word Active lets someone in; "Sold", a typo or a blank cell does not.
    active: text(cells[9]).toLowerCase() === 'active',
  };
}

/**
 * Parses one Lots row.
 * @param cells the row's cells
 * @returns the lot, or undefined for a row without a lot number
 */
function parseLot(cells: Cell[]): Lot | undefined {
  const lot = text(cells[0]);
  if (!lot) {
    return undefined;
  }
  return {
    lot,
    ownerIds: text(cells[1])
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
    status: text(cells[4]),
    annualDues: amount(cells[5]),
  };
}

/**
 * Parses one Payments row.
 * @param cells the row's cells
 * @returns the entry, or undefined for a row without a lot
 */
function parseLedgerEntry(cells: Cell[]): LedgerEntry | undefined {
  const lot = text(cells[1]);
  if (!lot) {
    return undefined;
  }
  return {
    date: text(cells[0]),
    lot,
    description: text(cells[2]),
    charge: amount(cells[3]),
    payment: amount(cells[4]),
    method: text(cells[5]),
  };
}

/**
 * Parses one Sign-up requests row.
 * @param cells the row's cells
 * @param row the spreadsheet row number
 * @returns the request, or undefined for a row without an email
 */
function parseRequest(cells: Cell[], row: number): SignupRequest | undefined {
  const email = text(cells[2]).toLowerCase();
  if (!email) {
    return undefined;
  }
  return {
    row,
    submitted: text(cells[0]),
    name: text(cells[1]),
    email,
    phone: text(cells[3]),
    lotsClaimed: text(cells[4]),
    status: requestStatus(text(cells[5])),
    reviewedBy: text(cells[6]),
    reviewedOn: text(cells[7]),
  };
}

/**
 * Normalises a request's Status cell, so "approved" typed by hand matches Approved.
 * @param value the cell text
 * @returns Pending (also for a blank cell), Approved, Rejected, or the text as typed
 */
function requestStatus(value: string): string {
  const known = ['Pending', 'Approved', 'Rejected'].find((status) => status.toLowerCase() === value.toLowerCase());
  return known ?? (value || 'Pending');
}

/**
 * Splits an Email cell that may hold several addresses.
 * @param cell the cell text
 * @returns lower-cased, trimmed addresses
 */
export function splitEmails(cell: string): string[] {
  return cell
    .split(/[,;\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes('@'));
}

/**
 * Reads a cell as trimmed text.
 * @param cell the cell
 * @returns the text, or "" when empty
 */
function text(cell: Cell): string {
  return cell === null || cell === undefined ? '' : String(cell).trim();
}

/**
 * Reads a cell as a dollar amount, accepting numbers or text like "$1,200.50".
 * @param cell the cell
 * @returns the amount, or 0 when empty or unreadable
 */
function amount(cell: Cell): number {
  if (typeof cell === 'number') {
    return cell;
  }
  const parsed = Number(text(cell).replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
