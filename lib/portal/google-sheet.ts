import { createSign } from 'node:crypto';
import { READ_RANGES, TABS, type Cell, type NewSignupRequest, type OwnerContact, type SheetSource, type SheetValues } from './sheet';

/**
 * Which spreadsheet to open, and optionally a service account key. Without a key, the token
 * comes from the Google Cloud server the code runs on (the function runs as the HOA's robot
 * account, so no key is stored anywhere).
 */
export interface GoogleSheetConfig {
  spreadsheetId: string;
  /** The service account's email (`client_email` in its JSON key). */
  client_email?: string;
  /** The service account's PEM private key (`private_key` in its JSON key). */
  private_key?: string;
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Google Cloud's metadata server: hands out tokens for the account a function runs as. */
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
/**
 * Each Google call gives up after this long. Sheet reads are live inside the API request (a
 * neighbourhood-sized sheet answers in about a second), so this keeps a slow Google well inside
 * the function's 30 s limit and shows a clear error instead of a hang.
 */
const GOOGLE_TIMEOUT_MS = 8_000;

/**
 * The real owner-records sheet, reached as the HOA's Google service account. Writes use
 * `valueInputOption=RAW`, so text a visitor typed is stored as text and never run as a formula.
 */
export class GoogleSheetSource implements SheetSource {
  private token: { value: string; expires: number } | undefined;

  /**
   * @param config the spreadsheet id and the service account key
   * @param fetchFn fetch implementation (injectable for tests)
   */
  constructor(
    private readonly config: GoogleSheetConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** @inheritdoc */
  async readValues(): Promise<SheetValues> {
    const ranges = [READ_RANGES.owners, READ_RANGES.lots, READ_RANGES.payments, READ_RANGES.requests];
    const query = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
    for (const range of ranges) {
      query.append('ranges', range);
    }
    const result = (await this.call('GET', `/values:batchGet?${query}`)) as { valueRanges: { values?: Cell[][] }[] };
    const [owners, lots, payments, requests] = result.valueRanges.map((range) => range.values ?? []);
    return { owners, lots, payments, requests };
  }

  /** @inheritdoc */
  async appendRequest(request: NewSignupRequest): Promise<void> {
    const range = encodeURIComponent(`'${TABS.requests}'!A:I`);
    await this.call('POST', `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      values: [[request.submitted, request.name, request.email, request.phone, request.lotsClaimed, 'Pending', '', '', '']],
    });
  }

  /** @inheritdoc */
  async setRequestStatus(row: number, status: 'Approved' | 'Rejected', reviewer: string, reviewedOn: string): Promise<void> {
    await this.update(`'${TABS.requests}'!F${row}:H${row}`, [[status, reviewer, reviewedOn]]);
  }

  /** @inheritdoc */
  async setOwnerEmails(row: number, emails: string[]): Promise<void> {
    await this.update(`${TABS.owners}!E${row}`, [[emails.join(', ')]]);
  }

  /** @inheritdoc */
  async setOwnerContact(row: number, contact: OwnerContact): Promise<void> {
    // Only the cells that changed, so a note typed beside an email (or anything else) survives a phone edit.
    const data: { range: string; values: string[][] }[] = [];
    if (contact.emails) {
      data.push({ range: `${TABS.owners}!E${row}`, values: [[contact.emails.join(', ')]] });
    }
    if (contact.phone !== undefined) {
      data.push({ range: `${TABS.owners}!F${row}`, values: [[contact.phone]] });
    }
    if (contact.mailingAddress !== undefined) {
      data.push({ range: `${TABS.owners}!G${row}`, values: [[contact.mailingAddress]] });
    }
    if (data.length > 0) {
      await this.call('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data });
    }
  }

  /**
   * Overwrites a range with plain-text values.
   * @param range A1 range
   * @param values rows of values
   */
  private async update(range: string, values: string[][]): Promise<void> {
    await this.call('PUT', `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values });
  }

  /**
   * Calls the Sheets API for this spreadsheet.
   * @param method HTTP method
   * @param path path after the spreadsheet id
   * @param body JSON body, if any
   * @returns the parsed JSON response
   */
  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchFn(`${SHEETS_API}/${encodeURIComponent(this.config.spreadsheetId)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Google Sheets ${method} ${path.split('?')[0]} failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    return response.json();
  }

  /**
   * Gets (and caches until a minute before expiry) an OAuth access token for the service account:
   * from its key when one is configured, otherwise from the metadata server.
   * @returns the bearer token
   */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) {
      return this.token.value;
    }
    const response = this.config.private_key
      ? await this.fetchFn(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: this.signedAssertion(this.config.private_key) }),
          signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
        })
      : await this.fetchFn(`${METADATA_TOKEN_URL}?scopes=${encodeURIComponent(SCOPE)}`, {
          headers: { 'Metadata-Flavor': 'Google' },
          signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
        });
    if (!response.ok) {
      throw new Error(`Google token request failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    const result = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: result.access_token, expires: Date.now() + result.expires_in * 1000 };
    return this.token.value;
  }

  /**
   * Builds the signed JWT Google exchanges for an access token (RS256, one hour).
   * @param privateKey the service account's PEM key
   * @returns the compact JWT
   */
  private signedAssertion(privateKey: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({ iss: this.config.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    return `${header}.${claims}.${signer.sign(privateKey).toString('base64url')}`;
  }
}

/**
 * Base64url-encodes text.
 * @param textValue the text
 * @returns the encoded text
 */
function base64url(textValue: string): string {
  return Buffer.from(textValue).toString('base64url');
}
