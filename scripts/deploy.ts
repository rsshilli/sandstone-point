import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const PROJECT = 'sandstone-point-hoa';
/**
 * The HOA's own address. Google and Facebook sign-in run through it (Firebase Hosting serves
 * /__/auth/handler there), so their sign-in screens name it instead of the firebaseapp.com one.
 * Its handler URL must be listed in the Google OAuth client and the Meta app's redirect URIs.
 */
const SITE_DOMAIN = 'sandstonepoint.org';
/** The HOA's robot account. The owner sheet is shared with it, and the API runs as it. */
const RUNTIME_ACCOUNT = `sandstone-portal@${PROJECT}.iam.gserviceaccount.com`;
/** Holds the owner sheet's id (and a key, which deploys don't use). Kept out of git. */
const SHEET_SETTINGS = join(homedir(), '.config', 'sandstone', 'google-sheets.json');

/**
 * `npm run deploy`: builds the API, writes the two settings files Firebase reads (both
 * gitignored), and deploys the site and the API to Firebase. BOARD_EMAIL_FROM in the
 * environment (e.g. "Sandstone Point website <website@sandstonepoint.org>") switches on the
 * board form, once Resend can send from that domain.
 */
function main(): void {
  // The Firebase CLI loads the function on this machine to find it, so its packages must be installed here.
  run('npm', ['ci', '--prefix', 'functions', '--no-audit', '--no-fund']);
  run('npx', ['tsx', 'scripts/build-function.ts']);
  writeFunctionSettings();
  writeLoginConfig();
  run('npx', ['firebase', 'deploy', '--only', 'hosting,functions', '--project', PROJECT, '--non-interactive', '--force']);
}

/**
 * Writes functions/.env.<project>: which sheet to open, which account to run as, and the board
 * sender. These are settings, not secrets; the Resend key lives in Secret Manager.
 */
function writeFunctionSettings(): void {
  const { spreadsheetId } = JSON.parse(readFileSync(SHEET_SETTINGS, 'utf8')) as { spreadsheetId: string };
  const lines = [`SPREADSHEET_ID=${spreadsheetId}`, `RUNTIME_SERVICE_ACCOUNT=${RUNTIME_ACCOUNT}`, `BOARD_EMAIL_FROM=${process.env.BOARD_EMAIL_FROM ?? ''}`];
  writeFileSync(join(ROOT, 'functions', `.env.${PROJECT}`), `${lines.join('\n')}\n`);
}

/**
 * Writes site/config.json, the public Firebase web settings the login page starts from.
 */
function writeLoginConfig(): void {
  const output = run('npx', ['firebase', 'apps:sdkconfig', 'web', '--project', PROJECT, '--json'], true);
  // The settings arrive as JSON text inside the JSON reply (checked 2026-11-25, firebase-tools 15.37).
  const { result } = JSON.parse(output) as { result: { fileContents: string } };
  const { apiKey, authDomain, projectId } = JSON.parse(result.fileContents) as { apiKey: string; authDomain: string; projectId: string };
  if (!apiKey || !authDomain || projectId !== PROJECT) {
    throw new Error(`Unexpected Firebase web settings for ${PROJECT}`);
  }
  writeFileSync(join(ROOT, 'site', 'config.json'), `${JSON.stringify({ apiKey, authDomain: SITE_DOMAIN, projectId }, null, 2)}\n`);
}

/**
 * Runs a command in the project folder.
 * @param command the program
 * @param args its arguments
 * @param capture return its output instead of showing it
 * @returns the output when captured, else ''
 */
function run(command: string, args: string[], capture = false): string {
  // The Firebase CLI signs in with gcloud's credentials, and those need a quota project to call Firebase's APIs.
  const env = { ...process.env, GOOGLE_CLOUD_QUOTA_PROJECT: PROJECT };
  const output = execFileSync(command, args, { cwd: ROOT, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  return capture ? output : '';
}

main();
