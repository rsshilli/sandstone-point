import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const siteDir = join(__dirname, '..', 'site');

/**
 * Reads every HTML and CSS file published from site/ into one string.
 * @returns the combined text of the public site
 */
function publicText(): string {
  return readdirSync(siteDir)
    .filter((name) => /\.(html|css)$/.test(name))
    .map((name) => readFileSync(join(siteDir, name), 'utf8'))
    .join('\n');
}

/**
 * Lists every local image path the home page refers to (assets/...).
 * @returns the unique relative image paths
 */
function referencedImages(): string[] {
  const html = readFileSync(join(siteDir, 'index.html'), 'utf8');
  return [...new Set(html.match(/assets\/[a-z0-9-]+\.jpg/g) ?? [])];
}

/**
 * Reads the private words that must never appear on the site (street names and the like) from a
 * gitignored file, so the public repo doesn't spell them out. Empty on a fresh clone.
 * @returns the terms, lower-cased, one per non-blank line
 */
function privateTerms(): string[] {
  const file = join(__dirname, '..', '.github', 'private-terms.txt');
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0);
}

describe('public site content', () => {
  it('should never publish a street address, email address or phone number', () => {
    const text = publicText().toLowerCase();
    for (const term of privateTerms()) {
      expect(text.includes(term), 'a private term from .github/private-terms.txt').toBe(false);
    }
    expect(text).not.toMatch(/\b\d{2,5}\s+[A-Z][a-z]+\s+(Cove|Trail|Road|Rd|Lane|Ln|Drive|Dr|Street|St)\b/);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    expect(text).not.toMatch(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/);
  });

  it('should state the current dues, $200 per year, on the membership page', () => {
    const membership = readFileSync(join(siteDir, 'membership.html'), 'utf8');
    expect(membership).toContain('Dues are $200 per year.');
  });

  it('should have every photo the home page shows', () => {
    const images = referencedImages();
    expect(images.length).toBeGreaterThanOrEqual(10);
    for (const image of images) {
      expect(existsSync(join(siteDir, image)), image).toBe(true);
    }
  });

  it('should have every document the pages link to, and link the membership page from the home page', () => {
    const pages = readdirSync(siteDir).filter((name) => name.endsWith('.html'));
    const docs = new Set(
      pages.flatMap((name) => readFileSync(join(siteDir, name), 'utf8').match(/\/docs\/[a-z0-9-]+\.pdf/g) ?? []),
    );
    expect(docs.size).toBeGreaterThanOrEqual(1);
    for (const doc of docs) {
      expect(existsSync(join(siteDir, doc)), doc).toBe(true);
    }
    expect(readFileSync(join(siteDir, 'index.html'), 'utf8')).toContain('href="/membership.html"');
  });

  it('should show the same menu items, in the same order, on every page', () => {
    const pages = readdirSync(siteDir).filter((name) => name.endsWith('.html'));
    const menus = pages
      .map((name) => readFileSync(join(siteDir, name), 'utf8').match(/<div class="nav-links">([\s\S]*?)<\/div>/)?.[1])
      .filter((links): links is string => links !== undefined)
      .map((links) => [...links.matchAll(/>([^<]+)<\/a>/g)].map((match) => match[1].trim()));
    expect(menus.length).toBeGreaterThanOrEqual(2);
    expect(menus[0].length).toBeGreaterThanOrEqual(5);
    for (const menu of menus) {
      expect(menu).toEqual(menus[0]);
    }
  });

  it('should ship photos without camera (EXIF) data, which can carry GPS location', () => {
    for (const image of referencedImages()) {
      const bytes = readFileSync(join(siteDir, image));
      expect(bytes.includes(Buffer.from('Exif\0\0')), image).toBe(false);
    }
  });
});
