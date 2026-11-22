import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const SITE_DIR = resolve(__dirname, '..', 'site');
const DEFAULT_PORT = 4321;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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

/**
 * Serves the site/ folder the way CloudFront will: "/" shows index.html, and a missing page
 * shows 404.html with a 404 status.
 * @param port the port to listen on; 0 picks any free port (used by the tests)
 * @returns the running HTTP server
 */
export function startServer(port: number): Server {
  const server = createServer((request, response) => {
    const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
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
