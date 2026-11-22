import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AERIAL, PIECES, parseBearing, placePiece, ringArea } from '../scripts/build-lot-map';
// @ts-expect-error plain browser JavaScript, no type declarations
import { captionText, projectToImage, viewBoxFor } from '../site/js/lot-map.js';

const siteDir = join(__dirname, '..', 'site');
const lotMap = JSON.parse(readFileSync(join(siteDir, 'data', 'lot-map.json'), 'utf8')) as {
  aerial: typeof AERIAL;
  lots: Record<string, [number, number][]>;
};

describe('lot map data', () => {
  it('should match what the build script makes from the plat tracings (rerun it after editing a tracing)', () => {
    const expected: Record<string, [number, number][]> = {};
    for (const piece of PIECES) {
      Object.assign(expected, placePiece(piece).lots);
    }
    expect(lotMap.lots).toEqual(expected);
    expect(lotMap.aerial).toEqual(AERIAL);
  });

  it('should trace every lot within 10% of the acreage printed on the plat', () => {
    for (const piece of PIECES) {
      const report = placePiece(piece).report;
      for (const match of report.matchAll(/lot (\d+): traced ([\d.]+) ac, plat says ([\d.]+) ac/g)) {
        const [, lot, traced, printed] = match;
        expect(Math.abs(Number(traced) / Number(printed) - 1), `lot ${lot}`).toBeLessThan(0.1);
      }
    }
  });

  it('should find every plat photo’s printed lengths agree within 5% (a mistyped length would skew the whole piece)', () => {
    // Phone photos of paper are slightly skewed: the small lots 50–52 photo measures 2.2%.
    for (const piece of PIECES) {
      const match = /lengths agree within ([\d.]+)%/.exec(placePiece(piece).report);
      expect(Number(match?.[1]), piece.name).toBeLessThan(5);
    }
  });

  it('should keep every lot inside the aerial photo', () => {
    for (const [lot, ring] of Object.entries(lotMap.lots)) {
      for (const [lat, lon] of ring) {
        const [x, y] = projectToImage(lat, lon, lotMap.aerial);
        expect(x, `lot ${lot}`).toBeGreaterThan(0);
        expect(x, `lot ${lot}`).toBeLessThan(lotMap.aerial.width);
        expect(y, `lot ${lot}`).toBeGreaterThan(0);
        expect(y, `lot ${lot}`).toBeLessThan(lotMap.aerial.height);
      }
    }
  });

  it('should point at an aerial photo that exists in the site', () => {
    expect(statSync(join(siteDir, lotMap.aerial.src)).size).toBeGreaterThan(100_000);
  });
});

describe('parseBearing', () => {
  it('should turn each quadrant of a surveyor bearing into degrees clockwise from north', () => {
    expect(parseBearing('N 30 00 00 E')).toBeCloseTo(30);
    expect(parseBearing('S 30 00 00 E')).toBeCloseTo(150);
    expect(parseBearing('S 30 00 00 W')).toBeCloseTo(210);
    expect(parseBearing('N 05 16 49 W')).toBeCloseTo(354.7197, 3);
    expect(() => parseBearing('north-ish')).toThrow();
  });
});

describe('ringArea', () => {
  it('should give the area of a polygon whichever way round its corners go', () => {
    expect(ringArea([[0, 0], [4, 0], [4, 3], [0, 3]])).toBe(12);
    expect(ringArea([[0, 0], [0, 3], [4, 3], [4, 0]])).toBe(12);
  });
});

describe('projectToImage', () => {
  it('should put the photo corners at its pixel corners and stretch north–south like a web map', () => {
    const aerial = lotMap.aerial;
    expect(projectToImage(aerial.north, aerial.west, aerial)).toEqual([0, 0]);
    expect(projectToImage(aerial.south, aerial.east, aerial)).toEqual([aerial.width, aerial.height]);
    const [, middle] = projectToImage((aerial.north + aerial.south) / 2, aerial.west, aerial);
    expect(middle).toBeGreaterThan(aerial.height / 2 - 2);
    expect(middle).not.toBe(aerial.height / 2);
  });
});

describe('viewBoxFor', () => {
  const aerial = { width: 1600, height: 2365 };

  it('should zoom to at least 520 pixels around a small lot', () => {
    expect(viewBoxFor([[[800, 1000], [840, 1000], [840, 1040]]], aerial)).toEqual([560, 760, 520, 520]);
  });

  it('should stay inside the photo for a lot at its edge', () => {
    const [x, y, w, h] = viewBoxFor([[[5, 5], [60, 5], [60, 60]]], aerial);
    expect([x, y]).toEqual([0, 0]);
    expect(w).toBe(520);
    expect(h).toBe(520);
  });

  it('should cover lots far apart with room to spare', () => {
    const [x, y, w, h] = viewBoxFor([[[300, 900]], [[700, 1200]]], aerial);
    expect(x).toBeLessThanOrEqual(300 - 140);
    expect(y).toBeLessThanOrEqual(900 - 140);
    expect(x + w).toBeGreaterThanOrEqual(700 + 140);
    expect(y + h).toBeGreaterThanOrEqual(1200 + 140);
  });
});

describe('captionText', () => {
  it('should say when none of the owner lots are drawn yet', () => {
    expect(captionText(['5'], ['50', '51'], 'Photo: USGS')).toMatch(/^Your lot isn’t on the map yet/);
    expect(captionText(['5', '6'], ['50'], 'Photo: USGS')).toMatch(/^Your lots aren’t on the map yet/);
  });

  it('should name only the missing lots when some are drawn', () => {
    expect(captionText(['50', '5'], ['50'], 'Photo: USGS')).toMatch(/^Lot 5 isn’t on the map yet/);
  });

  it('should only give the credit and the approximate-lines note when every lot is drawn', () => {
    expect(captionText(['50'], ['50'], 'Photo: USGS')).toBe('Lot lines are traced from the recorded plat and are approximate, not a survey. Photo: USGS.');
  });
});
