// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain browser JavaScript, no type declarations
import { showLotMap } from '../site/js/lot-map.js';

const realMap = readFileSync(join(__dirname, '..', 'site', 'data', 'lot-map.json'), 'utf8');

/**
 * A fetch that answers /data/lot-map.json with the given status and body.
 * @param status the HTTP status
 * @param body the response text
 * @returns the fake fetch
 */
function fakeFetch(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

describe('showLotMap', () => {
  it('should highlight the owner lot, draw it last, and zoom to it', async () => {
    const box = document.createElement('div');
    await showLotMap(box, ['77', '2'], fakeFetch(200, realMap));
    const svg = box.querySelector('svg')!;
    const groups = [...svg.querySelectorAll('g.lot')];
    expect(groups.at(-1)?.getAttribute('class')).toBe('lot mine');
    expect(groups.at(-1)?.querySelector('text')?.textContent).toBe('77');
    expect(box.querySelectorAll('g.mine')).toHaveLength(1);
    expect(svg.getAttribute('aria-label')).toBe('Aerial map of Sandstone Point with lot 77 highlighted');
    const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    expect(w).toBe(h);
    expect(w).toBeLessThan(1600);
    expect(box.querySelector('figcaption')?.textContent).toMatch(/^Lot 2 isn’t on the map yet/);
  });

  it('should switch between the owner lots and the whole neighborhood', async () => {
    const box = document.createElement('div');
    await showLotMap(box, ['50'], fakeFetch(200, realMap));
    const svg = box.querySelector('svg')!;
    const button = box.querySelector('button')!;
    const zoomed = svg.getAttribute('viewBox');
    button.click();
    expect(svg.getAttribute('viewBox')).toBe('0 0 1600 2365');
    expect(button.textContent).toBe('Zoom to my lots');
    button.click();
    expect(svg.getAttribute('viewBox')).toBe(zoomed);
    expect(button.textContent).toBe('Show the whole neighborhood');
  });

  it('should show the whole neighborhood with no button when none of the owner lots are drawn', async () => {
    const box = document.createElement('div');
    await showLotMap(box, ['2'], fakeFetch(200, realMap));
    expect(box.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 1600 2365');
    expect(box.querySelector('button')).toBeNull();
    expect(box.querySelectorAll('g.mine')).toHaveLength(0);
  });

  it('should fail with a plain message when the map is missing or broken', async () => {
    await expect(showLotMap(document.createElement('div'), ['50'], fakeFetch(404, 'nope'))).rejects.toThrow('The map didn’t load (404).');
    await expect(showLotMap(document.createElement('div'), ['50'], fakeFetch(200, '<html>'))).rejects.toThrow(/^The map didn’t load\.$/);
  });
});
