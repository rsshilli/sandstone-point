// Builds site/data/lot-map.json: lot outlines traced from photos of the recorded plat, placed on
// the neighborhood aerial photo. Run: npx tsx scripts/build-lot-map.ts
//
// Each plat photo ("piece") has its own scale and rotation, so this script works them out from
// the bearings and distances printed on the plat (which are exact), then slides the piece into
// place using road points matched by eye on the aerial photo (cul-de-sacs and junctions). It also
// checks each traced lot's area against the acreage printed on the plat, so a mis-traced corner
// shows up as a wrong area.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A point on a plat photo, in that photo's pixels (x right, y down). */
type Px = [number, number];

/** A boundary line labelled on the plat with its bearing and length. */
interface PlatLine {
  from: Px;
  to: Px;
  feet: number;
  /** As printed, e.g. "N 05 16 49 W". Only the line's axis is used; the direction is ambiguous. */
  bearing: string;
}

/** One photo of part of the plat, with the lots fully visible on it. */
interface PlatPiece {
  name: string;
  /** Rough rotation (degrees) to pick between the two answers a bearing allows; set from road directions on the aerial. */
  rotationHint: number;
  lines: PlatLine[];
  /** Plat points matched to the same spot on the aerial photo. */
  controls: { plat: Px; lat: number; lon: number }[];
  /** Lot number → corners (and road-edge points) in order around the lot, with the acreage printed on the plat. */
  lots: Record<string, { acres: number; corners: Px[] }>;
}

/** The published aerial photo: USGS National Map imagery (public domain), Web Mercator. */
export const AERIAL = {
  src: '/assets/neighborhood-aerial.jpg',
  width: 1600,
  height: 2365,
  west: -85.0125,
  east: -84.9905,
  south: 36.8595,
  north: 36.8855,
  credit: 'Aerial photo: U.S. Geological Survey National Map',
};

const FEET_PER_METRE = 3.280839895;
const SQ_FEET_PER_ACRE = 43560;

export const PIECES: PlatPiece[] = [
  {
    name: 'Plat piece: lots 50–52',
    rotationHint: 126,
    lines: [
      { from: [178, 300], to: [400, 100], feet: 342.28, bearing: 'N 05 16 49 W' },
      { from: [260, 362], to: [487, 345], feet: 256.62, bearing: 'N 32 08 20 E' },
      { from: [345, 578], to: [545, 508], feet: 239.39, bearing: 'N 17 03 33 E' },
      { from: [62, 222], to: [210, 64], feet: 252.89, bearing: 'N 09 26 25 W' },
    ],
    controls: [{ plat: [228, 357], lat: 36.873772, lon: -85.008072 }],
    lots: {
      '50': { acres: 1.45, corners: [[260, 362], [487, 345], [545, 508], [345, 578], [325, 550], [300, 510], [275, 460], [255, 410]] },
      '51': { acres: 1.29, corners: [[400, 100], [178, 300], [205, 322], [232, 336], [252, 346], [260, 362], [487, 345]] },
      '52': { acres: 1.12, corners: [[210, 64], [298, 80], [400, 100], [178, 300], [120, 262], [62, 222]] },
    },
  },
  {
    name: 'Plat piece: lots 61–64',
    rotationHint: 126,
    lines: [
      { from: [393, 820], to: [485, 200], feet: 257.2, bearing: 'N 44 56 56 W' },
      { from: [485, 955], to: [1145, 625], feet: 305.44, bearing: 'N 10 18 11 E' },
      { from: [715, 1310], to: [1205, 885], feet: 270.33, bearing: 'N 04 39 29 W' },
      { from: [685, 2180], to: [690, 1325], feet: 353.88, bearing: 'N 53 18 54 W' },
      { from: [485, 200], to: [1075, 325], feet: 248.78, bearing: 'S 48 35 21 W' },
    ],
    controls: [
      { plat: [390, 920], lat: 36.872322, lon: -85.003989 },
      { plat: [180, 2370], lat: 36.873443, lon: -85.005474 },
    ],
    lots: {
      '61': { acres: 1.0, corners: [[705, 1318], [1170, 1680], [1080, 1830], [950, 2010], [830, 2110], [685, 2180]] },
      '62': { acres: 1.25, corners: [[705, 1318], [685, 2180], [450, 2262], [185, 2355], [230, 2120], [280, 1900], [320, 1750], [340, 1635]] },
      '63': { acres: 1.47, corners: [[485, 955], [1145, 625], [1205, 885], [705, 1318], [340, 1635], [345, 1350], [355, 1150], [380, 1040], [430, 990]] },
      '64': { acres: 1.41, corners: [[485, 200], [1075, 325], [1145, 625], [485, 955], [490, 915], [475, 870], [440, 833], [393, 820]] },
    },
  },
  {
    name: 'Plat piece: lots 72, 73, 77, 78',
    rotationHint: 37,
    lines: [
      { from: [190, 225], to: [843, 268], feet: 415.0, bearing: 'N 49 04 48 W' },
      { from: [843, 268], to: [1003, 602], feet: 233.98, bearing: 'S 10 53 43 W' },
      { from: [158, 703], to: [1003, 602], feet: 540.62, bearing: 'N 59 44 24 W' },
      { from: [730, 1162], to: [1090, 705], feet: 371.04, bearing: 'S 75 11 30 W' },
    ],
    controls: [
      { plat: [205, 960], lat: 36.877059, lon: -85.005707 },
      { plat: [1170, 1385], lat: 36.87541, lon: -85.004594 },
    ],
    lots: {
      '72': { acres: 1.28, corners: [[237, 1003], [690, 1215], [560, 1508], [270, 1420], [262, 1300], [250, 1150]] },
      '73': { acres: 1.29, corners: [[690, 1215], [1090, 1390], [1065, 1660], [880, 1605], [560, 1508]] },
      '77': { acres: 2.88, corners: [[158, 703], [1003, 602], [1090, 705], [730, 1162], [228, 932], [200, 860], [175, 780]] },
      '78': { acres: 2.93, corners: [[190, 225], [843, 268], [1003, 602], [158, 703], [145, 620], [140, 520], [150, 420], [170, 320]] },
    },
  },
];

/** A lot outline read from a plat scan, in that scan's pixels, with the acreage printed on the plat (null where unreadable). */
interface ScanLot {
  acres: number | null;
  ring: Px[];
}

/**
 * Lot outlines read from scans of the recorded plat (scripts/plat-tracings.json). Each lot was
 * flood-filled from a point inside it, so the outline follows the lot lines as drawn. "whole" is
 * one page showing all of Phase 1 at a small scale; its matchLots are lots that a sharper scan
 * also shows, kept only to line the scans up with each other.
 */
interface PlatTracings {
  whole: { name: string; lots: Record<string, ScanLot>; matchLots: Record<string, ScanLot> };
  sheets: { name: string; lots: Record<string, ScanLot> }[];
}

export const TRACINGS = JSON.parse(readFileSync(join(__dirname, 'plat-tracings.json'), 'utf8')) as PlatTracings;

/** One placed lot's size check: where its outline came from, and its area against the plat's. */
export interface LotCheck {
  lot: string;
  source: string;
  tracedAcres: number;
  platAcres: number | null;
}

/**
 * Places every traced lot, prints a check of each source and lot, and writes the map file.
 */
function main(): void {
  const { lots, report } = buildLots();
  console.log(report);
  const out = join(__dirname, '..', 'site', 'data', 'lot-map.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ aerial: AERIAL, lots }, null, 1)}\n`);
  console.log(`Wrote ${Object.keys(lots).length} lots to ${out}`);
}

/**
 * Places every lot from every source. The plat photos (PIECES) are placed on the ground from road
 * points; the whole-plat scan is then lined up with the lots those photos placed, and each sharper
 * scan is lined up with the whole-plat scan, using the centres of lots both show. Where several
 * sources show a lot, the sharper scan wins, then the whole-plat scan, then the photo: lots from
 * one drawing meet their neighbours cleanly, where a photo lot overlapped them by about 10 m.
 * @returns every lot as a [lat, lon] ring, a size check per lot, and a readable report
 */
export function buildLots(): { lots: Record<string, [number, number][]>; checks: LotCheck[]; report: string } {
  const origin = PIECES[0].controls[0];
  const lines: string[] = [];
  const placed: Record<string, { ring: [number, number][]; source: string; acres: number | null }> = {};
  const anchors: Record<string, [number, number][]> = {};
  const fromPhotos: typeof placed = {};
  for (const piece of PIECES) {
    const { lots, report } = placePiece(piece);
    lines.push(report);
    for (const [lot, ring] of Object.entries(lots)) {
      anchors[lot] = ring.map(([lat, lon]) => latLonToMetres(lat, lon, origin.lat, origin.lon));
      fromPhotos[lot] = { ring: anchors[lot], source: piece.name, acres: piece.lots[lot].acres };
    }
  }

  const whole = TRACINGS.whole;
  const wholeRings = { ...whole.matchLots, ...whole.lots };
  const wholeFit = fitSimilarity(centresOf(wholeRings, flipY), centresOf(anchors));
  lines.push(`${whole.name}: ${wholeFit.metresPerUnit.toFixed(3)} m/px, lined up on ${wholeFit.used} photo lots within ${wholeFit.misfit.toFixed(1)} m`);
  Object.assign(placed, fromPhotos);
  for (const [lot, { ring, acres }] of Object.entries(whole.lots)) {
    placed[lot] = { ring: ring.map((p) => wholeFit.apply(flipY(p))), source: whole.name, acres };
  }
  for (const sheet of TRACINGS.sheets) {
    const sheetFit = fitSimilarity(centresOf(sheet.lots), centresOf(wholeRings));
    lines.push(`${sheet.name}: lined up on ${sheetFit.used} lots of the whole plat within ${(sheetFit.misfit * wholeFit.metresPerUnit).toFixed(1)} m`);
    for (const [lot, { ring, acres }] of Object.entries(sheet.lots)) {
      placed[lot] = { ring: ring.map((p) => wholeFit.apply(flipY(sheetFit.apply(p)))), source: sheet.name, acres };
    }
  }

  const lots: Record<string, [number, number][]> = {};
  const checks: LotCheck[] = [];
  for (const lot of Object.keys(placed).sort((a, b) => Number(a) - Number(b))) {
    const { ring, source, acres } = placed[lot];
    lots[lot] = ring.map(([e, n]) => metresToLatLon(e, n, origin.lat, origin.lon));
    const tracedAcres = (ringArea(ring) * FEET_PER_METRE ** 2) / SQ_FEET_PER_ACRE;
    checks.push({ lot, source, tracedAcres, platAcres: acres });
    const versus = acres ? `plat says ${acres.toFixed(2)} ac (${(((tracedAcres - acres) / acres) * 100).toFixed(0)}%)` : 'plat acreage unreadable';
    lines.push(`  lot ${lot}: ${tracedAcres.toFixed(2)} ac, ${versus} — ${source}`);
  }
  return { lots, checks, report: lines.join('\n') };
}

/**
 * Turns a scan pixel (y down) into a right-handed point (y up), so a plain rotation and scale can
 * carry it onto the ground (north up).
 * @param p the pixel
 * @returns the same point with y negated
 */
function flipY(p: [number, number]): [number, number] {
  return [p[0], -p[1]];
}

/**
 * The centre (centroid) of each lot's outline.
 * @param rings lot number → outline, either as {ring} records or plain rings
 * @param transform applied to every corner first
 * @returns lot number → centre
 */
function centresOf(
  rings: Record<string, ScanLot | [number, number][]>,
  transform: (p: [number, number]) => [number, number] = (p) => p,
): Record<string, [number, number]> {
  const centres: Record<string, [number, number]> = {};
  for (const [lot, value] of Object.entries(rings)) {
    const ring = (Array.isArray(value) ? value : value.ring).map((p) => transform(p as [number, number]));
    centres[lot] = ringCentre(ring);
  }
  return centres;
}

/**
 * The centroid of a polygon.
 * @param ring corners in order
 * @returns [x, y]
 */
function ringCentre(ring: [number, number][]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * The rotation, scale and shift (no stretching) that best carries one set of points onto another,
 * by least squares over the points both sets name.
 * @param from name → point
 * @param to name → point
 * @returns the mapping, how many points it used, units of `to` per unit of `from`, and the
 *   largest distance (in `to` units) between a carried point and its match
 */
export function fitSimilarity(
  from: Record<string, [number, number]>,
  to: Record<string, [number, number]>,
): { apply: (p: [number, number]) => [number, number]; used: number; metresPerUnit: number; misfit: number } {
  const names = Object.keys(from).filter((name) => name in to);
  if (names.length < 2) {
    throw new Error(`Need at least two shared points to line up a scan, found ${names.length}`);
  }
  const mean = (points: [number, number][]): [number, number] => [
    points.reduce((s, p) => s + p[0], 0) / points.length,
    points.reduce((s, p) => s + p[1], 0) / points.length,
  ];
  const [fx, fy] = mean(names.map((n) => from[n]));
  const [tx, ty] = mean(names.map((n) => to[n]));
  // Treat points as complex numbers: to ≈ c · from, with c = Σ conj(a)·b / Σ |a|².
  let re = 0;
  let im = 0;
  let norm = 0;
  for (const n of names) {
    const [ax, ay] = [from[n][0] - fx, from[n][1] - fy];
    const [bx, by] = [to[n][0] - tx, to[n][1] - ty];
    re += ax * bx + ay * by;
    im += ax * by - ay * bx;
    norm += ax * ax + ay * ay;
  }
  const [cr, ci] = [re / norm, im / norm];
  const apply = (p: [number, number]): [number, number] => {
    const [x, y] = [p[0] - fx, p[1] - fy];
    return [x * cr - y * ci + tx, x * ci + y * cr + ty];
  };
  const misfit = Math.max(...names.map((n) => Math.hypot(apply(from[n])[0] - to[n][0], apply(from[n])[1] - to[n][1])));
  return { apply, used: names.length, metresPerUnit: Math.hypot(cr, ci), misfit };
}

/**
 * Works out one piece's scale and rotation from its labelled lines, moves it onto the control
 * points, and converts every lot corner to latitude/longitude.
 * @param piece the plat photo's tracing
 * @returns the lots as [lat, lon] rings, and a readable check of the fit
 */
export function placePiece(piece: PlatPiece): { lots: Record<string, [number, number][]>; report: string } {
  const { rotation, feetPerPx, spread, scaleSpread } = fitScaleAndRotation(piece);
  const lat0 = piece.controls[0].lat;
  const lon0 = piece.controls[0].lon;
  const offsets = piece.controls.map((c) => {
    const [e, n] = platToMetres(c.plat, rotation, feetPerPx);
    const [ce, cn] = latLonToMetres(c.lat, c.lon, lat0, lon0);
    return [ce - e, cn - n];
  });
  const offE = offsets.reduce((s, o) => s + o[0], 0) / offsets.length;
  const offN = offsets.reduce((s, o) => s + o[1], 0) / offsets.length;
  const misfit = Math.max(...offsets.map((o) => Math.hypot(o[0] - offE, o[1] - offN)));
  const lines = [
    `${piece.name}: rotation ${rotation.toFixed(1)}°, ${feetPerPx.toFixed(4)} ft/px, bearings agree within ${spread.toFixed(1)}°, ` +
      `lengths agree within ${(scaleSpread * 100).toFixed(1)}%, control points agree within ${misfit.toFixed(1)} m`,
  ];
  const lots: Record<string, [number, number][]> = {};
  for (const [lot, { acres, corners }] of Object.entries(piece.lots)) {
    const metres = corners.map((p) => {
      const [e, n] = platToMetres(p, rotation, feetPerPx);
      return [e + offE, n + offN] as [number, number];
    });
    const traced = (ringArea(metres) * FEET_PER_METRE ** 2) / SQ_FEET_PER_ACRE;
    lines.push(`  lot ${lot}: traced ${traced.toFixed(2)} ac, plat says ${acres.toFixed(2)} ac (${(((traced - acres) / acres) * 100).toFixed(0)}%)`);
    lots[lot] = metres.map(([e, n]) => metresToLatLon(e, n, lat0, lon0));
  }
  return { lots, report: lines.join('\n') };
}

/**
 * Finds the rotation (true bearing = photo angle + rotation) and scale that make the labelled
 * lines match their printed bearings and lengths.
 * @param piece the plat photo's tracing
 * @returns rotation in degrees, feet per photo pixel, how far the lines disagree on rotation
 *   (degrees), and how far any line's scale is from the average (a fraction)
 */
function fitScaleAndRotation(piece: PlatPiece): { rotation: number; feetPerPx: number; spread: number; scaleSpread: number } {
  const rotations = piece.lines.map((line) => {
    const raw = normalise(parseBearing(line.bearing) - photoAngle(line.from, line.to));
    // A printed bearing doesn't say which end it starts from, so the rotation is only known up
    // to 180°; take the answer nearer the hint.
    return Math.abs(angleGap(raw, piece.rotationHint)) <= 90 ? raw : normalise(raw + 180);
  });
  const rotation = circularMean(rotations);
  const spread = Math.max(...rotations.map((r) => Math.abs(angleGap(r, rotation))));
  const scales = piece.lines.map((line) => line.feet / Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1]));
  const feetPerPx = scales.reduce((s, v) => s + v, 0) / scales.length;
  const scaleSpread = Math.max(...scales.map((s) => Math.abs(s / feetPerPx - 1)));
  return { rotation, feetPerPx, spread, scaleSpread };
}

/**
 * Converts a plat photo point to metres east and north of the photo's top-left corner.
 * @param p the photo point
 * @param rotation degrees to add to a photo angle to get a true bearing
 * @param feetPerPx the photo's scale
 * @returns [east, north] in metres
 */
function platToMetres(p: Px, rotation: number, feetPerPx: number): [number, number] {
  const distance = (Math.hypot(p[0], p[1]) * feetPerPx) / FEET_PER_METRE;
  const bearing = ((photoAngle([0, 0], p) + rotation) * Math.PI) / 180;
  return [distance * Math.sin(bearing), distance * Math.cos(bearing)];
}

/**
 * Metres east and north of an origin, using a flat-earth approximation (fine across a mile).
 * @param lat latitude
 * @param lon longitude
 * @param lat0 origin latitude
 * @param lon0 origin longitude
 * @returns [east, north] in metres
 */
function latLonToMetres(lat: number, lon: number, lat0: number, lon0: number): [number, number] {
  return [(lon - lon0) * metresPerDegreeLon(lat0), (lat - lat0) * METRES_PER_DEGREE_LAT];
}

/**
 * The inverse of latLonToMetres, rounded to about 1 cm.
 * @param east metres east of the origin
 * @param north metres north of the origin
 * @param lat0 origin latitude
 * @param lon0 origin longitude
 * @returns [lat, lon]
 */
function metresToLatLon(east: number, north: number, lat0: number, lon0: number): [number, number] {
  return [roundDegrees(lat0 + north / METRES_PER_DEGREE_LAT), roundDegrees(lon0 + east / metresPerDegreeLon(lat0))];
}

/**
 * Area of a polygon (shoelace formula).
 * @param ring corners in order
 * @returns area in the square of the corners' unit
 */
export function ringArea(ring: [number, number][]): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/**
 * Reads a surveyor's bearing like "N 05 16 49 W" as degrees clockwise from north.
 * @param text the bearing as printed
 * @returns degrees clockwise from north, 0–360
 */
export function parseBearing(text: string): number {
  const match = /^([NS])\s*(\d+)\s+(\d+)\s+(\d+)\s*([EW])$/.exec(text.trim());
  if (!match) {
    throw new Error(`Can't read bearing "${text}"`);
  }
  const angle = Number(match[2]) + Number(match[3]) / 60 + Number(match[4]) / 3600;
  const [ns, ew] = [match[1], match[5]];
  if (ns === 'N') {
    return normalise(ew === 'E' ? angle : -angle);
  }
  return normalise(ew === 'E' ? 180 - angle : 180 + angle);
}

/**
 * Angle of the line from a to b on the photo, clockwise from straight up.
 * @param a start point
 * @param b end point
 * @returns degrees, 0–360
 */
function photoAngle(a: Px, b: Px): number {
  return normalise((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI);
}

/**
 * Average of angles that may wrap around 360.
 * @param angles degrees
 * @returns degrees, 0–360
 */
function circularMean(angles: number[]): number {
  const x = angles.reduce((s, a) => s + Math.cos((a * Math.PI) / 180), 0);
  const y = angles.reduce((s, a) => s + Math.sin((a * Math.PI) / 180), 0);
  return normalise((Math.atan2(y, x) * 180) / Math.PI);
}

/**
 * The signed difference a − b, folded into −180…180.
 * @param a degrees
 * @param b degrees
 * @returns degrees
 */
function angleGap(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/**
 * Folds an angle into 0–360.
 * @param a degrees
 * @returns degrees
 */
function normalise(a: number): number {
  return ((a % 360) + 360) % 360;
}

const METRES_PER_DEGREE_LAT = 110_986;

/**
 * Metres per degree of longitude at a latitude.
 * @param lat latitude in degrees
 * @returns metres
 */
function metresPerDegreeLon(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

/**
 * Rounds degrees to 7 decimal places (about 1 cm).
 * @param value degrees
 * @returns the rounded degrees
 */
function roundDegrees(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

if (require.main === module) {
  main();
}
