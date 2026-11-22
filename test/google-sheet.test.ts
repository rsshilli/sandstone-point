import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { GoogleSheetSource } from '../lib/portal/google-sheet';
import { CachedSheetSource } from '../lib/portal/lambda';
import type { SheetValues } from '../lib/portal/sheet';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CONFIG = {
  spreadsheetId: 'SHEET123',
  client_email: 'robot@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

/** One request the fake Google saw. */
interface Seen {
  method: string;
  url: string;
  body?: string;
}

/**
 * A stand-in for Google: answers the token endpoint and the Sheets API, recording every call.
 * @returns the fetch function and the list of calls
 */
function fakeGoogle(): { fetchFn: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ method: init?.method ?? 'GET', url, body: init?.body ? String(init.body) : undefined });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }
    if (url.includes('values:batchGet')) {
      return new Response(JSON.stringify({ valueRanges: [{ values: [['O-1']] }, {}, {}, { values: [['d', 'n', 'e@x.com']] }] }));
    }
    return new Response('{}');
  }) as typeof fetch;
  return { fetchFn, seen };
}

describe('Google Sheets source', () => {
  it('should read all four tabs in one call, with unformatted numbers and an access token', async () => {
    const { fetchFn, seen } = fakeGoogle();
    const values = await new GoogleSheetSource(CONFIG, fetchFn).readValues();
    expect(values).toEqual({ owners: [['O-1']], lots: [], payments: [], requests: [['d', 'n', 'e@x.com']] });
    const assertion = new URLSearchParams(seen[0].body).get('assertion') ?? '';
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ iss: CONFIG.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets' });
    const read = new URL(seen[1].url);
    expect(read.pathname).toBe('/v4/spreadsheets/SHEET123/values:batchGet');
    expect(read.searchParams.getAll('ranges')).toEqual(['Owners!A2:K', 'Lots!A2:J', 'Payments!A2:G', "'Sign-up requests'!A2:I"]);
    expect(read.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
  });

  it('should write every change as RAW text, to the right cells', async () => {
    const { fetchFn, seen } = fakeGoogle();
    const source = new GoogleSheetSource(CONFIG, fetchFn);
    await source.appendRequest({ submitted: '2026-11-22', name: '=1+1', email: 'a@x.com', phone: '', lotsClaimed: '7' });
    await source.setRequestStatus(5, 'Approved', 'admin@x.com', '2026-11-22');
    await source.setOwnerEmails(9, ['a@x.com', 'b@x.com']);
    const writes = seen.filter((call) => !call.url.includes('oauth2'));
    expect(writes.map((call) => `${call.method} ${decodeURIComponent(new URL(call.url).pathname)}`)).toEqual([
      "POST /v4/spreadsheets/SHEET123/values/'Sign-up requests'!A:I:append",
      "PUT /v4/spreadsheets/SHEET123/values/'Sign-up requests'!F5:H5",
      'PUT /v4/spreadsheets/SHEET123/values/Owners!E9',
    ]);
    for (const call of writes) {
      expect(new URL(call.url).searchParams.get('valueInputOption')).toBe('RAW');
    }
    expect(JSON.parse(writes[0].body ?? '').values[0][1]).toBe('=1+1');
    expect(JSON.parse(writes[2].body ?? '').values).toEqual([['a@x.com, b@x.com']]);
    expect(seen.filter((call) => call.url.includes('oauth2'))).toHaveLength(1);
  });
});

describe('cached sheet source', () => {
  it('should reuse a read for the cache window and drop it after a write', async () => {
    let reads = 0;
    const empty: SheetValues = { owners: [], lots: [], payments: [], requests: [] };
    const inner = {
      readValues: async () => {
        reads += 1;
        return empty;
      },
      appendRequest: async () => undefined,
      setRequestStatus: async () => undefined,
      setOwnerEmails: async () => undefined,
    };
    let now = 0;
    const cached = new CachedSheetSource(inner, 1000, () => now);
    await cached.readValues();
    await cached.readValues();
    expect(reads).toBe(1);
    now = 1500;
    await cached.readValues();
    expect(reads).toBe(2);
    await cached.setOwnerEmails(2, []);
    await cached.readValues();
    expect(reads).toBe(3);
    await cached.readValues({ fresh: true });
    expect(reads).toBe(4);
  });
});
