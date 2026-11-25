import { describe, it, expect } from 'vitest';
import { SignJWT, UnsecuredJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createTokenVerifier } from '../lib/portal/auth';
import type { ApiDeps } from '../lib/portal/api';
import { buildDeps, handleHttp, type HttpResponse } from '../lib/portal/cloud-function';
import { FileSheetSource } from '../lib/portal/file-sheet';
import { ResendBoardMailer } from '../lib/portal/mailer';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A response that records what was written to it. */
function recorder(): HttpResponse & { code: number; headers: Record<string, string>; body: string } {
  const response = {
    code: 0,
    headers: {} as Record<string, string>,
    body: '',
    status(code: number) {
      response.code = code;
      return response;
    },
    set(field: string, value: string) {
      response.headers[field] = value;
      return response;
    },
    send(body: string) {
      response.body = body;
    },
  };
  return response;
}

const SETTINGS = { projectId: 'p', spreadsheetId: 's', resendApiKey: 'unset', boardEmailFrom: '' };

describe('Cloud Function wrapper', () => {
  it('should pass the path without its query, the bearer header and the body to the API, and answer uncached JSON', async () => {
    const seen: (string | undefined)[] = [];
    const deps: ApiDeps = {
      source: new FileSheetSource(join(mkdtempSync(join(tmpdir(), 'fn-')), 'sheet.json'), join(__dirname, '..', 'dev', 'fake-sheet.json')),
      verifier: {
        verify: async (authorization) => {
          seen.push(authorization);
          return { email: 'owner@example.com', sub: 'u1' };
        },
      },
    };
    const response = recorder();
    await handleHttp({ method: 'GET', originalUrl: '/api/me?x=1', headers: { authorization: 'Bearer abc' }, rawBody: Buffer.alloc(0) }, response, () => deps);
    expect(seen).toEqual(['Bearer abc']);
    expect(response.code).toBe(200);
    expect(response.headers).toEqual({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    expect(JSON.parse(response.body)).toMatchObject({ kind: 'member', email: 'owner@example.com' });
  });

  it('should answer 503 in plain words when setup fails', async () => {
    const response = recorder();
    await handleHttp({ method: 'GET', originalUrl: '/api/me', headers: {} }, response, () => {
      throw new Error('no settings');
    });
    expect(response.code).toBe(503);
    expect(JSON.parse(response.body).error).toBe('Owner accounts are not set up yet. Please try again later.');
  });

  it('should refuse unsigned and unconfirmed-email tokens with the deployed verifier', async () => {
    const { verifier } = buildDeps(SETTINGS);
    const claims = (verified: boolean) => new UnsecuredJWT({ email: 'owner@example.com', email_verified: verified }).setIssuer('https://securetoken.google.com/p').setAudience('p').setSubject('u1').setExpirationTime('1h');
    await expect(verifier.verify(`Bearer ${claims(true).encode()}`)).rejects.toThrow('Your sign-in has expired');
    const pair = await generateKeyPair('RS256');
    const unverified = await new SignJWT({ email: 'owner@example.com', email_verified: false }).setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer('https://securetoken.google.com/p').setAudience('p').setSubject('u1').setExpirationTime('1h').sign(pair.privateKey);
    const keyed = createTokenVerifier({ projectId: 'p', requireVerifiedEmail: true, keys: createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'RS256' }] }) });
    await expect(keyed.verify(`Bearer ${unverified}`)).rejects.toThrow('confirm your email');
  });

  it('should keep the board form off until there is a real Resend key and a sender', () => {
    expect(buildDeps(SETTINGS).mailer).toBeUndefined();
    expect(buildDeps({ ...SETTINGS, resendApiKey: 're_live' }).mailer).toBeUndefined();
    expect(buildDeps({ ...SETTINGS, boardEmailFrom: 'Site <web@example.org>' }).mailer).toBeUndefined();
    expect(buildDeps({ ...SETTINGS, resendApiKey: 're_live', boardEmailFrom: 'Site <web@example.org>' }).mailer).toBeInstanceOf(ResendBoardMailer);
  });
});
