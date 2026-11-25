import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ApiRequest, ApiResponse } from '../lib/portal/api';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const SITE_DIR = resolve(__dirname, '..', 'site');
const DEFAULT_PORT = 4321;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/**
 * Starts the local preview when this file is run directly (`npm start`), on PORT or 4321.
 */
function main(): void {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = startServer(port);
  server.on('listening', () => {
    console.log(`Sandstone Point preview: http://localhost:${port}  (Ctrl+C to stop)`);
  });
}

/** Extras for the full local stack (`npm run dev`); the plain preview (`npm start`) has neither. */
export interface ServerOptions {
  /** Answers /api/* (the portal API, as the Cloud Function does behind Firebase Hosting). */
  api?: (request: ApiRequest) => Promise<ApiResponse>;
  /** Served as /config.json: the Firebase web settings (and, locally, the Auth emulator's address). */
  config?: Record<string, string>;
}

/**
 * Serves the site/ folder the way Firebase Hosting does: "/" shows index.html, and a missing page
 * shows 404.html with a 404 status. With options it also serves /config.json and /api/*.
 * @param port the port to listen on; 0 picks any free port (used by the tests)
 * @param options the API handler and login config, for the full local stack
 * @returns the running HTTP server
 */
export function startServer(port: number, options: ServerOptions = {}): Server {
  const server = createServer((request, response) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
    } catch {
      sendJson(response, 400, { error: 'Bad address.' });
      return;
    }
    if (options.config && urlPath === '/config.json') {
      sendJson(response, 200, options.config);
      return;
    }
    if (options.api && urlPath.startsWith('/api/')) {
      const api = options.api;
      readBody(request)
        .then((body) => api({ method: request.method ?? 'GET', path: urlPath, authorization: request.headers.authorization, body }))
        .then((result) => sendJson(response, result.status, result.body))
        .catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
      return;
    }
    resolveFile(urlPath)
      .then(async (file) => {
        if (file) {
          response.writeHead(200, { 'Content-Type': contentType(file) });
          response.end(await readFile(file));
          return;
        }
        response.writeHead(404, { 'Content-Type': CONTENT_TYPES['.html'] });
        response.end(await readFile(join(SITE_DIR, '404.html')));
      })
      .catch((error: unknown) => {
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end(String(error));
      });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/**
 * Sends a JSON response that is never cached.
 * @param response the response
 * @param status HTTP status
 * @param body the body to serialise
 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

/**
 * Reads a request body as text (capped at 64 KB, like a small form needs).
 * @param request the request
 * @returns the body, or undefined when empty
 */
function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((done, fail) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 65_536) {
        request.destroy();
        fail(new Error('Request body too large'));
      }
    });
    request.on('end', () => done(body || undefined));
    request.on('error', fail);
  });
}

/**
 * Maps a URL path to a file inside site/, refusing anything that escapes the folder.
 * @param urlPath the decoded path from the request, e.g. "/assets/sunset.jpg"
 * @returns the absolute file path, or undefined when there is no such file
 */
async function resolveFile(urlPath: string): Promise<string | undefined> {
  let file = normalize(join(SITE_DIR, urlPath));
  if (file !== SITE_DIR && !file.startsWith(SITE_DIR + sep)) {
    return undefined;
  }
  try {
    if ((await stat(file)).isDirectory()) {
      file = join(file, 'index.html');
    }
    return (await stat(file)).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Picks the Content-Type header for a file from its extension.
 * @param file the file path
 * @returns the MIME type, or a generic binary type for unknown extensions
 */
function contentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

if (require.main === module) {
  main();
}
