import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { startServer } from '../scripts/serve';

let server: Server;
let base: string;

/**
 * Sends a GET without URL normalisation, so "../" reaches the server as typed.
 * @param path the raw request path
 * @returns the status code and body text
 */
function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request(`${base}${path}`, { path }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

describe('local preview server', () => {
  beforeAll(async () => {
    server = startServer(0);
    await new Promise((ready) => server.on('listening', ready));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('should serve the home page at /', async () => {
    const { status, body } = await get('/');
    expect(status).toBe(200);
    expect(body).toContain('Sandstone Point');
  });

  it('should serve photos from assets/', async () => {
    const { status } = await get('/assets/sunset.jpg');
    expect(status).toBe(200);
  });

  it('should serve the membership page and the court-order PDF it links to', async () => {
    const page = await get('/membership.html');
    expect(page.status).toBe(200);
    expect(page.body).toContain('Lots 1 through 139');
    const pdf = await get('/docs/2024-court-order-lots-1-139.pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.body.startsWith('%PDF')).toBe(true);
  });

  it('should show the 404 page with a 404 status for a missing page', async () => {
    const page = await get('/no-such-page');
    const notFound = await get('/404.html');
    expect(page.status).toBe(404);
    expect(page.body).toBe(notFound.body);
  });

  it('should not serve files outside the site folder', async () => {
    const { status, body } = await get('/../package.json');
    expect(status).toBe(404);
    expect(body).not.toContain('"devDependencies"');
  });
});
