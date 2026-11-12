/** Shared GeoJSON detection / extraction utilities (Host + Client halves). */

const GEO_TYPES = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection',
  'Feature', 'FeatureCollection',
]);

function isGeometryType(type) {
  return typeof type === 'string' && GEO_TYPES.has(type);
}

/**
 * Coerce a value into a renderable GeoJSON object.
 * Accepts: FeatureCollection / Feature / bare geometry / array of features.
 * Returns a FeatureCollection, or null when the value carries no usable geometry.
 */
function toFeatureCollection(value) {
  if (!value || typeof value !== 'object') return null;

  // Array of geometries/features
  if (Array.isArray(value)) {
    const feats = value
      .map((item) => coerceFeature(item))
      .filter(Boolean);
    if (!feats.length) return null;
    return { type: 'FeatureCollection', features: feats };
  }

  // FeatureCollection
  if (value.type === 'FeatureCollection' && Array.isArray(value.features)) {
    const feats = value.features.map((f) => coerceFeature(f)).filter(Boolean);
    if (!feats.length) return null;
    return { type: 'FeatureCollection', features: feats };
  }

  const single = coerceFeature(value);
  if (!single) return null;
  return { type: 'FeatureCollection', features: [single] };
}

function coerceFeature(value) {
  if (!value || typeof value !== 'object') return null;

  if (value.type === 'Feature') {
    if (value.geometry && isGeometryType(value.geometry.type)) {
      return {
        type: 'Feature',
        geometry: value.geometry,
        properties: value.properties && typeof value.properties === 'object' ? value.properties : {},
      };
    }
    return null;
  }

  if (isGeometryType(value.type)) {
    return {
      type: 'Feature',
      geometry: value,
      properties: {},
    };
  }

  // Some producers embed under `geometry`
  if (value.geometry && isGeometryType(value.geometry.type)) {
    return {
      type: 'Feature',
      geometry: value.geometry,
      properties: value.properties && typeof value.properties === 'object' ? value.properties : {},
    };
  }
  return null;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Extract every GeoJSON object embedded in a free-form text payload
 * (assistant message text, tool results, file contents, ...).
 * Strategy: balanced-brace scan for candidate object literals, parse, and
 * keep the largest valid GeoJSON candidates.
 * Returns a deduped array of FeatureCollections (up to `limit`).
 */
function extractGeoJsonFromText(text, { limit = 8 } = {}) {
  if (typeof text !== 'string' || !text.length) return [];
  if (text.length > 10_000_000) text = text.slice(0, 10_000_000);

  const found = [];
  const seen = new Set();

  // Candidate seeds: the start of a GeoJSON-looking object.
  const seedRe = /{"[^"]*"(?:type|coordinates|features|geometry|properties)"\s*:/g;
  let m;
  while ((m = seedRe.exec(text)) !== null) {
    const start = m.index;
    const obj = readBalanced(text, start);
    if (!obj) continue;
    const fc = toFeatureCollection(obj);
    if (!fc) continue;
    const key = stableKey(fc);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(fc);
    if (found.length >= limit) break;
    seedRe.lastIndex = start + 2;
  }

  // Also try the whole payload as one JSON document (fast path for full-file dumps).
  if (found.length === 0) {
    const whole = tryParseWhole(text);
    if (whole) {
      const fc = toFeatureCollection(whole);
      if (fc) found.push(fc);
    }
  }

  // Rank: prefer candidates with the most features / most coordinate depth.
  found.sort((a, b) => score(b) - score(a));
  return found;
}

function tryParseWhole(text) {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Read one balanced {...} object starting at `start` (which must point at '{'). */
function readBalanced(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const raw = text.slice(start, i + 1);
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function score(fc) {
  const n = fc.features.length;
  return n * 1000 + jsonSize(fc);
}

function jsonSize(v) {
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}

function stableKey(fc) {
  // A compact fingerprint of feature count + first geometry type to dedupe repeats.
  const f0 = fc.features[0] ? fc.features[0].geometry.type : '';
  const p0 = fc.features[0] ? JSON.stringify(fc.features[0].properties).slice(0, 200) : '';
  return `${fc.features.length}|${f0}|${p0}`;
}

/**
 * Compute a Leaflet-compatible bounds + layer-plan from a FeatureCollection.
 * Used by the Host when it needs to pre-compute a view, and mirrored client-side.
 * Returns { southWest, northEast, featureCount } or null.
 */
function computeBounds(fc, maxDepth = 10) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  let count = 0;

  function visitGeom(g) {
    if (!g || !g.type) return;
    const walk = (coords, depth) => {
      if (depth > maxDepth) return;
      if (typeof coords[0] === 'number') {
        const lng = coords[0], lat = coords[1];
        if (typeof lng === 'number' && typeof lat === 'number' &&
            lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
          minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
          minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        }
        return;
      }
      if (Array.isArray(coords)) for (const c of coords) walk(c, depth + 1);
    };
    if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
      for (const sub of g.geometries) visitGeom(sub);
    } else if (g.coordinates) {
      walk(g.coordinates, 0);
      count++;
    }
  }

  for (const f of fc.features) if (f.geometry) visitGeom(f.geometry);
  if (count === 0) return null;
  return { southWest: [minLat, minLng], northEast: [maxLat, maxLng], featureCount: count };
}

/**
 * Flatten the property tables of a FeatureCollection into a union schema
 * suitable for a bottom attribute table.
 * Returns { columns: string[], rows: Array<Record<string, unknown>> }
 */
function buildPropertyTable(fc, { maxRows = 5000 } = {}) {
  const columns = new Set();
  const rows = [];
  for (const f of fc.features) {
    const props = (f.properties && typeof f.properties === 'object') ? f.properties : {};
    for (const k of Object.keys(props)) columns.add(k);
    const row = { __geometry: f.geometry ? f.geometry.type : '—', __type: 'Feature' };
    for (const [k, v] of Object.entries(props)) row[k] = v;
    rows.push(row);
    if (rows.length >= maxRows) break;
  }
  const colList = [...columns];
  return { columns: colList, rows };
}

export {
  isGeometryType,
  toFeatureCollection,
  coerceFeature,
  extractGeoJsonFromText,
  computeBounds,
  buildPropertyTable,
  GEO_TYPES,
};
