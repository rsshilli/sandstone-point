import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DescribeUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { handleApiRequest, HttpError, type ApiDeps } from '../lib/portal/api';
import { createTokenVerifier } from '../lib/portal/auth';
import { FileSheetSource } from '../lib/portal/file-sheet';
import { GoogleSheetSource, type GoogleSheetConfig } from '../lib/portal/google-sheet';
import { LogBoardMailer } from '../lib/portal/mailer';
import type { OwnerContact, SheetSource, SheetValues } from '../lib/portal/sheet';
import { startServer, type DevCode } from './serve';

const ROOT = resolve(__dirname, '..');
const CONTAINER = 'sandstone-cognito-local';
/** cognito-local listens on 9229 inside Docker; 9229 on this Mac belongs to another project's debugger. */
const COGNITO_PORT = Number(process.env.COGNITO_PORT ?? 9239);
const COGNITO_URL = `http://127.0.0.1:${COGNITO_PORT}`;
const SITE_PORT = Number(process.env.PORT ?? 4321);
const POOL_FILE = join(ROOT, '.cognito', 'dev-pool.json');
const REAL_SHEET_FILE = join(homedir(), '.config', 'sandstone', 'google-sheets.json');
/** Password for every made-up local user (fake accounts on a local-only Cognito). */
const DEV_PASSWORD = 'Sandstone-dev-1';
/** Made-up users matching dev/fake-sheet.json: an admin, an owner, and two strangers. */
const DEV_USERS = ['admin@example.com', 'owner@example.com', 'pending@example.com', 'newcomer@example.com'];

/**
 * `npm run dev`: the whole owner login on this Mac. Starts cognito-local in Docker, makes the
 * user pool and the fake users, prints sign-up codes as they are sent, and serves the site plus
 * the portal API on http://localhost:4321. When ~/.config/sandstone/google-sheets.json exists it
 * reads the real owners sheet, read-only (local sign-ups skip the email check, so they must
 * never write to real records); `--fake` uses the made-up data instead.
 */
async function main(): Promise<void> {
  const real = !process.argv.includes('--fake') && existsSync(REAL_SHEET_FILE);
  ensureContainer();
  await waitForCognito();
  const cognito = new CognitoIdentityProviderClient({
    endpoint: COGNITO_URL,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const pool = await ensurePool(cognito);
  await seedUsers(cognito, pool.userPoolId);
  const codes = followCodes();

  const deps: ApiDeps = {
    source: real
      ? new ReadOnlySheetSource(new GoogleSheetSource(JSON.parse(readFileSync(REAL_SHEET_FILE, 'utf8')) as GoogleSheetConfig))
      : new FileSheetSource(join(ROOT, '.local', 'sheet.json'), join(ROOT, 'dev', 'fake-sheet.json')),
    verifier: createTokenVerifier({
      // cognito-local stamps tokens with its in-container address, whatever port Docker maps.
      issuer: `http://0.0.0.0:9229/${pool.userPoolId}`,
      jwksUrl: `${COGNITO_URL}/${pool.userPoolId}/.well-known/jwks.json`,
      clientId: pool.clientId,
      requireVerifiedEmail: false,
    }),
    // Locally, messages to the board are printed in this terminal, never emailed.
    mailer: new LogBoardMailer(),
  };
  const server = startServer(SITE_PORT, {
    api: (request) => handleApiRequest(request, deps),
    config: {
      region: 'us-east-1',
      userPoolId: pool.userPoolId,
      clientId: pool.clientId,
      cognitoEndpoint: `http://localhost:${COGNITO_PORT}/`,
      // Tells the login page it may print emailed codes in the browser console (local only).
      devCodes: 'true',
    },
    devCode: (email) => codes.get(email),
  });
  server.on('listening', () => {
    console.log(`\nSandstone Point with owner login: http://localhost:${SITE_PORT}/login.html`);
    console.log(`Data: ${real ? 'the REAL owners sheet; only owner contact saves write to it (--fake for made-up data)' : 'fake data (.local/sheet.json; delete it to reset)'}`);
    if (!real) {
      console.log(`Fake users (password ${DEV_PASSWORD}): ${DEV_USERS.join(', ')}`);
    }
    console.log('Sign-up and reset codes appear below. Ctrl+C stops the site; cognito-local keeps running in Docker.\n');
  });
}

/**
 * Starts the cognito-local container, creating it the first time. Its data lives in .cognito/.
 */
function ensureContainer(): void {
  const state = docker(['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.State}}']).trim();
  if (state === 'running') {
    return;
  }
  if (state) {
    docker(['start', CONTAINER]);
    return;
  }
  mkdirSync(join(ROOT, '.cognito'), { recursive: true });
  docker(['run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${COGNITO_PORT}:9229`, '-v', `${join(ROOT, '.cognito')}:/app/.cognito`, 'jagregory/cognito-local:latest']);
}

/**
 * Waits up to 20 seconds for cognito-local to answer.
 */
async function waitForCognito(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(COGNITO_URL);
      return;
    } catch {
      await new Promise((wait) => setTimeout(wait, 500));
    }
  }
  throw new Error(`cognito-local did not start on ${COGNITO_URL}. Is Docker running? Try: docker logs ${CONTAINER}`);
}

/**
 * Reuses the local user pool from .cognito/dev-pool.json, or creates one shaped like the AWS
 * pool: email is the username, email is verified by code, and the web client signs in with a
 * password.
 * @param cognito the cognito-local client
 * @returns the pool and client ids
 */
async function ensurePool(cognito: CognitoIdentityProviderClient): Promise<{ userPoolId: string; clientId: string }> {
  if (existsSync(POOL_FILE)) {
    const saved = JSON.parse(readFileSync(POOL_FILE, 'utf8')) as { userPoolId: string; clientId: string };
    try {
      await cognito.send(new DescribeUserPoolCommand({ UserPoolId: saved.userPoolId }));
      return saved;
    } catch {
      // the pool is gone (cognito-local data was wiped); make a new one
    }
  }
  const pool = await cognito.send(
    new CreateUserPoolCommand({ PoolName: 'sandstone-owners', UsernameAttributes: ['email'], AutoVerifiedAttributes: ['email'] }),
  );
  const userPoolId = pool.UserPool?.Id ?? '';
  const client = await cognito.send(
    new CreateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientName: 'web',
      ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    }),
  );
  const saved = { userPoolId, clientId: client.UserPoolClient?.ClientId ?? '' };
  writeFileSync(POOL_FILE, `${JSON.stringify(saved, null, 2)}\n`);
  return saved;
}

/**
 * Creates the made-up users with a known password, skipping any that already exist.
 * @param cognito the cognito-local client
 * @param userPoolId the local pool
 */
async function seedUsers(cognito: CognitoIdentityProviderClient, userPoolId: string): Promise<void> {
  for (const email of DEV_USERS) {
    try {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
        }),
      );
      await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: email, Password: DEV_PASSWORD, Permanent: true }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'UsernameExistsException') {
        throw error;
      }
    }
  }
}

/**
 * Follows cognito-local's log and prints each emailed code ("Code for x@y: 123456"), since
 * nothing is really emailed locally.
 * @returns the latest code per lower-cased email, for the login page's /dev/code lookup
 */
function followCodes(): Map<string, DevCode> {
  const codes = new Map<string, DevCode>();
  const logs = spawn('docker', ['logs', '-f', '--since', '1s', CONTAINER]);
  let destination = '';
  const onChunk = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const dest = /Destination:\s+(\S+)/.exec(line);
      if (dest) {
        destination = dest[1];
      }
      const code = /Code:\s+(\d+)/.exec(line);
      if (code) {
        console.log(`Code for ${destination || 'a user'}: ${code[1]}`);
        if (destination) {
          codes.set(destination.toLowerCase(), { code: code[1], sentAt: Date.now() });
        }
      }
    }
  };
  logs.stdout.on('data', onChunk);
  logs.stderr.on('data', onChunk);
  process.on('exit', () => logs.kill());
  return codes;
}

/**
 * Runs a docker command.
 * @param args the arguments
 * @returns its standard output
 */
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' });
}

/**
 * Reads a sheet but refuses every write except an admin's contact-detail save, for local previews of
 * the real owner records (Ryan, 2026-11-22: fill in contacts before the site is deployed). Sign-up
 * requests and approvals stay blocked.
 */
class ReadOnlySheetSource implements SheetSource {
  /** @param inner the real sheet */
  constructor(private readonly inner: SheetSource) {}

  /** @inheritdoc */
  readValues(options?: { fresh?: boolean }): Promise<SheetValues> {
    return this.inner.readValues(options);
  }

  /** @inheritdoc */
  appendRequest(): Promise<void> {
    return this.refuse();
  }

  /** @inheritdoc */
  setRequestStatus(): Promise<void> {
    return this.refuse();
  }

  /** @inheritdoc */
  setOwnerEmails(): Promise<void> {
    return this.refuse();
  }

  /** @inheritdoc */
  setOwnerContact(row: number, contact: OwnerContact): Promise<void> {
    return this.inner.setOwnerContact(row, contact);
  }

  /**
   * Turns a write into a plain-words error the page shows.
   * @returns never; always rejects
   */
  private refuse(): Promise<void> {
    return Promise.reject(new HttpError(403, 'The local preview only saves owner contact details to the real sheet. Use npm run dev:fake to try other changes.'));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
