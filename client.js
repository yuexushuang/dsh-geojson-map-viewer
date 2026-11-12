/**
 * Client half of the GeoJSON Map Viewer bundle.
 *
 * Registers:
 *  - `conversation.view` entry "dsh-geojson-map-viewer" — the GeoJSON viewer
 *    view (map + controls + attribute table). Shown when the session has
 *    pending GeoJSON cards.
 *  - `conversation.chat.assistant-actions` entry — a "View as Map" action
 *    on assistant messages that detected GeoJSON.
 *
 * Leaflet is streamed from the Host half's `/geojson-viewer-vendor/` route
 * (backed by this package's `vendor/` directory), so the map works without
 * reaching a public CDN. CDNs remain a last-resort fallback.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-geojson-map-viewer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = React;

    // ── Locale ──────────────────────────────────────────────────────────
    // Visible strings go through the client locale service so the plugin
    // honors the active UI language.
    function useT() {
      const [dict, setDict] = useState({});
      useEffect(() => {
        const locale = window.__DSH_LOCALE__?.getSnapshot?.();
        if (!locale) return;
        const read = () => {
          try {
            const snap = window.__DSH_LOCALE__?.getSnapshot?.() || {};
            setDict(snap.geojsonViewer || {});
          } catch { /* locale service unavailable — fall back to en */ }
        };
        read();
        const off = window.__DSH_LOCALE__?.subscribe?.(read);
        return off ? () => off() : undefined;
      }, []);
      const t = useCallback((key, fallback) => dict[key] ?? fallback, [dict]);
      return t;
    }

    // ── Leaflet loader ──────────────────────────────────────────────────
    // The host plugin streams the bundled Leaflet build, stylesheet, and
    // marker images from its own `vendor/` directory at
    // `/geojson-viewer-vendor/...`. The `/plugins` route only serves the
    // built client bundle and image assets, so the old
    // `plugins/@local/dsh-geojson-map-viewer/leaflet.js` URLs always 404'd and
    // the viewer fell back to a CDN. CDNs remain a last resort only.
    const LEAFLET_BASE = '/geojson-viewer-vendor/';
    let leafletPromise = null;

    function loadLeaflet() {
      if (window.L && window.L.Map) return Promise.resolve(window.L);
      if (leafletPromise) return leafletPromise;
      leafletPromise = new Promise((resolve, reject) => {
        const sources = [
          LEAFLET_BASE + 'leaflet.js',
          'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
          'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
        ];
        let resolved = false;
        const done = (ok, err) => {
          if (resolved) return;
          resolved = true;
          if (ok) resolve(window.L);
          else reject(err || new Error('failed to load Leaflet from all sources'));
        };
        const loadJs = (url) => new Promise((r) => {
          const script = document.createElement('script');
          script.src = url;
          script.async = true;
          script.onload = () => r(true);
          script.onerror = () => {
            script.remove();
            r(false);
          };
          document.head.appendChild(script);
        });
        (async () => {
          for (const url of sources) {
            const ok = await loadJs(url);
            if (ok && window.L && window.L.Map) return done(true);
          }
          done(false, new Error('all Leaflet sources failed'));
        })();
      });
      return leafletPromise;
    }

    // Leaflet CSS (must be loaded before the first map renders). The local
    // stylesheet references `images/marker-icon.png`, which the same vendor
    // route serves.
    function ensureLeafletCss() {
      const existing = document.querySelector('link[data-geojson-leaflet-css]');
      if (existing) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_BASE + 'leaflet.css';
      link.dataset.geojsonLeafletCss = '1';
      let fallback = 0;
      link.onerror = () => {
        fallback += 1;
        if (fallback === 1) link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        else if (fallback === 2) link.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
        else link.remove();
      };
      document.head.appendChild(link);
    }

    // ── Base map layer definitions (OSM + ArcGIS imagery only) ────────
    const BASE_LAYERS = {
      osm: {
        label: 'OpenStreetMap',
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '&copy; OpenStreetMap contributors',
      },
      arcgisImagery: {
        label: 'ArcGIS Imagery',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Esri, Maxar, Earthstar Geographics',
      },
    };

    // ── Map card component ─────────────────────────────────────────────
    // Renders one GeoJSON card: a Leaflet map with zoom controls,
    // base-map switcher, and a "View Data Table" button that toggles
    // a bottom attribute table.

    function MapCard({ card, t, locale }) {
      const mapElRef = useRef(null);
      const mapRef = useRef(null);
      const baseLayerRef = useRef(null);
      const dataLayerRef = useRef(null);
      const [baseKey, setBaseKey] = useState('arcgisImagery');
      const [showTable, setShowTable] = useState(false);
      const [leafletReady, setLeafletReady] = useState(false);
      const [error, setError] = useState(null);

      const featureCollection = card.payload;

      // Compute table data
      const tableData = useMemo(() => {
        if (!featureCollection) return null;
        const columns = new Set();
        const rows = [];
        for (const f of featureCollection.features) {
          const props = (f.properties && typeof f.properties === 'object') ? f.properties : {};
          for (const k of Object.keys(props)) columns.add(k);
          const row = { __idx: rows.length + 1, __type: f.geometry?.type || '—' };
          for (const [k, v] of Object.entries(props)) row[k] = v;
          rows.push(row);
        }
        return { columns: [...columns], rows: rows.slice(0, 200) };
      }, [featureCollection]);

      // Load Leaflet + CSS
      useEffect(() => {
        let cancelled = false;
        ensureLeafletCss();
        loadLeaflet().then((L) => {
          if (cancelled) return;
          setLeafletReady(true);
          // Initialize map. The GeoJSON layer is added by the separate effect
          // below, so a payload that arrives after the map exists (a deferred
          // `/read` response) still renders.
          if (mapElRef.current && !mapRef.current) {
            const bounds = card.bounds;
            const map = L.map(mapElRef.current, {
              center: bounds ? [
                (bounds.southWest[0] + bounds.northEast[0]) / 2,
                (bounds.southWest[1] + bounds.northEast[1]) / 2,
              ] : [20, 110],
              zoom: bounds ? 6 : 4,
              zoomControl: true,
            });
            mapRef.current = map;
            map.whenReady(() => setTimeout(() => map.invalidateSize(), 100));
          }
        }).catch((err) => setError(err.message));
        return () => { cancelled = true; };
      }, []);

      // Add or replace the GeoJSON layer whenever the payload changes. The
      // key deliberately ignores object identity: every 3-second `/list` poll
      // returns a freshly parsed payload, and rebuilding the layer then would
      // reset the viewport and popups on every poll.
      const boundsKey = card.bounds ? JSON.stringify(card.bounds) : '';
      const layerKey = `${card.id}|${card.featureCount ?? ''}|${boundsKey}`;
      useEffect(() => {
        const L = window.L;
        const map = mapRef.current;
        if (!leafletReady || !L || !map || !featureCollection) return;
        if (dataLayerRef.current) {
          map.removeLayer(dataLayerRef.current);
          dataLayerRef.current = null;
        }
        const layer = L.geoJSON(featureCollection, {
          pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
            radius: 6, fillColor: '#4285f4', fillOpacity: 0.8, color: '#fff', weight: 1,
          }),
          style: () => ({
            color: '#4285f4', weight: 2, fillColor: '#4285f4', fillOpacity: 0.15,
          }),
          onEachFeature: (feature, lyr) => {
            const props = feature.properties || {};
            const lines = Object.entries(props).map(([k, v]) => `<b>${k}:</b> ${JSON.stringify(v)}`);
            lyr.bindPopup(lines.join('<br/>') || 'No attributes');
          },
        }).addTo(map);
        dataLayerRef.current = layer;
        if (card.bounds) {
          map.fitBounds([card.bounds.southWest, card.bounds.northEast], { padding: [20, 20] });
        }
      }, [leafletReady, layerKey]);

      // Switch base map
      const switchBase = useCallback((key) => {
        setBaseKey(key);
        const L = window.L;
        if (!L || !mapRef.current) return;
        if (baseLayerRef.current) mapRef.current.removeLayer(baseLayerRef.current);
        const def = BASE_LAYERS[key];
        if (!def) return;
        baseLayerRef.current = L.tileLayer(def.url, {
          attribution: def.attribution,
          maxZoom: 19,
        }).addTo(mapRef.current);
        // Bring data layer to front
        if (dataLayerRef.current) dataLayerRef.current.bringToFront?.();
      }, []);

      // Initial base map
      useEffect(() => {
        if (leafletReady) switchBase(baseKey);
        // eslint-disable-next-line
      }, [leafletReady]);

      // Cleanup on unmount
      useEffect(() => () => {
        if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      }, []);

      const baseEntries = Object.entries(BASE_LAYERS);

      return h('div', {
        className: 'gmv-card',
        style: {
          display: 'flex', flexDirection: 'column',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-layer-1)',
          maxWidth: 900,
          margin: '8px 0',
        },
      },
        // Header row
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-base)',
          },
        },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 600 },
          },
            MapIcon(),
            h('span', null, card.title),
            card.featureCount != null
              ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, fontWeight: 400 } },
                  t('featureCount', '{n} features').replace('{n}', card.featureCount))
              : null,
          ),
          // Base-map dropdown (OSM + ArcGIS imagery only)
          h('label', {
            style: { display: 'flex', alignItems: 'center', gap: 6 },
          },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } },
              t('baseMap', 'Base map')),
            h('select', {
              value: baseKey,
              onChange: (e) => switchBase(e.target.value),
              'aria-label': t('baseMap', 'Base map'),
              title: t('baseMap', 'Base map'),
              style: selectStyle(),
            },
              baseEntries.map(([key, def]) =>
                h('option', { key, value: key }, t('layer_' + key, def.label)),
              ),
            ),
          ),
        ),
        // Map container
        h('div', {
          style: { position: 'relative', height: 380, background: '#0a0a0a' },
        },
          h('div', { ref: mapElRef, style: { position: 'absolute', inset: 0 } }),
          error
            ? h('div', {
                style: {
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(0,0,0,0.6)', color: '#ff6b6b', fontSize: 13,
                },
              }, t('loadFailed', 'Failed to load map library') + ': ' + error)
            : null,
          !leafletReady && !error
            ? h('div', {
                style: {
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
                },
              }, t('loading', 'Loading map…'))
            : null,
        ),
        // Toolbar row: View Data Table
        h('div', {
          style: {
            display: 'flex', gap: 8, padding: '8px 12px',
            borderBottom: showTable ? '1px solid var(--dsw-alias-border-l1)' : 'none',
          },
        },
          h('button', {
            onClick: () => setShowTable((v) => !v),
            'aria-expanded': showTable,
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', borderRadius: 6, fontSize: 12,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: showTable ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)' : 'var(--dsw-alias-bg-base)',
              color: 'var(--dsw-alias-label-primary)',
              cursor: 'pointer',
            },
          },
            TableIcon(),
            t('dataTable', 'View Data Table'),
            showTable ? ' ▲' : ' ▼',
          ),
          card.source === 'present-file' || card.source === 'tool-result'
            ? h('span', {
                style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-secondary)', fontSize: 11, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 },
                title: card.filePath || card.description || '',
              }, card.filePath || card.description || '')
            : null,
        ),
        // Attribute table
        showTable && tableData
          ? h('div', {
              style: {
                maxHeight: 280, overflow: 'auto',
                background: 'var(--dsw-alias-bg-base)',
              },
            },
              h('table', {
                style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
              },
                h('thead', {
                  style: { position: 'sticky', top: 0, background: 'var(--dsw-alias-bg-layer-2)', zIndex: 1 },
                },
                  h('tr', null,
                    h('th', { style: thStyle() }, '#'),
                    h('th', { style: thStyle() }, t('geometryType', 'Geometry')),
                    tableData.columns.map((c) => h('th', { key: c, style: thStyle() }, c)),
                  ),
                ),
                h('tbody', null,
                  tableData.rows.map((row, i) =>
                    h('tr', {
                      key: i,
                      style: {
                        borderBottom: '1px solid var(--dsw-alias-border-l1)',
                        background: i % 2 ? 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 40%, transparent)' : 'transparent',
                      },
                    },
                      h('td', { style: tdStyle() }, row.__idx),
                      h('td', { style: { ...tdStyle(), color: 'var(--dsw-alias-brand-primary)', fontFamily: 'monospace', fontSize: 11 } }, row.__type),
                      tableData.columns.map((c) =>
                        h('td', { key: c, style: tdStyle(), title: String(row[c] ?? '') },
                          row[c] === undefined || row[c] === null ? '' :
                          typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c]),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    // ── Viewer view (conversation.view entry) ──────────────────────────
    // The Host half keeps a per-session registry of GeoJSON cards (detected in
    // user/assistant messages, tool results, and `present` deliveries). The
    // view entry injects the bound session id; this component pulls that
    // registry over the Host's authenticated fetch routes and resolves
    // deferred file cards lazily (`payload: null` + `filePath`).
    function GeoJsonViewerView({ sessionId }) {
      const t = useT();
      const [cards, setCards] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [activeId, setActiveId] = useState(null);

      // Reset active selection whenever the bound session changes so that
      // switching sessions never leaves a stale card id from the previous one.
      useEffect(() => { setActiveId(null); }, [sessionId]);

      const readDeferred = useCallback(async (card, sid) => {
        if (card.payload || !card.filePath || !sid) return card;
        try {
          const res = await fetch(`/api/geojson-viewer/read?sessionId=${encodeURIComponent(sid)}&cardId=${encodeURIComponent(card.id)}`);
          if (!res.ok) {
            return { ...card, error: `read failed (HTTP ${res.status})` };
          }
          const data = await res.json();
          return {
            ...card,
            payload: data?.payload ?? null,
            bounds: data?.bounds ?? card.bounds,
            featureCount: data?.featureCount ?? card.featureCount,
            error: data?.error,
          };
        } catch (e) {
          return { ...card, error: String(e?.message || e) };
        }
      }, []);

      const load = useCallback(async ({ scan = false } = {}) => {
        setBusy(true);
        try {
          // Try session-scoped list first (only used when sessionId is bound).
          // /recent is kept as a last-resort fallback only when the
          // session-scoped request fails completely — not when it simply
          // returns an empty list (the empty list is a valid answer for a
          // session with no GeoJSON content yet).
          let cardsFromServer = [];
          let problems = [];
          if (sessionId && scan) {
            // Discover `.geojson` / `.json` files that already exist in the
            // session working directory. Without this request the Host only
            // knew about files named by `present` or embedded in message text,
            // which is why a file created by `write` never appeared.
            try {
              const scanRes = await fetch('/api/geojson-viewer/scan-workspace', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId }),
              });
              if (!scanRes.ok) problems.push(`/scan-workspace → HTTP ${scanRes.status}`);
            } catch (e) {
              problems.push(`/scan-workspace → ${String(e?.message || e)}`);
            }
          }
          if (sessionId) {
            try {
              const res = await fetch(
                `/api/geojson-viewer/list?sessionId=${encodeURIComponent(sessionId)}`,
              );
              if (res.ok) {
                const body = await res.json();
                if (Array.isArray(body?.cards)) {
                  cardsFromServer = body.cards;
                } else {
                  problems.push('/list → no cards field');
                }
              } else {
                problems.push(`/list → HTTP ${res.status}`);
              }
            } catch (e) {
              problems.push(`/list → ${String(e?.message || e)}`);
            }
          }
          // Only consult /recent when the session endpoint failed outright.
          if (!cardsFromServer.length && problems.length) {
            try {
              const res = await fetch('/api/geojson-viewer/recent');
              if (res.ok) {
                const body = await res.json();
                if (Array.isArray(body?.cards)) cardsFromServer = body.cards;
              }
            } catch { /* ignore */ }
          }
          if (!cardsFromServer.length && problems.length) {
            throw new Error(`GeoJSON viewer API unavailable (${problems.join('; ')})`);
          }
          const resolved = await Promise.all(cardsFromServer.map((card) => readDeferred(card, card.sessionId || sessionId)));
          // When switching sessions only cards with matching sessionId belong here;
          // /recent fallback may return cards from other sessions — filter them out.
          const myCards = sessionId ? resolved.filter((c) => c.sessionId === sessionId) : resolved;
          setCards(myCards);
          setError(null);
          setActiveId((prev) => (myCards.some((c) => c.id === prev) ? prev : myCards[myCards.length - 1]?.id ?? null));
        } catch (e) {
          setError(String(e?.message || e));
          setCards((prev) => prev ?? []);
        } finally {
          setBusy(false);
        }
      }, [sessionId, readDeferred]);

      useEffect(() => { load({ scan: true }); }, [load]);
      // Light poll: a card can be created while this view is already open.
      // Only the first load and an explicit refresh scan the workspace.
      useEffect(() => {
        const timer = setInterval(() => { load(); }, 3000);
        return () => clearInterval(timer);
      }, [load]);

      if (cards === null) {
        return h('div', {
          style: { padding: 20, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
        }, t('loading', 'Loading GeoJSON…'));
      }

      const list = cards;
      const active = list.find((c) => c.id === activeId) || list[list.length - 1];

      if (!list.length) {
        return h('div', {
          style: { padding: 24, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' },
        },
          h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 600 } },
            t('emptyTitle', 'No GeoJSON in this session yet')),
          h('div', {
            style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6, maxWidth: 560 },
          }, t('emptyHint', 'Present a .geojson file (or paste a GeoJSON FeatureCollection into a message) and it will show up here as an interactive map.')),
          error
            ? h('div', { style: { color: '#e5484d', fontSize: 12 } }, error)
            : null,
          h('button', {
            onClick: () => { load({ scan: true }); },
            disabled: busy,
            style: {
              padding: '4px 12px', borderRadius: 6, fontSize: 12,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            },
          }, t('refresh', 'Refresh')),
        );
      }

      return h('div', {
        style: {
          padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
          height: '100%', overflow: 'auto',
        },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
        },
          h('span', null, t('cardCount', '{n} GeoJSON source(s)').replace('{n}', list.length)),
          // GeoJSON source selector, immediately after the file count.
          h('select', {
            value: active?.id ?? '',
            onChange: (e) => setActiveId(e.target.value),
            'aria-label': t('selectSource', 'GeoJSON source'),
            title: t('selectSource', 'GeoJSON source'),
            style: { ...selectStyle(), fontSize: 12, maxWidth: 340 },
          },
            list.map((c) =>
              h('option', { key: c.id, value: c.id }, c.title || c.id),
            ),
          ),
          h('button', {
            onClick: () => { load({ scan: true }); },
            disabled: busy,
            title: 'Re-scan the workspace for GeoJSON files',
            style: {
              padding: '2px 8px', borderRadius: 5, fontSize: 11,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            },
          }, '⟳'),
          error ? h('span', { style: { color: '#e5484d' } }, error) : null,
        ),
        active
          ? h(MapCard, { key: active.id, card: active, t })
          : null,
        active && active.error
          ? h('div', { style: { color: '#e5484d', fontSize: 12 } }, active.error)
          : null,
      );
    }

    // ── Small SVG icons (artwork, own colors allowed) ─────────────────
    function MapIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true,
      },
        h('path', {
          d: 'M2 4.5 5.5 3l3 1.5L12 3l2 1.5v7L12 13l-3.5-1.5L5.5 13 2 11.5Z',
          fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('line', { x1: 5.5, y1: 3, x2: 5.5, y2: 13, stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 0.8, opacity: 0.5 }),
        h('line', { x1: 8.5, y1: 4.5, x2: 8.5, y2: 11.5, stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 0.8, opacity: 0.5 }),
      );
    }

    function TableIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true },
        h('rect', { x: 1, y: 2, width: 12, height: 10, rx: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1 }),
        h('line', { x1: 1, y1: 5.5, x2: 13, y2: 5.5, stroke: 'currentColor', strokeWidth: 0.8 }),
        h('line', { x1: 5, y1: 5.5, x2: 5, y2: 12, stroke: 'currentColor', strokeWidth: 0.8 }),
        h('line', { x1: 9, y1: 5.5, x2: 9, y2: 12, stroke: 'currentColor', strokeWidth: 0.8 }),
      );
    }

    function selectStyle() {
      return {
        padding: '3px 24px 3px 8px',
        borderRadius: 6,
        fontSize: 11,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        maxWidth: 220,
      };
    }

    function thStyle() {
      return {
        textAlign: 'left', padding: '6px 10px',
        borderBottom: '2px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)', fontWeight: 600,
        fontSize: 11, whiteSpace: 'nowrap',
        position: 'sticky', top: 0,
        background: 'var(--dsw-alias-bg-layer-2)',
      };
    }
    function tdStyle() {
      return {
        padding: '5px 10px',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
        fontSize: 11,
        maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      };
    }

    // ── Slot registrations ─────────────────────────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
        // 1) conversation.view entry — the GeoJSON viewer view.
        //    The Host half owns the per-session card registry; this view
        //    reads it over the Host's authenticated routes. The tab is
        //    always available and explains itself when the session has no
        //    GeoJSON yet.
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'dsh-geojson-map-viewer',
            order: 50,
            label: () => 'GeoJSON Map Viewer',
            // `inject` receives the bound session id for session-scoped slots
            // (same contract as the shipped Trajectory view). The view then
            // pulls `/api/geojson-viewer/list?sessionId=…` from the Host half.
            inject: (sessionId) => ({ sessionId }),
          }, (viewNode) => h(GeoJsonViewerView, { sessionId: viewNode?.sessionId })),
        );

        // 2) conversation.chat.assistant-actions — "View as Map" button
        //    on assistant messages that detected GeoJSON.
        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: 'dsh-geojson-map-viewer',
            order: 10,
            label: () => 'View as Map',
            inject: (sessionId) => ({ sessionId }),
          }, (actionOwner) => {
            const text = extractNodeText(actionOwner?.node || actionOwner);
            const hasGeoJson = text ? detectGeoJsonInText(text) : false;
            if (!hasGeoJson) return null;
            return h('button', {
              onClick: (e) => {
                e.stopPropagation();
                const card = buildCardFromText(text, actionOwner);
                if (!card) return;
                // Register the card on the host half so the viewer view can
                // pick it up, then dispatch a DOM event the host's overlay
                // listener catches.
                fetch('/api/geojson-viewer/open', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sessionId: actionOwner?.sessionId, card }),
                }).catch(() => {});
                window.dispatchEvent(new CustomEvent('geojson-viewer:open', {
                  detail: { sessionId: actionOwner?.sessionId, card },
                }));
              },
              style: {
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 8px', borderRadius: 5,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: 11, cursor: 'pointer',
              },
              title: 'View detected GeoJSON on a map',
            },
              MapIcon(),
              'View as Map',
            );
          }),
        );
      },
    };

    // ── Helpers ─────────────────────────────────────────────────────────
    function buildCardFromText(text, owner) {
      const found = extractFromText(text, { limit: 1 });
      const fc = found[0];
      if (!fc) return null;
      const inline = JSON.stringify(fc).length <= 512 * 1024;
      return {
        sessionId: owner?.sessionId,
        title: 'GeoJSON detected',
        source: 'assistant-message',
        description: `${fc.features.length} feature(s) in message.`,
        featureCount: fc.features.length,
        bounds: computeBounds(fc),
        payload: inline ? fc : null,
        tooLarge: !inline,
      };
    }

    // Embedded copies of the shared util functions (the client module table
    // cannot import the Host half's files — see geojson-util.js).
    function extractFromText(text, { limit = 1 } = {}) {
      if (typeof text !== 'string' || !text.length) return [];
      if (text.length > 10_000_000) text = text.slice(0, 10_000_000);
      const found = [];
      const seen = new Set();
      const GEO = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection', 'Feature', 'FeatureCollection']);
      const seedRe = /{\s*"[^"]*"\s*:/g;
      let m;
      while ((m = seedRe.exec(text)) !== null) {
        const start = m.index;
        const obj = readBalanced(text, start);
        if (!obj) continue;
        const fc = toFC(obj);
        if (!fc) continue;
        const key = `${fc.features.length}|${fc.features[0]?.geometry?.type || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(fc);
        if (found.length >= limit) break;
        seedRe.lastIndex = start + 2;
      }
      if (!found.length) {
        const t = text.trim();
        if (t.startsWith('{') || t.startsWith('[')) {
          try {
            const fc = toFC(JSON.parse(t));
            if (fc) found.push(fc);
          } catch { /* not whole-JSON */ }
        }
      }
      return found;

      function toFC(value) {
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
          if (v.type === 'Feature' && v.geometry && GEO.has(v.geometry.type)) {
            return { type: 'Feature', geometry: v.geometry, properties: v.properties && typeof v.properties === 'object' ? v.properties : {} };
          }
          if (GEO.has(v.type) && v.coordinates) {
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

    function extractNodeText(node) {
      if (!node) return null;
      // node may be a chat node with .message.content etc.
      const msg = node.message || node;
      const content = msg?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n');
      }
      return null;
    }

    function detectGeoJsonInText(text) {
      if (!text) return false;
      return /"type"\s*:\s*"(FeatureCollection|Feature|Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon|GeometryCollection)"/.test(text)
        || text.includes('"features":[') || text.includes('"features": [');
    }
  },
});
