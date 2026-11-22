import { readSheet, type LedgerEntry, type Lot, type Owner, type OwnerContact, type SheetData, type SheetSource, type SignupRequest } from './sheet';
import { AuthError, type Identity, type TokenVerifier } from './auth';
import type { BoardMailer } from './mailer';

/** An HTTP request, reduced to what the portal API needs (same shape locally and in Lambda). */
export interface ApiRequest {
  method: string;
  /** Path without the query string, e.g. "/api/me". */
  path: string;
  /** The Authorization header ("Bearer <Cognito ID token>"). */
  authorization?: string;
  /** Raw request body. */
  body?: string;
}

/** The API's answer: a status code and a JSON-serialisable body. */
export interface ApiResponse {
  status: number;
  body: unknown;
}

/** What the API needs from the outside world. */
export interface ApiDeps {
  source: SheetSource;
  verifier: TokenVerifier;
  /** Sends owners' messages to the board. Without one, the "Message the board" form is hidden. */
  mailer?: BoardMailer;
  /** Limits how often one person can message the board (a shared default when left out). */
  messageLimiter?: SendLimiter;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/**
 * Remembers recent sends per email and refuses more than `max` in `windowMs`. Kept in memory,
 * so in AWS each warm Lambda counts separately: a brake on accidents and pests, not a guarantee.
 */
export class SendLimiter {
  private readonly sent = new Map<string, number[]>();

  /**
   * @param max messages allowed per window
   * @param windowMs the window, in milliseconds
   */
  constructor(
    private readonly max = 5,
    private readonly windowMs = 60 * 60 * 1000,
  ) {}

  /**
   * Counts a send if it's allowed.
   * @param key who is sending (their email)
   * @param nowMs the current time in milliseconds
   * @returns false when they've hit the limit (nothing is counted then)
   */
  tryUse(key: string, nowMs: number): boolean {
    const recent = (this.sent.get(key) ?? []).filter((time) => nowMs - time < this.windowMs);
    if (recent.length >= this.max) {
      this.sent.set(key, recent);
      return false;
    }
    this.sent.set(key, [...recent, nowMs]);
    return true;
  }

  /**
   * Gives back a send that was counted but never went out (the email failed), so an owner isn't
   * charged for our error.
   * @param key who was sending (their email)
   * @param nowMs the time {@link tryUse} was called with
   */
  refund(key: string, nowMs: number): void {
    const times = this.sent.get(key) ?? [];
    const index = times.lastIndexOf(nowMs);
    if (index >= 0) {
      times.splice(index, 1);
    }
  }
}

const sharedLimiter = new SendLimiter();

/** Longest text accepted in a sign-up request field. */
const MAX_FIELD = 120;
/** Longest message to the board accepted (a long email's worth). */
const MAX_MESSAGE = 4000;
/** Longest mailing address accepted (several lines). */
const MAX_ADDRESS = 300;
/** Longest email list accepted (a few addresses). */
const MAX_EMAILS_FIELD = 300;

/** An error with an HTTP status and a message safe to show the visitor. */
export class HttpError extends Error {
  /**
   * @param status HTTP status code
   * @param message plain-words message for the visitor
   */
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Answers one portal API call. Every route needs a valid Cognito ID token; what it returns
 * depends on whether the token's email is on the Owners tab (and whether that owner is an Admin).
 *
 * Routes:
 * - GET  /api/me                      the signed-in person's lots, balance, gate code (or request status)
 * - POST /api/requests                a visitor asks to be recognised as an owner
 * - GET  /api/admin/requests          admins: pending requests and the owner list to link them to
 * - POST /api/admin/requests/approve  admins: link a request's email to an owner record
 * - POST /api/admin/requests/reject   admins: turn a request down
 * - GET  /api/admin/owners            admins: every owner record with its contact details
 * - POST /api/admin/owners/contact    admins: change an owner's email(s), phone and mailing address
 * - POST /api/messages                owners: email a message to the board's mailing list
 * @param request the incoming call
 * @param deps the sheet, the token checker, the board mailer and the clock
 * @returns the response to send
 */
export async function handleApiRequest(request: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  try {
    const identity = await deps.verifier.verify(request.authorization);
    const route = `${request.method.toUpperCase()} ${request.path.replace(/\/+$/, '')}`;
    const now = deps.now ? deps.now() : new Date();
    switch (route) {
      case 'GET /api/me':
        return { status: 200, body: describeMe(identity, await readSheet(deps.source), Boolean(deps.mailer)) };
      case 'POST /api/requests':
        return await submitRequest(identity, parseBody(request.body), deps.source, now);
      case 'GET /api/admin/requests':
        return { status: 200, body: listRequests(requireAdmin(identity, await readSheet(deps.source))) };
      case 'POST /api/admin/requests/approve':
        return await reviewRequest(identity, parseBody(request.body), deps.source, now, 'Approved');
      case 'POST /api/admin/requests/reject':
        return await reviewRequest(identity, parseBody(request.body), deps.source, now, 'Rejected');
      case 'GET /api/admin/owners':
        return { status: 200, body: listOwnerContacts(requireAdmin(identity, await readSheet(deps.source))) };
      case 'POST /api/admin/owners/contact':
        return await saveOwnerContact(identity, parseBody(request.body), deps.source);
      case 'POST /api/messages':
        return await sendBoardMessage(identity, parseBody(request.body), deps, now);
      default:
        return { status: 404, body: { error: 'No such page.' } };
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return { status: 401, body: { error: error.message } };
    }
    if (error instanceof HttpError) {
      return { status: error.status, body: { error: error.message } };
    }
    console.error('portal API error', error);
    return { status: 500, body: { error: 'Something went wrong on our side. Please try again later.' } };
  }
}

/**
 * Builds the "my account" view. An active owner gets their lots, balance, gate code and
 * ledger; an admin also gets every lot. Anyone else gets the status of their sign-up request.
 * @param identity the signed-in person
 * @param data the sheet
 * @param canMessageBoard whether the "Message the board" form works (a mailer is set up)
 * @returns the view
 */
export function describeMe(identity: Identity, data: SheetData, canMessageBoard = false): unknown {
  // One person can be on several records (their own name, plus an LLC or a trust).
  const records = data.owners.filter((owner) => owner.active && owner.emails.includes(identity.email));
  if (records.length === 0) {
    const request = latestRequest(data, identity.email);
    return {
      kind: 'visitor',
      email: identity.email,
      request: request ? { status: request.status, submitted: request.submitted } : null,
    };
  }
  const ids = new Set(records.map((owner) => owner.id));
  const myLots = data.lots.filter((lot) => lot.ownerIds.some((id) => ids.has(id)));
  const lots = myLots.map((lot) => describeLot(lot, data));
  const lotNumbers = new Set(myLots.map((lot) => lot.lot));
  const isAdmin = records.some((owner) => owner.role === 'Admin');
  return {
    kind: 'member',
    email: identity.email,
    name: displayName(records.find((owner) => owner.firstName || owner.lastName) ?? records[0]),
    role: isAdmin ? 'Admin' : 'Owner',
    gateCode: [...new Set(records.map((owner) => owner.gateCode).filter((code) => code))].join(', '),
    lots,
    totalOwed: roundCents(lots.reduce((sum, lot) => sum + lot.balance, 0)),
    ledger: data.ledger.filter((entry) => lotNumbers.has(entry.lot)).map(describeEntry),
    allLots: isAdmin ? data.lots.map((lot) => describeLotForAdmin(lot, data)) : undefined,
    canMessageBoard,
  };
}

/**
 * Records a visitor's "I own a lot" request. Refused for people already recognised, and for a
 * second request while one is still pending.
 * @param identity the signed-in person
 * @param body the parsed request body: name, phone, lots
 * @param source the sheet
 * @param now the current time
 * @returns 201 when recorded
 */
async function submitRequest(identity: Identity, body: Record<string, unknown>, source: SheetSource, now: Date): Promise<ApiResponse> {
  if (/[\s,;]/.test(identity.email)) {
    // The Email cell holds several addresses split on these characters.
    throw new HttpError(400, 'Please sign up with a plain email address.');
  }
  const data = await readSheet(source);
  if (findActiveOwner(data, identity.email)) {
    throw new HttpError(409, 'Your email is already on the owner list.');
  }
  if (latestRequest(data, identity.email)?.status === 'Pending') {
    throw new HttpError(409, 'Your request is already with the board.');
  }
  const name = field(body.name, 'Your name', true);
  const lotsClaimed = field(body.lots, 'Your lot number(s)', true);
  const phone = field(body.phone, 'Phone', false);
  await source.appendRequest({ submitted: isoDate(now), name, email: identity.email, phone, lotsClaimed });
  return { status: 201, body: { ok: true } };
}

/**
 * Lists pending requests for the admin page, each with the owners of the lots it claims as
 * suggestions, plus every owner record so the admin can pick another.
 * @param data the sheet (caller is a verified admin)
 * @returns the pending requests and the owner list
 */
function listRequests(data: SheetData): unknown {
  const pending = data.requests.filter((request) => request.status === 'Pending');
  return {
    requests: pending.map((request) => ({
      email: request.email,
      name: request.name,
      phone: request.phone,
      lotsClaimed: request.lotsClaimed,
      submitted: request.submitted,
      suggestedOwnerIds: suggestOwners(request, data),
    })),
    owners: data.owners
      .filter((owner) => owner.active && owner.role !== 'Admin')
      .map((owner) => ({
        id: owner.id,
        name: displayName(owner),
        lots: data.lots.filter((lot) => lot.ownerIds.includes(owner.id)).map((lot) => lot.lot),
        hasEmail: owner.emails.length > 0,
      })),
  };
}

/**
 * Approves or rejects the pending request for an email. Approving adds that email to the
 * chosen owner record, which is what lets the person see their account.
 * @param identity the admin
 * @param body the parsed body: email, and ownerId when approving
 * @param source the sheet
 * @param now the current time
 * @param status the decision
 * @returns 200 when done
 */
async function reviewRequest(
  identity: Identity,
  body: Record<string, unknown>,
  source: SheetSource,
  now: Date,
  status: 'Approved' | 'Rejected',
): Promise<ApiResponse> {
  // Fresh, not cached: writes go by row number, so the rows must be as they are right now.
  const data = requireAdmin(identity, await readSheet(source, true));
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const request = data.requests.find((candidate) => candidate.email === email && candidate.status === 'Pending');
  if (!request) {
    throw new HttpError(404, 'That request is no longer pending. Refresh the page.');
  }
  if (status === 'Approved') {
    const owner = data.owners.find((candidate) => candidate.id === body.ownerId && candidate.active);
    if (!owner) {
      throw new HttpError(400, 'Pick the owner record this person belongs to.');
    }
    if (owner.role === 'Admin') {
      // Approving onto an admin's record would make the requester an admin too.
      throw new HttpError(400, 'Admin records can only be changed in the sheet itself.');
    }
    if (!owner.emails.includes(email)) {
      await source.setOwnerEmails(owner.row, [...owner.emails, email]);
    }
  }
  await source.setRequestStatus(request.row, status, identity.email, isoDate(now));
  return { status: 200, body: { ok: true } };
}

/**
 * Lists every owner record (active or not) with its contact details, for the admin's
 * "who is this?" window.
 * @param data the sheet (caller is a verified admin)
 * @returns the owners
 */
function listOwnerContacts(data: SheetData): unknown {
  return {
    owners: data.owners.map((owner) => ({
      id: owner.id,
      name: `${owner.firstName} ${owner.lastName}`.trim(),
      taxName: owner.taxName,
      emails: owner.emails,
      phone: owner.phone,
      mailingAddress: owner.mailingAddress,
      role: owner.role,
      active: owner.active,
      lots: data.lots.filter((lot) => lot.ownerIds.includes(owner.id)).map((lot) => lot.lot),
    })),
  };
}

/**
 * Saves an owner's email(s), phone and mailing address. Every email on a record can sign in
 * and see that record's lots and gate code, so admin records' emails can't change here (that
 * would hand out admin rights); they are changed in the sheet itself.
 * @param identity the admin
 * Only the fields that differ from the sheet are written, and the save is refused when the sheet
 * changed after the admin's page loaded it, so an old page can't put back an email the board removed.
 * @param identity the admin
 * @param body the parsed body: ownerId, emails (text, comma separated), phone, mailingAddress, and
 *   previous: the same three as the page loaded them
 * @param source the sheet
 * @returns 200 with the record's contact details after the save
 */
async function saveOwnerContact(identity: Identity, body: Record<string, unknown>, source: SheetSource): Promise<ApiResponse> {
  // Fresh, not cached: the write goes by row number, so the rows must be as they are right now.
  const data = requireAdmin(identity, await readSheet(source, true));
  const owner = data.owners.find((candidate) => candidate.id === body.ownerId);
  if (!owner) {
    throw new HttpError(404, 'That owner record is no longer in the sheet. Refresh the page.');
  }
  requireUnchangedSince(owner, body.previous);
  const emailText = field(body.emails, 'Email', false, MAX_EMAILS_FIELD);
  const phone = field(body.phone, 'Phone', false);
  const mailingAddress = field(body.mailingAddress, 'Mailing address', false, MAX_ADDRESS);
  const contact: OwnerContact = {};
  // Every typed word counts here (not just ones with an @), so "not-an-email" is a change that gets refused.
  if (!sameEmails(emailText.split(/[\s,;]+/).filter((word) => word), owner.emails)) {
    if (owner.role === 'Admin') {
      throw new HttpError(400, 'Admin emails can only be changed in the sheet itself.');
    }
    if (!owner.active) {
      throw new HttpError(400, 'This owner record is marked Inactive, so its emails can only be changed in the sheet itself.');
    }
    contact.emails = parseEmailList(emailText);
  }
  if (phone !== owner.phone) {
    contact.phone = phone;
  }
  if (mailingAddress !== owner.mailingAddress) {
    contact.mailingAddress = mailingAddress;
  }
  await source.setOwnerContact(owner.row, contact);
  return {
    status: 200,
    body: { ok: true, emails: contact.emails ?? owner.emails, phone, mailingAddress },
  };
}

/**
 * Throws 409 when the record's contact details no longer match what the admin's page showed.
 * @param owner the record as it is in the sheet right now
 * @param previous what the page loaded: { emails: string[], phone, mailingAddress }
 */
function requireUnchangedSince(owner: Owner, previous: unknown): void {
  const loaded = (typeof previous === 'object' && previous !== null ? previous : {}) as Record<string, unknown>;
  const loadedEmails = Array.isArray(loaded.emails) ? loaded.emails.map(String) : [];
  if (
    !Array.isArray(loaded.emails) ||
    !sameEmails(loadedEmails, owner.emails) ||
    loaded.phone !== owner.phone ||
    loaded.mailingAddress !== owner.mailingAddress
  ) {
    throw new HttpError(409, 'Someone changed this owner’s contact details since your page loaded them. Close this window and open the name again to see the latest.');
  }
}

/**
 * Compares two email lists as sets, ignoring case, order and repeats.
 * @param a one list
 * @param b the other
 * @returns true when they hold the same addresses
 */
function sameEmails(a: string[], b: string[]): boolean {
  const left = new Set(a.map((email) => email.toLowerCase()));
  const right = new Set(b.map((email) => email.toLowerCase()));
  return left.size === right.size && [...left].every((email) => right.has(email));
}

/**
 * Splits typed email text into lower-cased addresses, refusing anything that isn't one.
 * @param textValue e.g. "a@x.com, b@y.com"
 * @returns the addresses, without repeats
 */
function parseEmailList(textValue: string): string[] {
  const emails = [...new Set(textValue.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter((email) => email))];
  // No ? & or # either: they'd turn a mailto: link into one that prefills a subject or body.
  const bad = emails.find((email) => !/^[^@\s?&#]+@[^@\s?&#]+\.[^@\s?&#]+$/.test(email));
  if (bad) {
    throw new HttpError(400, `"${bad}" doesn't look like an email address.`);
  }
  return emails;
}

/**
 * Emails an owner's message to the board's mailing list, with Reply-To set to the owner so a
 * board member can answer straight from their inbox. Only active owners may send, and only a
 * few times an hour.
 * @param identity the signed-in person (their verified email becomes Reply-To)
 * @param body the parsed request body: subject (optional) and message
 * @param deps the sheet, the mailer and the limiter
 * @param now the current time
 * @returns 202 once handed to the mailer
 */
async function sendBoardMessage(identity: Identity, body: Record<string, unknown>, deps: ApiDeps, now: Date): Promise<ApiResponse> {
  if (!deps.mailer) {
    throw new HttpError(503, 'Messages to the board can’t be sent from the website yet.');
  }
  const data = await readSheet(deps.source);
  const records = data.owners.filter((owner) => owner.active && owner.emails.includes(identity.email));
  if (records.length === 0) {
    throw new HttpError(403, 'Only owners on the owner list can message the board from here.');
  }
  const subject = oneLine(field(body.subject, 'Subject', false));
  const message = field(body.message, 'Message', true, MAX_MESSAGE);
  const limiter = deps.messageLimiter ?? sharedLimiter;
  if (!limiter.tryUse(identity.email, now.getTime())) {
    throw new HttpError(429, 'You’ve sent several messages in the last hour. Please wait a while before sending another.');
  }
  const ids = new Set(records.map((owner) => owner.id));
  const lots = data.lots.filter((lot) => lot.ownerIds.some((id) => ids.has(id))).map((lot) => lot.lot);
  const name = oneLine(displayName(records.find((owner) => owner.firstName || owner.lastName) ?? records[0]));
  try {
    await sendToBoard(deps.mailer, { subject, message, name, email: identity.email, lots });
  } catch (error) {
    limiter.refund(identity.email, now.getTime());
    throw error;
  }
  return { status: 202, body: { ok: true } };
}

/**
 * Emails one owner's message to the board, signed with who sent it and their lots.
 * @param mailer the mailer
 * @param note the owner's subject and message, and who they are
 */
async function sendToBoard(
  mailer: BoardMailer,
  note: { subject: string; message: string; name: string; email: string; lots: string[] },
): Promise<void> {
  const { subject, message, name, email, lots } = note;
  await mailer.send({
    subject: `Owner message: ${subject || 'no subject'} (from ${name})`,
    replyTo: email,
    text: [
      message,
      '',
      '—',
      `From: ${name} (${email})`,
      `Lot${lots.length === 1 ? '' : 's'}: ${lots.join(', ') || 'none on record'}`,
      'Sent from the owner page of the Sandstone Point website. Press Reply to answer them.',
    ].join('\n'),
  });
}

/**
 * Squashes line breaks and tabs into single spaces (for an email subject).
 * @param text the text
 * @returns one line
 */
function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * Throws 403 unless the person is an active Admin on the Owners tab.
 * @param identity the signed-in person
 * @param data the sheet
 * @returns the same data, for chaining
 */
function requireAdmin(identity: Identity, data: SheetData): SheetData {
  if (findActiveOwner(data, identity.email)?.role !== 'Admin') {
    throw new HttpError(403, 'Only board admins can do that.');
  }
  return data;
}

/**
 * Finds the active owner record listing this email.
 * @param data the sheet
 * @param email the signed-in email (lower case)
 * @returns the owner, or undefined
 */
function findActiveOwner(data: SheetData, email: string): Owner | undefined {
  return data.owners.find((owner) => owner.active && owner.emails.includes(email));
}

/**
 * Finds the most recent sign-up request from this email (the lowest row wins ties).
 * @param data the sheet
 * @param email the email (lower case)
 * @returns the request, or undefined
 */
function latestRequest(data: SheetData, email: string): SignupRequest | undefined {
  return data.requests.filter((request) => request.email === email).at(-1);
}

/**
 * Suggests owner records for a request from the lot numbers it claims.
 * @param request the request
 * @param data the sheet
 * @returns owner IDs on those lots, without repeats
 */
function suggestOwners(request: SignupRequest, data: SheetData): string[] {
  const claimed = new Set(request.lotsClaimed.match(/\d+/g) ?? []);
  const ids = data.lots.filter((lot) => claimed.has(lot.lot)).flatMap((lot) => lot.ownerIds);
  const admins = new Set(data.owners.filter((owner) => owner.role === 'Admin').map((owner) => owner.id));
  return [...new Set(ids)].filter((id) => !admins.has(id));
}

/**
 * Describes one of the member's lots: status, dues, balance, and the owners' names two ways,
 * matching the Lots tab: people's first and last names (column C, so a company adds nothing)
 * and the names on the tax record (column D, where company names appear).
 * @param lot the lot
 * @param data the sheet
 * @returns the lot view
 */
function describeLot(
  lot: Lot,
  data: SheetData,
): { lot: string; status: string; annualDues: number; balance: number; owners: string[]; taxNames: string[] } {
  const owners = ownersOf(lot, data);
  return {
    lot: lot.lot,
    status: lot.status,
    annualDues: lot.annualDues,
    balance: balanceFor(lot.lot, data.ledger),
    owners: unique(owners.map((owner) => `${owner.firstName} ${owner.lastName}`.trim())),
    taxNames: unique(owners.map((owner) => owner.taxName)),
  };
}

/**
 * Drops blanks and repeats from a list of names, keeping the first-seen order.
 * @param names the names
 * @returns the names left
 */
function unique(names: string[]): string[] {
  return [...new Set(names.filter((name) => name.length > 0))];
}

/**
 * Describes any lot for the admin table: adds the owners' gate codes.
 * @param lot the lot
 * @param data the sheet
 * @returns the admin row
 */
function describeLotForAdmin(lot: Lot, data: SheetData): unknown {
  const owners = ownersOf(lot, data);
  return {
    ...describeLot(lot, data),
    // One entry per owner record, so each name on the page can open that record's contact details.
    people: owners.map((owner) => ({ id: owner.id, name: `${owner.firstName} ${owner.lastName}`.trim(), taxName: owner.taxName })),
    gateCodes: owners.filter((owner) => owner.active && owner.gateCode).map((owner) => owner.gateCode),
    hasLogin: owners.some((owner) => owner.active && owner.emails.length > 0),
  };
}

/**
 * Looks up the owner records listed on a lot.
 * @param lot the lot
 * @param data the sheet
 * @returns the owners found (unknown IDs are skipped)
 */
function ownersOf(lot: Lot, data: SheetData): Owner[] {
  return lot.ownerIds.map((id) => data.owners.find((owner) => owner.id === id)).filter((owner): owner is Owner => owner !== undefined);
}

/**
 * Works out a lot's balance: every charge minus every payment on the Payments tab.
 * @param lot the lot number
 * @param ledger every charge and payment
 * @returns the amount owed (negative means credit)
 */
export function balanceFor(lot: string, ledger: LedgerEntry[]): number {
  return roundCents(ledger.filter((entry) => entry.lot === lot).reduce((sum, entry) => sum + entry.charge - entry.payment, 0));
}

/**
 * Picks a ledger entry's fields for the browser.
 * @param entry the entry
 * @returns the entry view
 */
function describeEntry(entry: LedgerEntry): unknown {
  return { date: entry.date, lot: entry.lot, description: entry.description, charge: entry.charge, payment: entry.payment, method: entry.method };
}

/**
 * The name to show for an owner: first and last name when filled in, else the tax-record name.
 * @param owner the owner
 * @returns the name
 */
function displayName(owner: Owner): string {
  const name = `${owner.firstName} ${owner.lastName}`.trim();
  return name || owner.taxName || owner.id;
}

/**
 * Parses a JSON request body.
 * @param body the raw body
 * @returns the object (empty when there is no body)
 */
function parseBody(body: string | undefined): Record<string, unknown> {
  if (!body) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the error below
  }
  throw new HttpError(400, 'The request was not understood.');
}

/**
 * Reads and checks one text field from a form.
 * @param value the submitted value
 * @param label the field's name, for the error message
 * @param required whether it must be filled in
 * @param maxLength the longest text accepted
 * @returns the trimmed text
 */
function field(value: unknown, label: string, required: boolean, maxLength = MAX_FIELD): string {
  const textValue = typeof value === 'string' ? value.trim() : '';
  if (required && !textValue) {
    throw new HttpError(400, `${label} is required.`);
  }
  if (textValue.length > maxLength) {
    throw new HttpError(400, `${label} is too long.`);
  }
  return textValue;
}

/**
 * Formats a date as YYYY-MM-DD (UTC).
 * @param date the date
 * @returns the text
 */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Rounds to whole cents, so sums of decimals don't show 199.99999.
 * @param value the amount
 * @returns the rounded amount
 */
function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
