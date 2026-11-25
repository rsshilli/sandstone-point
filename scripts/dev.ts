import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { handleApiRequest, HttpError, type ApiDeps } from '../lib/portal/api';
import { createTokenVerifier } from '../lib/portal/auth';
import { FileSheetSource } from '../lib/portal/file-sheet';
import { GoogleSheetSource, type GoogleSheetConfig } from '../lib/portal/google-sheet';
import { LogBoardMailer } from '../lib/portal/mailer';
import type { OwnerContact, SheetSource, SheetValues } from '../lib/portal/sheet';
import { startServer } from './serve';

const ROOT = resolve(__dirname, '..');
/** A "demo-" project id keeps the emulator fully offline: it never talks to the real project. */
const PROJECT_ID = 'demo-sandstone';
/** Firebase's Auth emulator port (also set in firebase.json). */
const AUTH_PORT = 9099;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const SITE_PORT = Number(process.env.PORT ?? 4321);
const REAL_SHEET_FILE = join(homedir(), '.config', 'sandstone', 'google-sheets.json');
/** Password for every made-up local user (fake accounts in a local-only emulator). */
const DEV_PASSWORD = 'Sandstone-dev-1';
/** Made-up users matching dev/fake-sheet.json: an admin, an owner, and two strangers. */
const DEV_USERS = ['admin@example.com', 'owner@example.com', 'pending@example.com', 'newcomer@example.com'];

/**
 * `npm run dev`: the whole owner login on this Mac. Starts Firebase's Auth emulator, adds the
 * fake users, and serves the site plus the portal API on http://localhost:4321. Emailed links
 * (confirm, reset) are printed in the browser console. When ~/.config/sandstone/google-sheets.json
 * exists it reads the real owners sheet, read-only (local sign-ups must never write to real
 * records); `--fake` uses the made-up data instead.
 */
async function main(): Promise<void> {
  const real = !process.argv.includes('--fake') && existsSync(REAL_SHEET_FILE);
  const emulator = startEmulator();
  await waitForEmulator(emulator);
  await seedUsers();

  const deps: ApiDeps = {
    source: real
      ? new ReadOnlySheetSource(new GoogleSheetSource(JSON.parse(readFileSync(REAL_SHEET_FILE, 'utf8')) as GoogleSheetConfig))
      : new FileSheetSource(join(ROOT, '.local', 'sheet.json'), join(ROOT, 'dev', 'fake-sheet.json')),
    verifier: createTokenVerifier({ projectId: PROJECT_ID, requireVerifiedEmail: true, emulator: true }),
    // Locally, messages to the board are printed in this terminal, never emailed.
    mailer: new LogBoardMailer(),
  };
  const server = startServer(SITE_PORT, {
    api: (request) => handleApiRequest(request, deps),
    config: { apiKey: 'local-dev', authDomain: `${PROJECT_ID}.firebaseapp.com`, projectId: PROJECT_ID, emulatorUrl: AUTH_URL },
  });
  server.on('listening', () => {
    console.log(`\nSandstone Point with owner login: http://localhost:${SITE_PORT}/login.html`);
    console.log(`Data: ${real ? 'the REAL owners sheet; only owner contact saves write to it (--fake for made-up data)' : 'fake data (.local/sheet.json; delete it to reset)'}`);
    console.log(`Fake users (password ${DEV_PASSWORD}): ${DEV_USERS.join(', ')}. "Sign in with Google" shows the emulator's pretend account picker.`);
    console.log('Emailed links appear in the browser console. Ctrl+C stops everything; the emulator forgets every account.\n');
  });
  const stop = (): void => {
    emulator.kill('SIGINT');
    server.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/**
 * Starts the Firebase Auth emulator as a child process, its output shown only on failure.
 * @returns the running emulator
 */
function startEmulator(): ChildProcess {
  const child = spawn('npx', ['firebase', 'emulators:start', '--only', 'auth', '--project', PROJECT_ID], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.on('exit', (code) => {
    if (code) {
      console.error(`The Firebase Auth emulator stopped (exit ${code}):\n${output.slice(-2000)}`);
      process.exitCode = 1;
    }
  });
  return child;
}

/**
 * Waits up to 30 seconds for the emulator to answer.
 * @param emulator the child process, to stop waiting if it dies
 */
async function waitForEmulator(emulator: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (emulator.exitCode !== null) {
      throw new Error('The Firebase Auth emulator did not start. Is port 9099 free? Did npm install finish?');
    }
    try {
      if ((await fetch(`${AUTH_URL}/emulator/v1/projects/${PROJECT_ID}/config`)).ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
  throw new Error(`The Firebase Auth emulator did not answer on ${AUTH_URL}.`);
}

/**
 * Creates the made-up users with a known password and a confirmed email. The emulator starts
 * empty every time, so they never already exist.
 */
async function seedUsers(): Promise<void> {
  for (const email of DEV_USERS) {
    // Sign-up has no per-project admin address on the emulator; any API key is accepted.
    const created = await emulatorCall('accounts:signUp?key=local-dev', { email, password: DEV_PASSWORD });
    await emulatorCall(`projects/${PROJECT_ID}/accounts:update`, { localId: created.localId, emailVerified: true });
  }
}

/**
 * Calls one Identity Toolkit action on the emulator as an admin ("Bearer owner" is the
 * emulator's built-in admin credential).
 * @param action the path after /v1/, e.g. "accounts:signUp?key=x"
 * @param body the request
 * @returns the response
 */
async function emulatorCall(action: string, body: object): Promise<{ localId: string }> {
  const response = await fetch(`${AUTH_URL}/identitytoolkit.googleapis.com/v1/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Auth emulator ${action} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { localId: string };
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
