import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { handleApiRequest, type ApiDeps } from '../lib/portal/api';
import { createTokenVerifier } from '../lib/portal/auth';
import { FileSheetSource } from '../lib/portal/file-sheet';
import { parseSheet, type SheetValues } from '../lib/portal/sheet';

const SEED = join(__dirname, '..', 'dev', 'fake-sheet.json');
const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST';
const CLIENT_ID = 'test-client';

let privateKey: CryptoKey;
let jwk: JWK;
let workingFile: string;
let deps: ApiDeps;

/**
 * Signs a Cognito-style ID token with the test key.
 * @param email the token's email
 * @param overrides claims to change (e.g. a different audience)
 * @returns the "Bearer ..." header value
 */
async function bearer(email: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const token = await new SignJWT({ email, email_verified: true, token_use: 'id', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer((overrides.iss as string) ?? ISSUER)
    .setAudience((overrides.aud as string) ?? CLIENT_ID)
    .setSubject(`sub-${email}`)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  return `Bearer ${token}`;
}

/**
 * Calls the API as someone.
 * @param method HTTP method
 * @param path the API path
 * @param email who is signed in (undefined = no token)
 * @param body JSON body
 * @returns the API response
 */
async function call(method: string, path: string, email?: string, body?: unknown): Promise<{ status: number; body: any }> {
  return handleApiRequest(
    { method, path, authorization: email ? await bearer(email) : undefined, body: body === undefined ? undefined : JSON.stringify(body) },
    deps,
  ) as Promise<{ status: number; body: any }>;
}

/**
 * Reads the working fake sheet file back, to check what the API wrote.
 * @returns the raw rows
 */
function sheetOnDisk(): SheetValues {
  return JSON.parse(readFileSync(workingFile, 'utf8')) as SheetValues;
}

describe('portal API', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256' };
  });

  beforeEach(() => {
    workingFile = join(mkdtempSync(join(tmpdir(), 'portal-')), 'sheet.json');
    deps = {
      source: new FileSheetSource(workingFile, SEED),
      verifier: createTokenVerifier({ issuer: ISSUER, clientId: CLIENT_ID, requireVerifiedEmail: true, keys: createLocalJWKSet({ keys: [jwk] }) }),
      now: () => new Date('2026-11-22T15:00:00Z'),
    };
  });

  it('should refuse a call with no token, a token for another app, or an unverified email', async () => {
    expect((await call('GET', '/api/me')).status).toBe(401);
    const otherApp = await bearer('owner@example.com', { aud: 'someone-else' });
    expect((await handleApiRequest({ method: 'GET', path: '/api/me', authorization: otherApp }, deps)).status).toBe(401);
    const unverified = await bearer('owner@example.com', { email_verified: false });
    expect((await handleApiRequest({ method: 'GET', path: '/api/me', authorization: unverified }, deps)).status).toBe(401);
    const forged = (await bearer('owner@example.com')).slice(0, -4) + 'AAAA';
    expect((await handleApiRequest({ method: 'GET', path: '/api/me', authorization: forged }, deps)).status).toBe(401);
  });

  it('should show an owner their lots, balance worked out from the payments, and gate code', async () => {
    const { status, body } = await call('GET', '/api/me', 'Owner@Example.com');
    expect(status).toBe(200);
    expect(body.kind).toBe('member');
    expect(body.name).toBe('Pat Owner');
    expect(body.gateCode).toBe('2222');
    expect(body.lots.map((lot: { lot: string }) => lot.lot)).toEqual(['2', '3']);
    expect(body.lots[0]).toMatchObject({ balance: 80, owners: ['Pat Owner', 'Sam Owner'] });
    expect(body.lots[1]).toMatchObject({ balance: 200 });
    expect(body.totalOwed).toBe(280);
    expect(body.ledger).toHaveLength(3);
    expect(body.allLots).toBeUndefined();
  });

  it('should show an admin every lot with owners, balances and gate codes', async () => {
    const { body } = await call('GET', '/api/me', 'admin@example.com');
    expect(body.role).toBe('Admin');
    expect(body.allLots).toHaveLength(6);
    expect(body.allLots[1]).toMatchObject({ lot: '2', balance: 80, gateCodes: ['2222', '3333'], hasLogin: true });
    expect(body.allLots[3]).toMatchObject({ lot: '4', gateCodes: ['4444'], hasLogin: false });
  });

  it('should list people and tax-record names separately, so a company appears only by its tax name', async () => {
    const { body } = await call('GET', '/api/me', 'admin@example.com');
    const byLot = new Map(body.allLots.map((lot: { lot: string }) => [lot.lot, lot]));
    expect(byLot.get('2')).toMatchObject({ owners: ['Pat Owner', 'Sam Owner'], taxNames: ['OWNER PAT & SAM', 'OWNER SAM'] });
    const company = body.allLots.find((lot: { taxNames: string[] }) => lot.taxNames.includes('SAMPLE HOLDINGS LLC'));
    expect(company).toBeDefined();
    expect(company.owners).toEqual([]);
    expect(company.people).toEqual([{ id: 'O-004', name: '', taxName: 'SAMPLE HOLDINGS LLC' }]);
  });

  it('should show nothing private to an Inactive owner or a stranger, only their request status', async () => {
    const former = await call('GET', '/api/me', 'former@example.com');
    expect(former.body).toEqual({ kind: 'visitor', email: 'former@example.com', request: null });
    const pending = await call('GET', '/api/me', 'pending@example.com');
    expect(pending.body.request).toEqual({ status: 'Pending', submitted: '2026-11-20' });
  });

  it('should record a stranger\'s request once, as plain text, and refuse a second while pending', async () => {
    const first = await call('POST', '/api/requests', 'new@example.com', { name: '=IMPORTXML("http://x")', phone: '', lots: '6' });
    expect(first.status).toBe(201);
    expect(sheetOnDisk().requests.at(-1)).toEqual(['2026-11-22', '=IMPORTXML("http://x")', 'new@example.com', '', '6', 'Pending', '', '', '']);
    expect((await call('POST', '/api/requests', 'new@example.com', { name: 'Again', lots: '6' })).status).toBe(409);
    expect((await call('POST', '/api/requests', 'owner@example.com', { name: 'Pat', lots: '2' })).status).toBe(409);
    expect((await call('POST', '/api/requests', 'blank@example.com', { name: '', lots: '6' })).status).toBe(400);
    expect((await call('POST', '/api/requests', 'long@example.com', { name: 'x'.repeat(500), lots: '6' })).status).toBe(400);
  });

  it('should let only admins list and review requests', async () => {
    expect((await call('GET', '/api/admin/requests', 'owner@example.com')).status).toBe(403);
    expect((await call('POST', '/api/admin/requests/approve', 'owner@example.com', { email: 'pending@example.com', ownerId: 'O-004' })).status).toBe(403);
    const { status, body } = await call('GET', '/api/admin/requests', 'admin@example.com');
    expect(status).toBe(200);
    expect(body.requests).toEqual([expect.objectContaining({ email: 'pending@example.com', suggestedOwnerIds: ['O-004'] })]);
    expect(body.owners.map((owner: { id: string }) => owner.id)).toEqual(['O-002', 'O-003', 'O-004']);
  });

  it('should refuse to approve anyone onto an admin record, and never suggest one', async () => {
    await call('POST', '/api/requests', 'sneaky@example.com', { name: 'Sneaky', lots: '1' });
    const { body } = await call('GET', '/api/admin/requests', 'admin@example.com');
    expect(body.requests.find((request: { email: string }) => request.email === 'sneaky@example.com').suggestedOwnerIds).toEqual([]);
    const approved = await call('POST', '/api/admin/requests/approve', 'admin@example.com', { email: 'sneaky@example.com', ownerId: 'O-001' });
    expect(approved.status).toBe(400);
    expect(sheetOnDisk().owners[0][4]).toBe('admin@example.com');
  });

  it('should show someone on two owner records the lots and gate codes of both', async () => {
    await call('GET', '/api/me', 'owner@example.com');
    const sheet = sheetOnDisk();
    sheet.owners[3][4] = 'owner@example.com';
    writeFileSync(workingFile, JSON.stringify(sheet));
    const { body } = await call('GET', '/api/me', 'owner@example.com');
    expect(body.lots.map((lot: { lot: string }) => lot.lot)).toEqual(['2', '3', '4']);
    expect(body).toMatchObject({ name: 'Pat Owner', gateCode: '2222, 4444', totalOwed: 480 });
  });

  it('should give an admin every owner record with email, phone and mailing address, and refuse an owner', async () => {
    const { status, body } = await call('GET', '/api/admin/owners', 'admin@example.com');
    expect(status).toBe(200);
    expect(body.owners).toHaveLength(5);
    expect(body.owners[3]).toEqual({
      id: 'O-004',
      name: '',
      taxName: 'SAMPLE HOLDINGS LLC',
      emails: [],
      phone: '',
      mailingAddress: '4 Example Rd, Nowhere, KY 00000',
      role: 'Owner',
      active: true,
      lots: ['4'],
    });
    expect((await call('GET', '/api/admin/owners', 'owner@example.com')).status).toBe(403);
    expect((await call('POST', '/api/admin/owners/contact', 'owner@example.com', { ownerId: 'O-003', phone: '1' })).status).toBe(403);
  });

  it('should save an owner contact into Email, Phone and Mailing address, after which that email can sign in', async () => {
    const saved = await call('POST', '/api/admin/owners/contact', 'admin@example.com', {
      ownerId: 'O-003',
      emails: ' Sam@Example.com, sam@example.com; work@example.com ',
      phone: ' 555-0199 ',
      mailingAddress: 'PO Box 9, Monticello, KY',
      previous: { emails: [], phone: '', mailingAddress: '2 Example Rd, Nowhere, KY 00000' },
    });
    expect(saved).toEqual({
      status: 200,
      body: { ok: true, emails: ['sam@example.com', 'work@example.com'], phone: '555-0199', mailingAddress: 'PO Box 9, Monticello, KY' },
    });
    expect(sheetOnDisk().owners[2].slice(4, 7)).toEqual(['sam@example.com, work@example.com', '555-0199', 'PO Box 9, Monticello, KY']);
    const me = await call('GET', '/api/me', 'work@example.com');
    expect(me.body).toMatchObject({ kind: 'member', gateCode: '3333' });
  });

  it('should refuse a contact save with a bad email, an unknown owner, or a changed admin email', async () => {
    await call('GET', '/api/me', 'admin@example.com');
    const before = JSON.stringify(sheetOnDisk().owners);
    const sam = { emails: [], phone: '', mailingAddress: '2 Example Rd, Nowhere, KY 00000' };
    const bad = await call('POST', '/api/admin/owners/contact', 'admin@example.com', { ownerId: 'O-003', emails: 'not-an-email', previous: sam });
    expect(bad).toEqual({ status: 400, body: { error: '"not-an-email" doesn\'t look like an email address.' } });
    const query = await call('POST', '/api/admin/owners/contact', 'admin@example.com', { ownerId: 'O-003', emails: 'a@x.com?subject=hi', previous: sam });
    expect(query.status).toBe(400);
    expect((await call('POST', '/api/admin/owners/contact', 'admin@example.com', { ownerId: 'O-999', emails: '' })).status).toBe(404);
    const alex = { emails: ['admin@example.com'], phone: '555-0101', mailingAddress: '1 Example Rd, Nowhere, KY 00000' };
    const adminEmail = await call('POST', '/api/admin/owners/contact', 'admin@example.com', { ownerId: 'O-001', emails: 'thief@example.com', previous: alex });
    expect(adminEmail.status).toBe(400);
    const frankie = { emails: ['former@example.com'], phone: '', mailingAddress: '5 Example Rd, Nowhere, KY 00000' };
    const inactive = await call('POST', '/api/admin/owners/contact', 'admin@example.com', { ownerId: 'O-005', emails: 'new@example.com', previous: frankie });
    expect(inactive.status).toBe(400);
    expect(JSON.stringify(sheetOnDisk().owners)).toBe(before);
    const adminPhone = await call('POST', '/api/admin/owners/contact', 'admin@example.com', {
      ownerId: 'O-001',
      emails: 'ADMIN@example.com',
      phone: '555-0000',
      mailingAddress: alex.mailingAddress,
      previous: alex,
    });
    expect(adminPhone.status).toBe(200);
    expect(sheetOnDisk().owners[0].slice(4, 6)).toEqual(['admin@example.com', '555-0000']);
  });

  it('should refuse a contact save when the sheet changed after the page loaded, so a removed email stays removed', async () => {
    await call('GET', '/api/me', 'admin@example.com');
    const sheet = sheetOnDisk();
    sheet.owners[1][4] = ''; // the board takes the email off in the sheet
    writeFileSync(workingFile, JSON.stringify(sheet));
    const stale = await call('POST', '/api/admin/owners/contact', 'admin@example.com', {
      ownerId: 'O-002',
      emails: 'owner@example.com',
      phone: '555-9999',
      mailingAddress: '2 Example Rd, Nowhere, KY 00000',
      previous: { emails: ['owner@example.com'], phone: '555-0102', mailingAddress: '2 Example Rd, Nowhere, KY 00000' },
    });
    expect(stale.status).toBe(409);
    expect(sheetOnDisk().owners[1].slice(4, 6)).toEqual(['', '555-0102']);
    expect((await call('POST', '/api/admin/owners/contact', 'admin@example.com', { ownerId: 'O-002', phone: '1' })).status).toBe(409);
  });

  it('should leave the Email cell untouched, notes and all, when only the phone changes', async () => {
    await call('GET', '/api/me', 'admin@example.com');
    const sheet = sheetOnDisk();
    sheet.owners[1][4] = 'owner@example.com (work), owner@example.com';
    writeFileSync(workingFile, JSON.stringify(sheet));
    const saved = await call('POST', '/api/admin/owners/contact', 'admin@example.com', {
      ownerId: 'O-002',
      emails: 'owner@example.com',
      phone: '555-1234',
      mailingAddress: '2 Example Rd, Nowhere, KY 00000',
      previous: { emails: ['owner@example.com', 'owner@example.com'], phone: '555-0102', mailingAddress: '2 Example Rd, Nowhere, KY 00000' },
    });
    expect(saved.status).toBe(200);
    expect(sheetOnDisk().owners[1].slice(4, 6)).toEqual(['owner@example.com (work), owner@example.com', '555-1234']);
  });

  it('should refuse a request from an email holding a comma, semicolon or space', async () => {
    expect((await call('POST', '/api/requests', 'a,b@example.com', { name: 'A', lots: '6' })).status).toBe(400);
  });

  it('should approve by adding the email to the chosen owner, after which that person sees their lot', async () => {
    expect((await call('POST', '/api/admin/requests/approve', 'admin@example.com', { email: 'pending@example.com' })).status).toBe(400);
    const approved = await call('POST', '/api/admin/requests/approve', 'admin@example.com', { email: 'pending@example.com', ownerId: 'O-004' });
    expect(approved.status).toBe(200);
    const sheet = sheetOnDisk();
    expect(sheet.owners[3][4]).toBe('pending@example.com');
    expect(sheet.requests[0].slice(5, 8)).toEqual(['Approved', 'admin@example.com', '2026-11-22']);
    const me = await call('GET', '/api/me', 'pending@example.com');
    expect(me.body).toMatchObject({ kind: 'member', name: 'SAMPLE HOLDINGS LLC', gateCode: '4444', totalOwed: 200 });
    expect((await call('POST', '/api/admin/requests/approve', 'admin@example.com', { email: 'pending@example.com', ownerId: 'O-004' })).status).toBe(404);
  });

  it('should add a second email to an owner who already has one, and reject without touching Owners', async () => {
    await call('POST', '/api/requests', 'spouse@example.com', { name: 'Spouse', lots: '2' });
    await call('POST', '/api/admin/requests/approve', 'admin@example.com', { email: 'spouse@example.com', ownerId: 'O-002' });
    expect(sheetOnDisk().owners[1][4]).toBe('owner@example.com, spouse@example.com');
    expect((await call('GET', '/api/me', 'owner@example.com')).body.kind).toBe('member');

    const before = JSON.stringify(sheetOnDisk().owners);
    expect((await call('POST', '/api/admin/requests/reject', 'admin@example.com', { email: 'pending@example.com' })).status).toBe(200);
    expect(JSON.stringify(sheetOnDisk().owners)).toBe(before);
    expect((await call('GET', '/api/me', 'pending@example.com')).body.request.status).toBe('Rejected');
  });

  it('should answer 404 for an unknown path and 400 for a body that is not JSON', async () => {
    expect((await call('GET', '/api/nope', 'owner@example.com')).status).toBe(404);
    const bad = await handleApiRequest({ method: 'POST', path: '/api/requests', authorization: await bearer('x@example.com'), body: '{oops' }, deps);
    expect(bad.status).toBe(400);
  });
});

describe('parseSheet', () => {
  it('should treat only the word Active as active, and read request statuses whatever their case', () => {
    const owner = (id: string, status: string) => [id, '', 'A', 'B', `${id}@example.com`, '', '', 'Owner', '', status, ''];
    const data = parseSheet({
      owners: [owner('O-1', 'Active'), owner('O-2', 'active'), owner('O-3', ''), owner('O-4', 'Sold'), owner('O-5', 'Inactve')],
      lots: [],
      payments: [],
      requests: [['2026-11-01', 'A', 'a@example.com', '', '1', 'approved', '', '', ''], ['2026-11-01', 'B', 'b@example.com', '', '1', '', '', '', '']],
    });
    expect(data.owners.map((parsed) => parsed.active)).toEqual([true, true, false, false, false]);
    expect(data.requests.map((request) => request.status)).toEqual(['Approved', 'Pending']);
  });

  it('should read lot status and dues from after the two owner-name columns', () => {
    const data = parseSheet({
      owners: [],
      lots: [[7, 'O-1, O-2', 'Pat Owner, Sam Owner', 'OWNER PAT, OWNER SAM', 'Vacant lot', 200, 0, '', '003-50-01-007.00', 'Example Trail']],
      payments: [],
      requests: [],
    });
    expect(data.lots).toEqual([{ lot: '7', ownerIds: ['O-1', 'O-2'], status: 'Vacant lot', annualDues: 200 }]);
  });
});
