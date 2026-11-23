// The "Where your lots are" map on the owner page: a zoomable aerial map (drag, scroll or pinch,
// like Google Maps) with the lot lines traced from the recorded plat on top and the owner's own
// lots filled in. The aerial photos are KyFromAbove, Kentucky's public statewide imagery, served
// as map tiles by the state; Leaflet (site/vendor/leaflet) draws the map.
// Lot shapes live in /data/lot-map.json (built by scripts/build-lot-map.ts).

/** Kentucky's 3-inch statewide aerial photos, as Web Mercator map tiles. */
export const TILE_URL = 'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_Imagery_Phase3_3IN_WGS84WM/MapServer/tile/{z}/{y}/{x}';
/** The credit shown on the map and under it. */
export const CREDIT = 'Aerial photos: KyFromAbove, Commonwealth of Kentucky';
/** The closest zoom the state has photos for; Leaflet enlarges them one step past that. */
const NATIVE_MAX_ZOOM = 21;
/** Space kept around the owner's lots when zoomed to them (screen pixels). */
const PADDING = 60;
/** The closest the map zooms when showing the owner's lots, so one small lot still shows its street. */
const LOTS_MAX_ZOOM = 19;
/** Below this zoom only the owner's own lot numbers show, so the others don't pile up. */
const LABELS_MIN_ZOOM = 17;
/**
 * How far a pinch (or ctrl + scroll) travels per zoom step. Leaflet's own is 60; this is three
 * times slower.
 */
export const PINCH_PX_PER_ZOOM = 180;
/** A pause this long (ms) ends one pinch, so a half-finished step doesn't carry into the next. */
const PINCH_IDLE_MS = 300;

/**
 * Draws the map into the container, zoomed to the owner's lots when any of them are traced.
 * @param {HTMLElement} container where the map goes
 * @param {string[]} myLots the owner's lot numbers
 * @param {typeof fetch} [fetchFn] for tests
 * @param {any} [leaflet] the Leaflet library (window.L), for tests
 * @returns {Promise<any>} the Leaflet map
 */
export async function showLotMap(container, myLots, fetchFn = fetch, leaflet = globalThis.L) {
  const data = await loadMap(fetchFn);
  if (!leaflet) {
    throw new Error('The map didn’t load.');
  }
  const mine = new Set(myLots.map(String));
  const drawn = Object.keys(data.lots).sort((a, b) => Number(a) - Number(b));
  const mineDrawn = drawn.filter((lot) => mine.has(lot));
  const area = neighborhoodBounds(data.aerial);
  const whole = drawn.length ? padBounds(boundsOf(drawn.map((lot) => data.lots[lot])), 0.15) : area;

  const canvas = document.createElement('div');
  canvas.className = 'lot-map-canvas';
  canvas.setAttribute('role', 'region');
  canvas.setAttribute('aria-label', mineDrawn.length ? `Aerial map of Sandstone Point with lot ${mineDrawn.join(', ')} highlighted` : 'Aerial map of Sandstone Point');
  const caption = document.createElement('figcaption');
  caption.className = 'muted';
  caption.textContent = captionText(myLots.map(String), drawn, CREDIT);
  const figure = document.createElement('figure');
  figure.className = 'lot-map';
  figure.append(canvas, caption);
  // Leaflet measures its box, so the figure has to be on the page before the map is made.
  container.replaceChildren(figure);

  const map = leaflet.map(canvas, {
    maxBounds: padBounds(area, 0.5),
    minZoom: 14,
    maxZoom: NATIVE_MAX_ZOOM + 1,
    // Whole zoom steps only: in-between zooms show faint lines where the photo tiles meet.
    zoomSnap: 1,
    // Replaced by trackpadGestures: Leaflet zooms on every two-finger slide, and too fast on a pinch.
    scrollWheelZoom: false,
    attributionControl: true,
  });
  map.attributionControl.setPrefix(false);
  trackpadGestures(map, canvas);
  leaflet.tileLayer(TILE_URL, { maxNativeZoom: NATIVE_MAX_ZOOM, maxZoom: NATIVE_MAX_ZOOM + 1, attribution: 'KyFromAbove' }).addTo(map);
  // Other lots first, so the owner's outlines sit on top where two lots share a line.
  for (const lot of [...drawn.filter((lot) => !mine.has(lot)), ...mineDrawn]) {
    addLot(leaflet, map, lot, data.lots[lot], mine.has(lot));
  }

  const showLabels = () => canvas.classList.toggle('far', map.getZoom() < LABELS_MIN_ZOOM);
  map.on('zoomend', showLabels);
  const lotsView = mineDrawn.length ? boundsOf(mineDrawn.map((lot) => data.lots[lot])) : null;
  showView(map, lotsView ?? whole, Boolean(lotsView));
  showLabels();
  if (lotsView) {
    figure.insertBefore(zoomButton(map, lotsView, whole), caption);
  }
  return map;
}

/**
 * Makes a trackpad behave like Google Maps on a Mac: sliding two fingers moves the map, and pinching
 * zooms, one whole step per PINCH_PX_PER_ZOOM, centred on the pointer. The + and − buttons, a
 * double-click and ctrl + mouse wheel zoom too.
 * @param {any} map the map
 * @param {HTMLElement} canvas the element the map is drawn in
 */
function trackpadGestures(map, canvas) {
  let pinched = 0;
  let lastPinch = 0;
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const action = wheelAction(event);
    if (action === 'pan') {
      map.panBy([event.deltaX, event.deltaY], { animate: false });
      return;
    }
    const now = Date.now();
    if (now - lastPinch > PINCH_IDLE_MS) {
      pinched = 0;
    }
    lastPinch = now;
    // A mouse-wheel notch is one step; a pinch builds up until it has travelled far enough.
    pinched += action === 'step' ? Math.sign(event.deltaY) * PINCH_PX_PER_ZOOM : event.deltaY;
    const steps = Math.trunc(pinched / PINCH_PX_PER_ZOOM);
    if (steps !== 0) {
      pinched -= steps * PINCH_PX_PER_ZOOM;
      map.setZoomAround(map.mouseEventToContainerPoint(event), map.getZoom() - steps);
    }
  }, { passive: false });
}

/**
 * What one wheel event means. Browsers report a trackpad pinch as a scroll with the ctrl key held,
 * and a two-finger slide as a plain scroll in pixels. Firefox reports a mouse wheel in lines, so
 * that zooms a step; other browsers' mouse wheels can't be told apart from a slide (Chrome on a Mac
 * gives a slide the same 120-notch numbers a wheel has), so they pan, and ctrl + wheel zooms.
 * @param {WheelEvent} event the wheel event
 * @returns {'pan'|'pinch'|'step'} pan the map, zoom by the pinch's distance, or zoom one step
 */
export function wheelAction(event) {
  if (event.ctrlKey) {
    return 'pinch';
  }
  if (event.deltaMode !== 0) {
    return 'step';
  }
  return 'pan';
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
 * The area around the neighborhood that the owner can pan within (the old aerial photo's edges).
 * @param {{west:number,east:number,south:number,north:number}} aerial the area's edges
 * @returns {[[number, number], [number, number]]} south-west and north-east corners
 */
export function neighborhoodBounds(aerial) {
  return [[aerial.south, aerial.west], [aerial.north, aerial.east]];
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
  parts.push(`Drag or slide two fingers to move, and pinch or use + and − to zoom. Lot lines are traced from the recorded plat and are approximate, not a survey. ${credit}.`);
  return parts.join(' ');
}

/**
 * Grows an area by a share of its size on every side, so the owner can pan a little past it.
 * @param {[[number, number], [number, number]]} bounds south-west and north-east corners
 * @param {number} share how much to add on each side, e.g. 0.5 for half its height and width
 * @returns {[[number, number], [number, number]]} the bigger area
 */
export function padBounds(bounds, share) {
  const [[south, west], [north, east]] = bounds;
  const dLat = (north - south) * share;
  const dLon = (east - west) * share;
  return [[south - dLat, west - dLon], [north + dLat, east + dLon]];
}

/**
 * Draws one lot's outline with its number in the middle.
 * @param {any} leaflet the Leaflet library
 * @param {any} map the map
 * @param {string} lot the lot number
 * @param {[number, number][]} ring its corners as [latitude, longitude]
 * @param {boolean} isMine whether to highlight it
 */
function addLot(leaflet, map, lot, ring, isMine) {
  const shape = leaflet.polygon(ring, { className: isMine ? 'lot mine' : 'lot', interactive: false, opacity: 1, fillOpacity: 1 });
  shape.bindTooltip(lot, { permanent: true, direction: 'center', className: isMine ? 'lot-label mine' : 'lot-label' });
  shape.addTo(map);
}

/**
 * The smallest area that holds every corner of the given lots.
 * @param {[number, number][][]} rings the lots' corners as [latitude, longitude]
 * @returns {[[number, number], [number, number]]} south-west and north-east corners
 */
export function boundsOf(rings) {
  const points = rings.flat();
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  return [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
}

/**
 * Moves the map to show an area: the owner's lots with some street around them, or the whole
 * neighborhood.
 * @param {any} map the map
 * @param {[[number, number], [number, number]]} bounds the area
 * @param {boolean} isLots whether it is the owner's lots (padded, and not zoomed in too far)
 */
function showView(map, bounds, isLots) {
  if (isLots) {
    map.fitBounds(bounds, { padding: [PADDING, PADDING], maxZoom: LOTS_MAX_ZOOM });
  } else {
    map.fitBounds(bounds);
  }
}

/**
 * A button that switches between the owner's lots and the whole neighborhood.
 * @param {any} map the map
 * @param {[[number, number], [number, number]]} lotsView the area around the owner's lots
 * @param {[[number, number], [number, number]]} whole the whole neighborhood
 * @returns {HTMLButtonElement} the button
 */
function zoomButton(map, lotsView, whole) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = 'Show the whole neighborhood';
  let showingWhole = false;
  button.addEventListener('click', () => {
    showingWhole = !showingWhole;
    showView(map, showingWhole ? whole : lotsView, !showingWhole);
    button.textContent = showingWhole ? 'Zoom to my lots' : 'Show the whole neighborhood';
  });
  return button;
}
