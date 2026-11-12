/**
 * Host half of the GeoJSON Map Viewer bundle.
 *
 * 1. Watches durable Session events (`session/event`) for GeoJSON payloads
 *    (assistant / user message text, `present` file deliveries, `read` /
 *    `write` tool traffic) and keeps a process-local per-session card
 *    registry.
 * 2. Registers an authenticated fetch route under
 *    `/api/geojson-viewer/...` so the Web client can pull the registry
 *    without needing a Typert remote service (which would require a
 *    package import not resolvable from a linked workspace plugin).
 * 3. Deferred file cards are resolved against the session's working
 *    directory and read with `node:fs/promises` — no dependency on
 *    services that may be unavailable.
 *
 * No Session events are appended by this plugin: every card is derived
 * from existing durable events, so forks / resumes / replays stay
 * consistent.
 */
import { promises as fs } from 'node:fs';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const LIST_PATH = '/api/geojson-viewer/list';
const RECENT_PATH = '/api/geojson-viewer/recent';
const READ_PATH = '/api/geojson-viewer/read';
const OPEN_PATH = '/api/geojson-viewer/open';
const SCAN_PATH = '/api/geojson-viewer/scan-workspace';
const WORKSPACE_PATH = '/api/geojson-viewer/workspace';

/**
 * Local static assets for the client. `/plugins` only serves the built client
 * bundle and image assets, so the bundled Leaflet build and its stylesheet are
 * streamed from this package's own `vendor/` directory instead of relying on a
 * CDN. This path stays outside `/api` so a plain <script>/<link> request does
 * not have to pass the API gateway.
 */
const VENDOR_ROUTE = '/geojson-viewer-vendor/';
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const VENDOR_ROOT = join(PLUGIN_ROOT, 'vendor');
const VENDOR_MIME = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

const SESSION_CAP = 200;
const CARDS_PER_SESSION_CAP = 40;
const RECENT_LIMIT = 20;
const INLINE_CAP = 512 * 1024; // embed inline payloads up to 512 KB
const MAX_SCAN = 400_000;

/** Per-session card registry, keyed by session id. */
const registry = new Map();
/** Per-session working directory hints (from `working-directory/change` events). */
const sessionCwd = new Map();

/** Read a live Session by id, if the `sessions` service is available. */
function sessionOf(ctx, sessionId) {
  try {
    return ctx.get?.('sessions')?.get?.(sessionId);
  } catch {
    return undefined;
  }
}

/** The Session header carries the durable working directory. */
function headerCwdOf(session) {
  const cwd = session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

/** Remember a Session's effective working directory from its header. */
function rememberHeaderCwd(session) {
  if (!session?.id) return;
  const cwd = headerCwdOf(session);
  if (cwd) sessionCwd.set(session.id, cwd);
}

/** Resolve a (possibly relative) file path against the session cwd. */
function filePathFor(sessionId, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  if (isAbsolute(filePath)) return filePath;
  const cwd = sessionCwd.get(sessionId);
  return cwd ? resolvePath(cwd, filePath) : filePath;
}

function normalizeForCompare(filePath) {
  return process.platform === 'win32' ? String(filePath).toLowerCase() : String(filePath);
}

function bucketFor(sessionId) {
  let b = registry.get(sessionId);
  if (!b) {
    b = { cards: [], nextSeq: 1 };
    registry.set(sessionId, b);
    if (registry.size > SESSION_CAP) {
      const first = registry.keys().next().value;
      registry.delete(first);
    }
  }
  return b;
}

/** True when this session already has a card for the same file. */
function hasCardFor(sessionId, filePath) {
  const bucket = registry.get(sessionId);
  if (!bucket || !filePath) return false;
  const wanted = normalizeForCompare(filePath);
  return bucket.cards.some((card) => card.filePath && normalizeForCompare(card.filePath) === wanted);
}

function pushCard(sessionId, card) {
  const b = bucketFor(sessionId);
  const id = `gmv-${b.nextSeq++}`;
  const record = {
    id,
    sessionId,
    title: card.title || 'GeoJSON',
    source: card.source,
    filePath: card.filePath || null,
    description: card.description || null,
    featureCount: card.featureCount ?? null,
    bounds: card.bounds ?? null,
    payload: card.payload ?? null,
    tooLarge: !!card.tooLarge,
    createdAt: Date.now(),
  };
  b.cards.push(record);
  if (b.cards.length > CARDS_PER_SESSION_CAP) b.cards.shift();
  return record;
}

function looksLikeGeoJson(text) {
  if (typeof text !== 'string' || text.length < 8) return false;
  return /"type"\s*:\s*"(FeatureCollection|Feature|Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon|GeometryCollection)"/.test(text)
    || text.includes('"features":[') || text.includes('"features": [');
}

function baseName(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

function extractFeatureCollections(text, { limit = 4 } = {}) {
  const found = [];
  const seen = new Set();
  const GEO = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection', 'Feature', 'FeatureCollection']);
  const trimmed = (text || '').slice(0, 10_000_000);
  const seedRe = /{\s*"[^"]*"\s*:/g;
  let m;
  while ((m = seedRe.exec(trimmed)) !== null) {
    const start = m.index;
    const obj = readBalanced(trimmed, start);
    if (!obj) continue;
    const fc = toFC(obj, GEO);
    if (!fc) continue;
    const key = `${fc.features.length}|${fc.features[0]?.geometry?.type || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(fc);
    if (found.length >= limit) break;
    seedRe.lastIndex = start + 2;
  }
  if (!found.length) {
    const t = trimmed.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const fc = toFC(JSON.parse(t), GEO);
        if (fc) found.push(fc);
      } catch { /* not whole-JSON */ }
    }
  }
  return found;

  function toFC(value, geo) {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      const feats = value.map(coerce).filter(Boolean);
      return feats.length ? { type: 'FeatureCollection', features: feats } : null;
    }
    if (value.type === 'FeatureCollection' && Array.isArray(value.features)) {
      const feats = value.features.map(coerce).filter(Boolean);
      return feats.length ? { type: 'FeatureCollection', features: feats } : null;
    }
    const single = coerce(value);
    return single ? { type: 'FeatureCollection', features: [single] } : null;

    function coerce(v) {
      if (!v || typeof v !== 'object') return null;
      if (v.type === 'Feature' && v.geometry && geo.has(v.geometry.type)) {
        return { type: 'Feature', geometry: v.geometry, properties: v.properties && typeof v.properties === 'object' ? v.properties : {} };
      }
      if (geo.has(v.type) && v.coordinates) {
        return { type: 'Feature', geometry: v, properties: {} };
      }
      return null;
    }
  }

  function readBalanced(txt, start) {
    if (txt[start] !== '{') return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < txt.length; i++) {
      const ch = txt[i];
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
          try { return JSON.parse(txt.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }
}

function computeBounds(fc) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  let count = 0;
  const walk = (coords, depth) => {
    if (depth > 12) return;
    if (typeof coords?.[0] === 'number') {
      const lng = coords[0], lat = coords[1];
      if (Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
        minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      }
      return;
    }
    if (Array.isArray(coords)) for (const c of coords) walk(c, depth + 1);
  };
  for (const f of fc.features ?? []) {
    const g = f?.geometry;
    if (!g?.type) continue;
    if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
      for (const sub of g.geometries) if (sub?.coordinates) walk(sub.coordinates, 0);
    } else if (g.coordinates) { walk(g.coordinates, 0); count++; }
  }
  if (count === 0) return null;
  return { southWest: [minLat, minLng], northEast: [maxLat, maxLng], featureCount: count };
}

function scanText(sessionId, text, origin) {
  if (!looksLikeGeoJson(text)) return;
  const found = extractFeatureCollections(text, { limit: 4 });
  if (!found.length) return;
  for (const fc of found) {
    const size = JSON.stringify(fc).length;
    const inline = size <= INLINE_CAP;
    pushCard(sessionId, {
      title: 'GeoJSON detected',
      source: origin,
      description: `${fc.features.length} feature(s), ${size} chars.`,
      featureCount: fc.features.length,
      bounds: computeBounds(fc),
      payload: inline ? fc : null,
      tooLarge: !inline,
    });
  }
}

/**
 * Register a file-backed card. The payload is read lazily by `/read`, so a
 * card may be registered as soon as a tool call names the file (the write may
 * still be in flight when the durable event is appended).
 */
function addFileCard(sessionId, rawPath, title, source, description) {
  const filePath = filePathFor(sessionId, rawPath);
  if (!filePath || !/\.(geojson|json)$/i.test(filePath)) return false;
  if (hasCardFor(sessionId, filePath)) return false;
  pushCard(sessionId, {
    title: title || baseName(filePath),
    source,
    filePath,
    description: description || 'GeoJSON file detected.',
    payload: null,
    bounds: null,
    tooLarge: false,
    deferredRead: true,
  });
  return true;
}

function onSessionEvent(session, event) {
  if (!session?.id || !event || typeof event !== 'object') return;
  const sid = session.id;
  const type = event.type || '';
  const data = event.data ?? event.payload ?? event;
  rememberHeaderCwd(session);

  switch (type) {
    case 'assistant/message':
    case 'user/message':
    case 'system/message':
    case 'developer/message': {
      const msg = data.message || data;
      scanText(sid, textOfContent(msg.content), type === 'assistant/message' ? 'assistant-message' : 'user-message');
      return;
    }
    case 'deliverables/presented': {
      // Appended by @deepseek-ai/dsh-tool-present with
      // `{ turn, callId, files: [{ path, description? }] }`. This is the
      // durable, exact signal for `present` deliveries.
      const files = Array.isArray(data.files) ? data.files : [];
      for (const f of files) {
        addFileCard(sid, f?.path, f?.description || baseName(f?.path || ''), 'present-file', 'Presented file looks like GeoJSON.');
      }
      return;
    }
    case 'tool/call': {
      // `write` is how a generated `.geojson` file usually enters the session.
      // `read`/`edit` are also file-backed; all of them become deferred cards
      // and are loaded from disk by `/read`.
      const toolName = data.name || data.tool;
      if (toolName !== 'write' && toolName !== 'edit' && toolName !== 'read') return;
      let args = data.arguments ?? data.args;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { return; }
      }
      if (!args || typeof args !== 'object') return;
      const rawPath = args.file_path || args.filePath || args.path;
      if (!rawPath) return;
      // `read` is extremely common (package.json, lockfiles, …); only a
      // `.geojson` read is worth a file card. A `write` may target a plain
      // `.json` file that still contains a FeatureCollection.
      const interesting = /\.geojson$/i.test(rawPath)
        || (toolName === 'write' && /\.json$/i.test(rawPath));
      if (!interesting) return;
      addFileCard(sid, rawPath, baseName(rawPath), `tool-${toolName}`, `${toolName} touched this GeoJSON file.`);
      return;
    }
    case 'tool/ptc-dispatch': {
      const content = data.content;
      const toolName = data.name || data.tool;
      if (toolName === 'present' && content) {
        const files = collectPresentFiles(content);
        for (const f of files) {
          addFileCard(sid, f?.path, f?.description || baseName(f?.path || ''), 'present-file', 'Presented file looks like GeoJSON.');
        }
      }
      return;
    }
    case 'working-directory/change': {
      // The durable event carries `{ cwd }`; the old code looked for
      // `working-directory` (without `/change`), so this never matched.
      const cwd = data.cwd || data.path || data.directory;
      if (typeof cwd === 'string' && cwd.length > 0) sessionCwd.set(sid, cwd);
      return;
    }
    case 'tool/result': {
      const result = data.message?.content ?? data.result?.content ?? data.content;
      if (typeof result === 'string') scanText(sid, result, 'tool-result');
      else if (Array.isArray(result)) {
        for (const block of result) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            scanText(sid, block.text, 'tool-result');
          }
        }
      }
      return;
    }
    default:
      return;
  }
}

function collectPresentFiles(content) {
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        try {
          const parsed = JSON.parse(block.text);
          if (parsed && Array.isArray(parsed.files)) return parsed.files;
        } catch { /* fall through */ }
      }
    }
  }
  if (content && Array.isArray(content.files)) return content.files;
  return [];
}

/** Resolve a deferred file card: read the file, parse GeoJSON, return payload. */
async function resolveDeferredCard(record) {
  if (record.payload || !record.filePath) {
    return { found: true, payload: record.payload, bounds: record.bounds, featureCount: record.featureCount };
  }
  const storedSessionCwd = sessionCwd.get(record.sessionId);
  const absPath = isAbsolute(record.filePath) || !storedSessionCwd
    ? record.filePath
    : resolvePath(storedSessionCwd, record.filePath);
  try {
    let text = await fs.readFile(absPath, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const found = extractFeatureCollections(text.slice(0, MAX_SCAN), { limit: 1 });
    const fc = found[0];
    if (!fc) return { found: true, payload: null, bounds: record.bounds, error: 'not geojson' };
    const size = JSON.stringify(fc).length;
    const inline = size <= INLINE_CAP * 4;
    const bounds = computeBounds(fc);
    if (inline) {
      // Cache the parsed payload so the 3-second `/list` poll does not
      // re-read and re-parse the same file on every client refresh.
      record.payload = fc;
      record.bounds = bounds;
      record.featureCount = fc.features.length;
      record.filePath = absPath;
    }
    return {
      found: true,
      payload: inline ? fc : null,
      bounds,
      featureCount: fc.features.length,
      error: inline ? undefined : 'too large for inline delivery; feature count reported',
    };
  } catch (error) {
    return { found: true, payload: null, bounds: record.bounds, error: String(error?.message || error) };
  }
}

/** Recursively walk a directory and return absolute paths of .geojson / .json files. */
async function collectGeoJsonFiles(dir) {
  const results = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolvePath(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden dirs and node_modules to keep scan fast
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          results.push(...await collectGeoJsonFiles(fullPath));
        }
      } else if (entry.isFile() && /\.(geojson|json)$/i.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch { /* permission denied – skip this subtree */ }
  return results;
}

/** Scan the full workspace tree for .geojson / .json files and seed cards. */
async function scanWorkspaceForGeoJson(ctx, sessionId, workspaceRoot) {
  // Prefer an explicit root, then the Session's remembered cwd, then the
  // service fallbacks. No HOME fallback — scanning the whole home directory
  // is too broad and slow.
  let dir = workspaceRoot || sessionCwd.get(sessionId);
  if (!dir) {
    dir = await resolveWorkspaceRoot(ctx, sessionId);
    if (dir) sessionCwd.set(sessionId, dir);
  }
  if (!dir) return { added: [], removed: [] };
  try {
    const geoFiles = await collectGeoJsonFiles(dir);
    if (!geoFiles.length) return { added: [], removed: [] };

    const bucket = registry.get(sessionId);
    const existingPaths = new Set(
      (bucket?.cards ?? [])
        .map((c) => c.filePath)
        .filter(Boolean)
        .map(normalizeForCompare),
    );
    const currentFiles = new Set(geoFiles.map(normalizeForCompare));

    // Identify stale cards whose files no longer exist on disk.
    const removed = [];
    if (bucket) {
      for (const card of [...bucket.cards]) {
        if (card.source === 'workspace-scan' && card.filePath && !currentFiles.has(normalizeForCompare(card.filePath))) {
          bucket.cards.splice(bucket.cards.indexOf(card), 1);
          removed.push(card.id);
        }
      }
    }

    // Add cards only for files not yet tracked.
    const added = [];
    for (const filePath of geoFiles) {
      const key = normalizeForCompare(filePath);
      if (existingPaths.has(key)) continue;
      let text;
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (!text || text.length < 8) continue;
      const found = extractFeatureCollections(text.slice(0, MAX_SCAN), { limit: 1 });
      if (!found.length) continue;
      existingPaths.add(key);
      const fc = found[0];
      const size = JSON.stringify(fc).length;
      const inline = size <= INLINE_CAP;
      const card = pushCard(sessionId, {
        title: baseName(filePath),
        source: 'workspace-scan',
        filePath,
        description: `${fc.features.length} feature(s), ${size} chars.`,
        featureCount: fc.features.length,
        bounds: computeBounds(fc),
        payload: inline ? fc : null,
        tooLarge: !inline,
      });
      added.push(card.id);
    }
    return { added, removed };
  } catch {
    return { added: [], removed: [] };
  }
}

/** Resolve the effective workspace root for a session, with multiple fallback strategies. */
async function resolveWorkspaceRoot(ctx, sessionId) {
  // Strategy 0: The durable Session header carries `cwd` and is always
  // available for a live session — no service lookup needed.
  const session = sessionOf(ctx, sessionId);
  if (session) {
    const cwd = headerCwdOf(session);
    if (cwd) return cwd;
  }

  // Strategy 1: Use the workingDirectory service (most reliable for live sessions)
  try {
    const workingDirectory = ctx.get?.('workingDirectory');
    if (workingDirectory && session) {
      const cwd = workingDirectory.get(session);
      if (cwd) return cwd;
    }
  } catch { /* service unavailable — try the next strategy */ }

  // Strategy 2: Try workspaceRegistry to get the active workspace
  try {
    const workspaceRegistry = ctx.get?.('workspaceRegistry');
    if (workspaceRegistry) {
      const workspaces = workspaceRegistry.list();
      if (workspaces?.length > 0) {
        // Return the first workspace path (typically the active/default one)
        return workspaces[0].path;
      }
    }
  } catch { /* service unavailable — try the next strategy */ }

  // Strategy 3: Fall back to sessionPersistence to get SessionHeader.cwd
  try {
    const persistence = ctx.get?.('sessionPersistence');
    if (persistence) {
      const header = await persistence.getSessionHeader?.(sessionId);
      if (header?.cwd) return header.cwd;
    }
  } catch { /* service unavailable */ }

  // All strategies exhausted
  return null;
}

/** Stable loader identity. */
export const name = 'dsh-geojson-map-viewer';

/**
 * The route carrier. Declaring it makes Cordis activate this plugin only once
 * the composition's `webServer` exists — reading `ctx.get('webServer')` during
 * plain activation returned `undefined` and silently skipped every route.
 * `sessions` is injected for the same reason: the registry seeds from durable
 * session events and needs the live Session objects.
 */
export const inject = ['webServer', 'sessions'];

/** Events scanned per session when the registry has to rebuild itself. */
const SEED_WINDOW = 3000;
/** Sessions scanned by the cross-session `/recent` fallback. */
const SEED_SESSIONS = 5;
/** Wall-clock budget for one rebuild, so a first read stays responsive. */
const SEED_BUDGET_MS = 2000;
/** Sessions whose registry was already rebuilt from the log. */
const seeded = new Set();
/** Sessions whose workspace has already been scanned once. */
const workspaceScanned = new Set();

/**
 * Rebuild a session's cards from its durable log. A restart drops the
 * in-memory registry, so the first client read replays the relevant events
 * (the same `onSessionEvent` path the live watcher uses). Bounded and
 * one-shot per session, but a missing/unrestored Session is retried later.
 */
function seedSession(ctx, sessionId) {
  if (seeded.has(sessionId)) return;
  const session = sessionOf(ctx, sessionId);
  if (!session) return;
  rememberHeaderCwd(session);
  seeded.add(sessionId);
  const end = Number(session.seq ?? 0);
  if (!Number.isFinite(end) || end <= 0) {
    if (!sessionCwd.has(sessionId)) {
      resolveWorkspaceRoot(ctx, sessionId).then((cwd) => {
        if (cwd) sessionCwd.set(sessionId, cwd);
      }).catch(() => {});
    }
    return;
  }
  const start = Math.max(0, end - SEED_WINDOW);
  const deadline = Date.now() + SEED_BUDGET_MS;
  // Walk backwards so the newest events (a `present` from the last turn) are
  // always inside the budget, then replay the slice forwards so cards keep
  // their chronological order.
  const collected = [];
  for (let seq = end - 1; seq >= start; seq -= 1) {
    if (Date.now() > deadline) break;
    let event;
    try {
      event = session.eventAt(seq);
    } catch {
      continue;
    }
    if (event) collected.push(event);
  }
  collected.reverse();
  for (const event of collected) {
    try {
      onSessionEvent(session, event);
    } catch { /* one malformed event cannot block the rebuild */ }
  }
  // Fallback: if no cwd event/header was available, try the services once.
  if (!sessionCwd.has(session.id)) {
    resolveWorkspaceRoot(ctx, sessionId).then((cwd) => {
      if (cwd) sessionCwd.set(sessionId, cwd);
    }).catch(() => {});
  }
}

export function apply(ctx) {
  // Session event watcher (durable events only — replay-safe by construction).
  // Cordis invokes `session/event` listeners as `(session, event)`; reading
  // `payload.event` from a `{ session, event }` object never matched and was
  // why live detection silently did nothing.
  const offEvent = ctx.on('session/event', (session, event) => {
    try {
      if (!session?.id || !event) return;
      onSessionEvent(session, event);
      // Track the effective working directory per session.
      if (event.type === 'working-directory/change') {
        const cwd = event.data?.cwd || event.data?.path;
        if (typeof cwd === 'string' && cwd.length > 0) {
          sessionCwd.set(session.id, cwd);
          // A new working directory is a new scan target.
          workspaceScanned.delete(session.id);
        }
      }
      // Fallback: if no cwd is known and we have a valid session id, try services
      if (!sessionCwd.has(session.id)) {
        resolveWorkspaceRoot(ctx, session.id).then((cwd) => {
          if (cwd) sessionCwd.set(session.id, cwd);
        }).catch(() => {});
      }
    } catch (err) {
      ctx.logger?.warn?.('geojson-viewer: scan failed', err);
    }
  });

  const offDisposed = ctx.on('session/disposed', (session) => {
    if (session?.id) {
      registry.delete(session.id);
      sessionCwd.delete(session.id);
      seeded.delete(session.id);
      workspaceScanned.delete(session.id);
    }
  });

  // Client-facing fetch routes on the Web server, mirroring the shipped
  // `dsh-host-open-in-app` pattern: `webServer` is injected (declared above),
  // and every handler asks the composition's `connection` service for a
  // rejection first (Host/Origin fence + login-token cookie).
  ctx.effect(() => {
    const webServer = ctx.webServer;
    if (!webServer?.register) return;

    const sendJson = (res, status, body) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };

    const urlOf = (req) => new URL(String(req.url), 'http://localhost');

    /** Answer an untrusted/unauthenticated request; true when rejected. */
    const rejected = (req, res) => {
      let connection;
      try {
        connection = ctx.get('connection');
      } catch {
        connection = undefined;
      }
      const rejection = connection?.requestRejection?.(req);
      if (rejection === undefined) return false;
      res.statusCode = rejection;
      res.end();
      return true;
    };

    /** Serve the plugin's own static vendor files (Leaflet JS/CSS/images). */
    const serveVendor = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET, HEAD');
        res.end();
        return;
      }
      let relative;
      try {
        relative = decodeURIComponent(urlOf(req).pathname.slice(VENDOR_ROUTE.length));
      } catch {
        res.statusCode = 400;
        res.end();
        return;
      }
      const target = resolvePath(VENDOR_ROOT, relative);
      if (target !== VENDOR_ROOT && !target.startsWith(VENDOR_ROOT + sep)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      const type = VENDOR_MIME.get(extname(target).toLowerCase());
      if (!type) {
        res.statusCode = 404;
        res.end();
        return;
      }
      try {
        const data = await fs.readFile(target);
        res.statusCode = 200;
        res.setHeader('content-type', type);
        res.setHeader('cache-control', 'public, max-age=3600');
        if (req.method === 'HEAD') res.end();
        else res.end(data);
      } catch {
        res.statusCode = 404;
        res.end();
      }
    };

    // Collect every route disposer: the previous code returned nothing from
    // this effect, so a plugin reload/enable left the old routes registered
    // and the next activation threw `webserver: duplicate exact route`.
    const disposers = [];
    const register = (route) => {
      const dispose = webServer.register(route);
      disposers.push(dispose);
      return dispose;
    };

    register({
      kind: 'prefix',
      path: VENDOR_ROUTE,
      handler: serveVendor,
    }, `geojson-viewer: GET ${VENDOR_ROUTE}`);

    register({
      kind: 'exact',
      path: LIST_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end();
          return;
        }
        const sessionId = urlOf(req).searchParams.get('sessionId');
        if (!sessionId) {
          sendJson(res, 400, { code: 'bad-request', message: 'missing sessionId' });
          return;
        }
        let b = registry.get(sessionId);
        if (!b || b.cards.length === 0) {
          seedSession(ctx, sessionId);
          b = registry.get(sessionId);
          // A session that never called `present` still usually has GeoJSON
          // files sitting in its working directory. Scan once so opening the
          // viewer is enough to see them, even before the client asks.
          if ((!b || b.cards.length === 0) && !workspaceScanned.has(sessionId)) {
            workspaceScanned.add(sessionId);
            await scanWorkspaceForGeoJson(ctx, sessionId);
            b = registry.get(sessionId);
          }
        }
        sendJson(res, 200, { cards: b ? b.cards : [] });
      },
    }, `geojson-viewer: GET ${LIST_PATH}`);

    register({
      kind: 'exact',
      path: WORKSPACE_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end();
          return;
        }
        const sessionId = urlOf(req).searchParams.get('sessionId');
        if (!sessionId) {
          sendJson(res, 400, { code: 'bad-request', message: 'missing sessionId' });
          return;
        }
        // Seed first so sessionCwd is populated from durable events.
        let b = registry.get(sessionId);
        if (!b || b.cards.length === 0) {
          seedSession(ctx, sessionId);
        }
        const session = sessionOf(ctx, sessionId);
        rememberHeaderCwd(session);
        let root = sessionCwd.get(sessionId) || headerCwdOf(session);
        if (!root) root = await resolveWorkspaceRoot(ctx, sessionId);
        sendJson(res, 200, { workspaceRoot: root ?? null });
      },
    }, `geojson-viewer: GET ${WORKSPACE_PATH}`);

    register({
      kind: 'exact',
      path: RECENT_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end();
          return;
        }
        // Cross-session fallback for a viewer that could not resolve its
        // bound session id. Seeds from live session logs when the in-memory
        // registry is empty (first read after a restart), then returns the
        // newest cards.
        const collect = () => {
          const cards = [];
          for (const bucket of registry.values()) {
            for (const card of bucket.cards) cards.push(card);
          }
          return cards.sort((a, b) => b.createdAt - a.createdAt);
        };
        let cards = collect();
        if (!cards.length) {
          let sessions;
          try {
            sessions = ctx.get('sessions');
          } catch {
            sessions = undefined;
          }
          for (const session of (sessions?.list?.() || []).slice(-SEED_SESSIONS)) {
            if (session?.id) seedSession(ctx, session.id);
          }
          cards = collect();
        }
        sendJson(res, 200, { cards: cards.slice(0, RECENT_LIMIT) });
      },
    }, `geojson-viewer: GET ${RECENT_PATH}`);

    register({
      kind: 'exact',
      path: READ_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end();
          return;
        }
        const params = urlOf(req).searchParams;
        const sessionId = params.get('sessionId');
        const cardId = params.get('cardId');
        if (!sessionId || !cardId) {
          sendJson(res, 400, { code: 'bad-request', message: 'missing sessionId or cardId' });
          return;
        }
        let record = registry.get(sessionId)?.cards.find((c) => c.id === cardId);
        if (!record) {
          seedSession(ctx, sessionId);
          record = registry.get(sessionId)?.cards.find((c) => c.id === cardId);
        }
        if (!record) {
          sendJson(res, 404, { found: false });
          return;
        }
        const result = await resolveDeferredCard(record);
        sendJson(res, 200, result);
      },
    }, `geojson-viewer: GET ${READ_PATH}`);

    register({
      kind: 'exact',
      path: OPEN_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'POST');
          res.end();
          return;
        }
        let text;
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            chunks.push(chunk);
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
              sendJson(res, 413, { code: 'payload-too-large', message: 'card body exceeds 2 MB' });
              return;
            }
          }
          text = Buffer.concat(chunks).toString('utf8');
        } catch (error) {
          sendJson(res, 400, { code: 'bad-request', message: String(error?.message || error) });
          return;
        }
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          sendJson(res, 400, { code: 'bad-request', message: 'invalid JSON body' });
          return;
        }
        const sessionId = body?.sessionId;
        if (!sessionId) {
          sendJson(res, 400, { code: 'bad-request', message: 'missing sessionId' });
          return;
        }
        const card = pushCard(sessionId, body.card || body);
        sendJson(res, 200, { card });
      },
    }, `geojson-viewer: POST ${OPEN_PATH}`);

    register({
      kind: 'exact',
      path: SCAN_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'POST');
          res.end();
          return;
        }
        let text;
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            chunks.push(chunk);
            size += chunk.length;
            if (size > 64 * 1024) {
              sendJson(res, 413, { code: 'payload-too-large', message: 'scan body too large' });
              return;
            }
          }
          text = Buffer.concat(chunks).toString('utf8');
        } catch (error) {
          sendJson(res, 400, { code: 'bad-request', message: String(error?.message || error) });
          return;
        }
        let body;
        try { body = JSON.parse(text); } catch {
          sendJson(res, 400, { code: 'bad-request', message: 'invalid JSON body' });
          return;
        }
        const sessionId = body?.sessionId;
        let workspaceRoot = body?.workspaceRoot; // optional: absolute path to scan instead of cwd
        if (!sessionId) {
          sendJson(res, 400, { code: 'bad-request', message: 'missing sessionId' });
          return;
        }
        // Ensure the session's registry exists (seed from durable log first)
        let b = registry.get(sessionId);
        if (!b || b.cards.length === 0) {
          seedSession(ctx, sessionId);
        }
        if (!workspaceRoot) {
          const session = sessionOf(ctx, sessionId);
          rememberHeaderCwd(session);
          workspaceRoot = sessionCwd.get(sessionId) || headerCwdOf(session);
          if (!workspaceRoot) workspaceRoot = await resolveWorkspaceRoot(ctx, sessionId);
          if (workspaceRoot) sessionCwd.set(sessionId, workspaceRoot);
        }
        const result = await scanWorkspaceForGeoJson(ctx, sessionId, workspaceRoot);
        b = registry.get(sessionId);
        sendJson(res, 200, {
          workspaceRoot: workspaceRoot ?? null,
          cards: b ? b.cards : [],
          newlyAdded: result.added.length,
          addedIds: result.added,
          removedIds: result.removed,
        });
      },
    }, `geojson-viewer: POST ${SCAN_PATH}`);
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* already removed */ }
      }
    };
  }, 'geojson-viewer: web server routes');

  return () => {
    offEvent();
    offDisposed();
  };
}
