// Builds site/data/lot-map.json: lot outlines traced from photos of the recorded plat, placed on
// the neighborhood aerial photo. Run: npx tsx scripts/build-lot-map.ts
//
// Each plat photo ("piece") has its own scale and rotation, so this script works them out from
// the bearings and distances printed on the plat (which are exact), then slides the piece into
// place using road points matched by eye on the aerial photo (cul-de-sacs and junctions). It also
// checks each traced lot's area against the acreage printed on the plat, so a mis-traced corner
// shows up as a wrong area.
import { writeFileSync, mkdirSync } from 'node:fs';
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

/**
 * Places every traced lot, prints a check of each piece and lot, and writes the map file.
 */
function main(): void {
  const lots: Record<string, [number, number][]> = {};
  for (const piece of PIECES) {
    const { lots: placed, report } = placePiece(piece);
    console.log(report);
    Object.assign(lots, placed);
  }
  const out = join(__dirname, '..', 'site', 'data', 'lot-map.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ aerial: AERIAL, lots }, null, 1)}\n`);
  console.log(`Wrote ${Object.keys(lots).length} lots to ${out}`);
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
