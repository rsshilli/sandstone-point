import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { handleApiRequest, type ApiDeps } from './api';
import { createTokenVerifier } from './auth';
import { GoogleSheetSource, type GoogleSheetConfig } from './google-sheet';
import { SesBoardMailer } from './mailer';
import type { NewSignupRequest, OwnerContact, SheetSource, SheetValues } from './sheet';

/** The parts of an API Gateway HTTP API (payload 2.0) event we use. */
interface HttpApiEvent {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

/** The HTTP API (payload 2.0) response shape. */
interface HttpApiResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** How long sheet reads are reused within one warm Lambda, in milliseconds. */
const READ_CACHE_MS = 30_000;

let depsPromise: Promise<ApiDeps> | undefined;

/**
 * Lambda entry point for /api/*. Environment: USER_POOL_ID, CLIENT_ID, AWS_REGION and
 * GOOGLE_SECRET_ID (a Secrets Manager secret holding `{spreadsheetId, client_email, private_key}`).
 * Optional BOARD_EMAIL_FROM and BOARD_EMAIL_TO switch on owners' messages to the board (via SES).
 * @param event the HTTP API event
 * @returns the HTTP response
 */
export async function handler(event: HttpApiEvent): Promise<HttpApiResult> {
  let deps: ApiDeps;
  try {
    depsPromise ??= buildDeps();
    deps = await depsPromise;
  } catch (error) {
    depsPromise = undefined;
    console.error('portal setup failed', error);
    return json(503, { error: 'Owner accounts are not set up yet. Please try again later.' });
  }
  const headers = event.headers ?? {};
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const response = await handleApiRequest(
    { method: event.requestContext.http.method, path: event.rawPath, authorization: headers.authorization ?? headers.Authorization, body },
    deps,
  );
  return json(response.status, response.body);
}

/**
 * Builds the sheet source and token verifier once per Lambda instance.
 * @returns the API dependencies
 */
async function buildDeps(): Promise<ApiDeps> {
  const region = requireEnv('AWS_REGION');
  const userPoolId = requireEnv('USER_POOL_ID');
  const secrets = new SecretsManagerClient({ region });
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: requireEnv('GOOGLE_SECRET_ID') }));
  const config = JSON.parse(secret.SecretString ?? '{}') as GoogleSheetConfig;
  const boardFrom = process.env.BOARD_EMAIL_FROM;
  const boardTo = process.env.BOARD_EMAIL_TO;
  return {
    source: new CachedSheetSource(new GoogleSheetSource(config), READ_CACHE_MS),
    verifier: createTokenVerifier({
      issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
      clientId: requireEnv('CLIENT_ID'),
      requireVerifiedEmail: true,
    }),
    // Only set once the HOA domain is in the stack (SES sends from it); until then the form is hidden.
    mailer: boardFrom && boardTo ? new SesBoardMailer({ from: boardFrom, to: boardTo, region }) : undefined,
  };
}

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

/**
 * Builds a JSON response that browsers and CloudFront never cache.
 * @param statusCode HTTP status
 * @param body the body to serialise
 * @returns the response
 */
function json(statusCode: number, body: unknown): HttpApiResult {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

/**
 * Reads a required environment variable.
 * @param name the variable
 * @returns its value
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}
