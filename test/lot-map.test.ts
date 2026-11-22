import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AERIAL, PIECES, parseBearing, placePiece, ringArea } from '../scripts/build-lot-map';
// @ts-expect-error plain browser JavaScript, no type declarations
import { boundsOf, captionText, neighborhoodBounds, padBounds } from '../site/js/lot-map.js';

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

  it('should keep every lot inside the whole-neighborhood view', () => {
    const { south, north, west, east } = lotMap.aerial;
    for (const [lot, ring] of Object.entries(lotMap.lots)) {
      for (const [lat, lon] of ring) {
        expect(lat, `lot ${lot}`).toBeGreaterThan(south);
        expect(lat, `lot ${lot}`).toBeLessThan(north);
        expect(lon, `lot ${lot}`).toBeGreaterThan(west);
        expect(lon, `lot ${lot}`).toBeLessThan(east);
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

describe('neighborhoodBounds', () => {
  it('should turn the area edges into south-west and north-east corners', () => {
    expect(neighborhoodBounds({ west: -85.0125, east: -84.9905, south: 36.8595, north: 36.8855 })).toEqual([[36.8595, -85.0125], [36.8855, -84.9905]]);
  });
});

describe('padBounds', () => {
  it('should grow the area by the share of its size on every side', () => {
    expect(padBounds([[10, 20], [12, 24]], 0.5)).toEqual([[9, 18], [13, 26]]);
  });
});

describe('boundsOf', () => {
  it('should hold every corner of every lot given', () => {
    expect(boundsOf([[[36.87, -85.0], [36.871, -85.002]], [[36.869, -84.999]]])).toEqual([[36.869, -85.002], [36.871, -84.999]]);
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

  it('should only give the how-to, the credit and the approximate-lines note when every lot is drawn', () => {
    expect(captionText(['50'], ['50'], 'Photo: USGS')).toBe('Drag to move, and scroll or pinch to zoom. Lot lines are traced from the recorded plat and are approximate, not a survey. Photo: USGS.');
  });
});
