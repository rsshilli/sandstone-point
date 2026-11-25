import { handleApiRequest, type ApiDeps } from './api';
import { createTokenVerifier } from './auth';
import { CachedSheetSource } from './cached-sheet';
import { GoogleSheetSource } from './google-sheet';
import { BOARD_EMAIL, ResendBoardMailer } from './mailer';

/** The parts of an incoming request (Express-shaped, as Cloud Functions passes it) we use. */
export interface HttpRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
}

/** The parts of a response we use. */
export interface HttpResponse {
  status(code: number): HttpResponse;
  set(field: string, value: string): HttpResponse;
  send(body: string): unknown;
}

/** What the function reads from its environment. */
export interface FunctionSettings {
  /** The Google Cloud project; Firebase ID tokens must be issued for it. */
  projectId: string;
  /** The owner-records spreadsheet. */
  spreadsheetId: string;
  /** Resend API key; the board form stays off until it is a real key ("re_…"). */
  resendApiKey: string;
  /** Sender on the HOA's domain; the board form stays off until it is set. */
  boardEmailFrom: string;
}

/** How long sheet reads are reused within one warm instance, in milliseconds. */
const READ_CACHE_MS = 30_000;

/**
 * Builds the API's dependencies from the function's settings. The sheet is reached as the
 * account the function runs as, so there is no key.
 * @param settings project, sheet and email settings
 * @returns the API dependencies
 */
export function buildDeps(settings: FunctionSettings): ApiDeps {
  const mailerOn = settings.resendApiKey.startsWith('re_') && settings.boardEmailFrom !== '';
  return {
    source: new CachedSheetSource(new GoogleSheetSource({ spreadsheetId: settings.spreadsheetId }), READ_CACHE_MS),
    verifier: createTokenVerifier({ projectId: settings.projectId, requireVerifiedEmail: true }),
    mailer: mailerOn ? new ResendBoardMailer({ from: settings.boardEmailFrom, to: BOARD_EMAIL, apiKey: settings.resendApiKey }) : undefined,
  };
}

/**
 * Answers one /api/* request: hands it to the portal API and writes back JSON that is never
 * cached. Setup failures answer 503 with plain words; the details go to the function's log.
 * @param request the incoming request
 * @param response the response to write
 * @param getDeps returns the API dependencies (built once per instance by the caller)
 */
export async function handleHttp(request: HttpRequest, response: HttpResponse, getDeps: () => ApiDeps): Promise<void> {
  let deps: ApiDeps;
  try {
    deps = getDeps();
  } catch (error) {
    console.error('portal setup failed', error);
    sendJson(response, 503, { error: 'Owner accounts are not set up yet. Please try again later.' });
    return;
  }
  const authorization = request.headers.authorization;
  const result = await handleApiRequest(
    {
      method: request.method,
      path: request.originalUrl.split('?')[0],
      authorization: Array.isArray(authorization) ? authorization[0] : authorization,
      body: request.rawBody && request.rawBody.length > 0 ? request.rawBody.toString('utf8') : undefined,
    },
    deps,
  );
  sendJson(response, result.status, result.body);
}

/**
 * Writes a JSON response that browsers and Firebase Hosting's cache never keep.
 * @param response the response
 * @param status HTTP status
 * @param body the body to serialise
 */
function sendJson(response: HttpResponse, status: number, body: unknown): void {
  response.status(status).set('Content-Type', 'application/json').set('Cache-Control', 'no-store').send(JSON.stringify(body));
}
