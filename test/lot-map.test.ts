import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AERIAL, PIECES, buildLots, fitSimilarity, parseBearing, placePiece, ringArea } from '../scripts/build-lot-map';
// @ts-expect-error plain browser JavaScript, no type declarations
import { boundsOf, captionText, neighborhoodBounds, padBounds } from '../site/js/lot-map.js';

const siteDir = join(__dirname, '..', 'site');
const lotMap = JSON.parse(readFileSync(join(siteDir, 'data', 'lot-map.json'), 'utf8')) as {
  aerial: typeof AERIAL;
  lots: Record<string, [number, number][]>;
};

describe('lot map data', () => {
  it('should match what the build script makes from the plat tracings (rerun it after editing a tracing)', () => {
    expect(lotMap.lots).toEqual(buildLots().lots);
    expect(lotMap.aerial).toEqual(AERIAL);
  });

  it('should have every Phase 1 lot (1–83)', () => {
    const expected = Array.from({ length: 83 }, (_, i) => String(i + 1));
    expect(Object.keys(lotMap.lots).sort((a, b) => Number(a) - Number(b))).toEqual(expected);
  });

  it('should trace every lot close to the acreage printed on the plat', () => {
    // The whole-plat page is a small, speckled scan where a line is a metre wide, so its outlines
    // are rougher; lot 32 loses a corner to callout labels there (-21%).
    for (const { lot, source, tracedAcres, platAcres } of buildLots().checks) {
      if (platAcres === null) {
        continue;
      }
      const limit = source.startsWith('Whole') ? 0.25 : 0.1;
      expect(Math.abs(tracedAcres / platAcres - 1), `lot ${lot} (${source})`).toBeLessThan(limit);
    }
  });

  it('should line every scan up with the lots around it within 6 m', () => {
    for (const match of buildLots().report.matchAll(/^(.*): .*lined up on (\d+) .* within ([\d.]+) m$/gm)) {
      expect(Number(match[2]), match[1]).toBeGreaterThanOrEqual(5);
      expect(Number(match[3]), match[1]).toBeLessThan(6);
    }
    expect(buildLots().report.match(/lined up on/g)).toHaveLength(4);
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

describe('fitSimilarity', () => {
  it('should recover a rotation, scale and shift from matched points, and report how well they agree', () => {
    // Rotate 90° anticlockwise, double, then shift by (10, 5).
    const from: Record<string, [number, number]> = { a: [0, 0], b: [1, 0], c: [0, 1] };
    const to: Record<string, [number, number]> = { a: [10, 5], b: [10, 7], c: [8, 5], extra: [0, 0] };
    const fit = fitSimilarity(from, to);
    expect(fit.used).toBe(3);
    expect(fit.metresPerUnit).toBeCloseTo(2);
    expect(fit.misfit).toBeCloseTo(0);
    const [x, y] = fit.apply([1, 1]);
    expect(x).toBeCloseTo(8);
    expect(y).toBeCloseTo(7);
  });

  it('should refuse to line up a scan with fewer than two shared lots', () => {
    expect(() => fitSimilarity({ a: [0, 0] }, { a: [1, 1] })).toThrow(/two shared points/);
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
    expect(captionText(['50'], ['50'], 'Photo: USGS')).toBe('Drag or slide two fingers to move, and pinch or use + and − to zoom. Lot lines are traced from the recorded plat and are approximate, not a survey. Photo: USGS.');
  });
});
