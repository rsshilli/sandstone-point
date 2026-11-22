// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
// @ts-expect-error plain browser JavaScript, no type declarations
import { showLotMap, TILE_URL } from '../site/js/lot-map.js';

const realMap = readFileSync(join(__dirname, '..', 'site', 'data', 'lot-map.json'), 'utf8');
// The same Leaflet file the site serves from site/vendor/leaflet.
const leaflet = createRequire(__filename)('../site/vendor/leaflet/leaflet.js');

/**
 * A fetch that answers /data/lot-map.json with the given status and body.
 * @param status the HTTP status
 * @param body the response text
 * @returns the fake fetch
 */
function fakeFetch(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

/**
 * A container on the page with a real size, since Leaflet measures it to pick a zoom.
 * @returns the container
 */
function sizedBox(): HTMLDivElement {
  const box = document.createElement('div');
  document.body.append(box);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  return box;
}

describe('showLotMap', () => {
  it('should highlight the owner lot, draw it last, and zoom close to it', async () => {
    const box = sizedBox();
    const map = await showLotMap(box, ['77', '2'], fakeFetch(200, realMap), leaflet);
    const shapes = [...box.querySelectorAll('path.lot')];
    expect(shapes.at(-1)?.getAttribute('class')).toContain('mine');
    expect(box.querySelectorAll('path.mine')).toHaveLength(1);
    expect(box.querySelector('.lot-label.mine')?.textContent).toBe('77');
    expect(box.querySelector('.lot-map-canvas')?.getAttribute('aria-label')).toBe('Aerial map of Sandstone Point with lot 77 highlighted');
    expect(map.getZoom()).toBeGreaterThanOrEqual(17);
    expect(box.querySelector('figcaption')?.textContent).toMatch(/^Lot 2 isn’t on the map yet/);
    expect(box.querySelector('figcaption')?.textContent).toContain('KyFromAbove');
  });

  it('should use the Kentucky aerial tiles and let the owner zoom in past the plat lines', async () => {
    const map = await showLotMap(sizedBox(), ['50'], fakeFetch(200, realMap), leaflet);
    let tiles: any;
    map.eachLayer((layer: any) => {
      if (layer._url) {
        tiles = layer;
      }
    });
    expect(tiles._url).toBe(TILE_URL);
    expect(map.getMaxZoom()).toBe(22);
  });

  it('should switch between the owner lots and the whole neighborhood', async () => {
    const box = sizedBox();
    const map = await showLotMap(box, ['50'], fakeFetch(200, realMap), leaflet);
    const button = box.querySelector('button')!;
    const close = map.getZoom();
    button.click();
    expect(map.getZoom()).toBeLessThan(close);
    expect(button.textContent).toBe('Zoom to my lots');
    button.click();
    expect(map.getZoom()).toBe(close);
    expect(button.textContent).toBe('Show the whole neighborhood');
  });

  it('should show the whole neighborhood with no button when none of the owner lots are drawn', async () => {
    const box = sizedBox();
    const map = await showLotMap(box, ['2'], fakeFetch(200, realMap), leaflet);
    expect(map.getZoom()).toBeLessThan(17);
    expect(box.querySelector('button')).toBeNull();
    expect(box.querySelectorAll('path.mine')).toHaveLength(0);
  });

  it('should fail with a plain message when the map is missing or broken', async () => {
    await expect(showLotMap(sizedBox(), ['50'], fakeFetch(404, 'nope'), leaflet)).rejects.toThrow('The map didn’t load (404).');
    await expect(showLotMap(sizedBox(), ['50'], fakeFetch(200, '<html>'), leaflet)).rejects.toThrow(/^The map didn’t load\.$/);
    await expect(showLotMap(sizedBox(), ['50'], fakeFetch(200, realMap), null)).rejects.toThrow(/^The map didn’t load\.$/);
  });
});
