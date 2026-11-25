// The deployed API: one 2nd-gen Cloud Function, reached through Firebase Hosting's /api/** rewrite.
// Bundled by scripts/build-function.ts into functions/lib/index.js.
import { defineSecret, defineString } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import type { ApiDeps } from './api';
import { buildDeps, handleHttp } from './cloud-function';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const SPREADSHEET_ID = defineString('SPREADSHEET_ID');
const BOARD_EMAIL_FROM = defineString('BOARD_EMAIL_FROM', { default: '' });
const RUNTIME_ACCOUNT = defineString('RUNTIME_SERVICE_ACCOUNT');

let deps: ApiDeps | undefined;

/** The portal API. Runs as the HOA's robot account, which the owner sheet is shared with. */
export const api = onRequest(
  {
    region: 'us-central1',
    serviceAccount: RUNTIME_ACCOUNT,
    secrets: [RESEND_API_KEY],
    memory: '256MiB',
    timeoutSeconds: 30,
    maxInstances: 5,
    invoker: 'public',
  },
  async (request, response) => {
    await handleHttp(request, response, () => {
      deps ??= buildDeps({
        projectId: process.env.GCLOUD_PROJECT ?? '',
        spreadsheetId: SPREADSHEET_ID.value(),
        resendApiKey: RESEND_API_KEY.value(),
        boardEmailFrom: BOARD_EMAIL_FROM.value(),
      });
      return deps;
    });
  },
);
