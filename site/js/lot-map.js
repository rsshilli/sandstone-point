// The "Where your lots are" map on the owner page: the neighborhood aerial photo with the lot
// lines traced from the recorded plat on top, the owner's own lots filled in.
// Lot shapes live in /data/lot-map.json (built by scripts/build-lot-map.ts).

const SVG = 'http://www.w3.org/2000/svg';
/** The smallest area (photo pixels) the map zooms to, so one small lot still shows its street. */
const MIN_VIEW = 520;
/** Space kept around the owner's lots when zoomed in (photo pixels). */
const PADDING = 140;

/**
 * Draws the map into the container, zoomed to the owner's lots when any of them are traced.
 * @param {HTMLElement} container where the map goes
 * @param {string[]} myLots the owner's lot numbers
 * @param {typeof fetch} [fetchFn] for tests
 */
export async function showLotMap(container, myLots, fetchFn = fetch) {
  const map = await loadMap(fetchFn);
  const { aerial } = map;
  const mine = new Set(myLots.map(String));
  const drawn = Object.keys(map.lots).sort((a, b) => Number(a) - Number(b));
  const mineDrawn = drawn.filter((lot) => mine.has(lot));
  const rings = Object.fromEntries(drawn.map((lot) => [lot, map.lots[lot].map(([lat, lon]) => projectToImage(lat, lon, aerial))]));
  const whole = [0, 0, aerial.width, aerial.height];
  const zoomed = mineDrawn.length ? viewBoxFor(mineDrawn.map((lot) => rings[lot]), aerial) : whole;

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', mineDrawn.length ? `Aerial map of Sandstone Point with lot ${mineDrawn.join(', ')} highlighted` : 'Aerial map of Sandstone Point');
  svg.setAttribute('viewBox', zoomed.join(' '));
  svg.classList.toggle('whole', !mineDrawn.length);
  const photo = document.createElementNS(SVG, 'image');
  photo.setAttribute('href', aerial.src);
  photo.setAttribute('width', String(aerial.width));
  photo.setAttribute('height', String(aerial.height));
  svg.append(photo);
  // Other lots first, so the owner's outlines sit on top where two lots share a line.
  for (const lot of [...drawn.filter((lot) => !mine.has(lot)), ...mineDrawn]) {
    svg.append(lotShape(lot, rings[lot], mine.has(lot)));
  }

  const caption = document.createElement('figcaption');
  caption.className = 'muted';
  caption.textContent = captionText(myLots.map(String), drawn, aerial.credit);

  const figure = document.createElement('figure');
  figure.className = 'lot-map';
  figure.append(svg);
  if (mineDrawn.length) {
    figure.append(zoomButton(svg, zoomed, whole));
  }
  figure.append(caption);
  container.replaceChildren(figure);
}

/**
 * Fetches the lot shapes, turning any failure into one plain message for the owner.
 * @param {typeof fetch} fetchFn the fetch function
 * @returns {Promise<{aerial: any, lots: Record<string, [number, number][]>}>} the map data
 */
async function loadMap(fetchFn) {
  const response = await fetchFn('/data/lot-map.json');
  if (!response.ok) {
    throw new Error(`The map didn’t load (${response.status}).`);
  }
  try {
    const map = await response.json();
    if (map && map.aerial && map.lots) {
      return map;
    }
  } catch {
    // fall through to the message below
  }
  throw new Error('The map didn’t load.');
}

/**
 * Places a latitude/longitude on the aerial photo, which is in Web Mercator (the projection
 * every web map uses), so north–south distances stretch with latitude.
 * @param {number} lat latitude
 * @param {number} lon longitude
 * @param {{west:number,east:number,south:number,north:number,width:number,height:number}} aerial the photo's corners and size
 * @returns {[number, number]} photo pixels [x, y]
 */
export function projectToImage(lat, lon, aerial) {
  const x = ((lon - aerial.west) / (aerial.east - aerial.west)) * aerial.width;
  const y = ((mercatorY(aerial.north) - mercatorY(lat)) / (mercatorY(aerial.north) - mercatorY(aerial.south))) * aerial.height;
  return [round1(x), round1(y)];
}

/**
 * The square part of the photo to show: the lots' outline plus some street around it.
 * @param {[number, number][][]} rings the lots, in photo pixels
 * @param {{width:number,height:number}} aerial the photo's size
 * @returns {number[]} an SVG viewBox: x, y, width, height
 */
export function viewBoxFor(rings, aerial) {
  const points = rings.flat();
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const wanted = Math.max(MIN_VIEW, Math.max(...xs) - Math.min(...xs) + 2 * PADDING, Math.max(...ys) - Math.min(...ys) + 2 * PADDING);
  // Square, to match the map's square frame, and never bigger than the photo's short side.
  const size = Math.min(wanted, aerial.width, aerial.height);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const x = clamp(cx - size / 2, 0, aerial.width - size);
  const y = clamp(cy - size / 2, 0, aerial.height - size);
  return [Math.round(x), Math.round(y), Math.round(size), Math.round(size)];
}

/**
 * One lot's outline with its number in the middle.
 * @param {string} lot the lot number
 * @param {[number, number][]} ring its corners in photo pixels
 * @param {boolean} isMine whether to highlight it
 * @returns {SVGGElement} the shape
 */
function lotShape(lot, ring, isMine) {
  const group = document.createElementNS(SVG, 'g');
  group.setAttribute('class', isMine ? 'lot mine' : 'lot');
  const shape = document.createElementNS(SVG, 'polygon');
  shape.setAttribute('points', ring.map((p) => p.join(',')).join(' '));
  const title = document.createElementNS(SVG, 'title');
  title.textContent = isMine ? `Lot ${lot} (yours)` : `Lot ${lot}`;
  shape.append(title);
  const [cx, cy] = centroid(ring);
  const label = document.createElementNS(SVG, 'text');
  label.setAttribute('x', String(cx));
  label.setAttribute('y', String(cy));
  label.textContent = lot;
  group.append(shape, label);
  return group;
}

/**
 * The words under the map: which of the owner's lots aren't drawn yet, and where it came from.
 * @param {string[]} myLots the owner's lot numbers
 * @param {string[]} drawn every lot on the map
 * @param {string} credit the photo credit
 * @returns {string} the caption
 */
export function captionText(myLots, drawn, credit) {
  const onMap = new Set(drawn);
  const missing = myLots.filter((lot) => !onMap.has(lot));
  const parts = [];
  if (myLots.length && missing.length === myLots.length) {
    parts.push(`Your ${missing.length > 1 ? 'lots aren’t' : 'lot isn’t'} on the map yet; we’re still tracing the plat.`);
  } else if (missing.length) {
    parts.push(`Lot ${missing.join(', ')} isn’t on the map yet; we’re still tracing the plat.`);
  }
  parts.push(`Lot lines are traced from the recorded plat and are approximate, not a survey. ${credit}.`);
  return parts.join(' ');
}

/**
 * A button that switches between the owner's lots and the whole neighborhood.
 * @param {SVGSVGElement} svg the map
 * @param {number[]} zoomed the viewBox around the owner's lots
 * @param {number[]} whole the viewBox of the whole photo
 * @returns {HTMLButtonElement} the button
 */
function zoomButton(svg, zoomed, whole) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = 'Show the whole neighborhood';
  button.addEventListener('click', () => {
    const showingWhole = svg.getAttribute('viewBox') === whole.join(' ');
    svg.setAttribute('viewBox', (showingWhole ? zoomed : whole).join(' '));
    svg.classList.toggle('whole', !showingWhole);
    button.textContent = showingWhole ? 'Show the whole neighborhood' : 'Zoom to my lots';
  });
  return button;
}

/**
 * Web Mercator's north–south coordinate for a latitude (unscaled).
 * @param {number} lat latitude in degrees
 * @returns {number} the projected value
 */
function mercatorY(lat) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

/**
 * Rounds to one decimal place, which is plenty for photo pixels.
 * @param {number} value the number
 * @returns {number} the rounded number
 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Keeps a value between two limits.
 * @param {number} value the value
 * @param {number} low the smallest allowed
 * @param {number} high the largest allowed
 * @returns {number} the value, limited
 */
function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

/**
 * The average of a ring's corners, close enough to the middle for a label.
 * @param {[number, number][]} ring corners
 * @returns {[number, number]} the middle
 */
function centroid(ring) {
  const x = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
  const y = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
  return [round1(x), round1(y)];
}
