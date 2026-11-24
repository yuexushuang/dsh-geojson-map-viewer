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
  id: '@yuexushuang/dsh-geojson-map-viewer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = React;

    // ── Locale ──────────────────────────────────────────────────────────
    // Visible strings go through the client locale service so the plugin
    // honors the active UI language. `apply()` registers this dictionary and
    // binds the namespace; every component then reads through `useT()` and is
    // re-rendered when the service publishes a new revision.
    //
    // Note: `window.__DSH_LOCALE__` is the native shell's async bootstrap
    // bridge (read/onChange), not the dictionary service — reading it here
    // always yielded `{}` and silently disabled every translation.
    const LOCALE_NS = 'geojsonViewer';
    const DICTIONARIES = {
      en: {
        viewTitle: 'GeoJSON Map Viewer',
        openButton: 'View as Map',
        openButtonHint: 'Register this message text as a card in the GeoJSON map viewer',
        openInMap: 'View as map',
        opened: 'Opened in map',
        added: 'Added to map',
        addedHint: 'This message is registered in the GeoJSON map viewer',
        addFailed: 'Add failed — retry',
        paneTitle: 'GeoJSON map',
        paneError: 'This map address is not valid.',
        paneEmpty: 'This card has no drawable GeoJSON.',
        loading: 'Loading…',
        loadFailed: 'Failed to load map library',
        featureCount: '{n} feature(s)',
        dataTable: 'View Data Table',
        rowsCount: '{n} rows',
        pageInfo: '{page} / {total}',
        firstPage: 'First page',
        prevPage: 'Previous page',
        nextPage: 'Next page',
        lastPage: 'Last page',
        pageSizeLabel: 'Rows/page',
        focusRowHint: 'Click to zoom to this feature',
        geometryType: 'Geometry',
        baseMap: 'Base map',
        selectSource: 'GeoJSON source',
        cardCount: '{n} GeoJSON source(s)',
        emptyTitle: 'No GeoJSON in this session yet',
        emptyHint: 'Present a .geojson file (or paste a GeoJSON FeatureCollection into a message) and it will show up here as an interactive map.',
        refresh: 'Refresh',
        layer_osm: 'OpenStreetMap',
        layer_arcgisImagery: 'ArcGIS Satellite',
      },
      zh: {
        viewTitle: 'GeoJSON 地图查看器',
        openButton: '地图查看',
        openButtonHint: '把这条消息中的 GeoJSON 注册为地图卡片',
        openInMap: '地图查看',
        opened: '已打开地图',
        added: '已添加到地图',
        addedHint: '这条消息已注册到 GeoJSON 地图查看器',
        addFailed: '添加失败，重试',
        paneTitle: 'GeoJSON 地图',
        paneError: '这个地图地址无效。',
        paneEmpty: '这张卡片没有可绘制的 GeoJSON。',
        loading: '正在加载…',
        loadFailed: '地图库加载失败',
        featureCount: '{n} 个要素',
        dataTable: '查看数据表',
        rowsCount: '共 {n} 行',
        pageInfo: '{page} / {total}',
        firstPage: '第一页',
        prevPage: '上一页',
        nextPage: '下一页',
        lastPage: '最后一页',
        pageSizeLabel: '每页',
        focusRowHint: '点击定位到该要素',
        geometryType: '几何类型',
        baseMap: '底图',
        selectSource: 'GeoJSON 来源',
        cardCount: '{n} 个 GeoJSON 来源',
        emptyTitle: '当前会话还没有 GeoJSON',
        emptyHint: '投递一个 .geojson 文件，或在消息里粘贴一段 GeoJSON FeatureCollection，这里就会出现交互式地图。',
        refresh: '刷新',
        layer_osm: 'OpenStreetMap 矢量',
        layer_arcgisImagery: 'ArcGIS 影像',
      },
    };

    /** The locale service, once `apply()` has run. */
    let localeRuntime = null;
    /** Bound translate function for {@link LOCALE_NS}. */
    let localeTranslate = null;

    /** Translate one key, using `fallback` when the namespace has no entry. */
    function translateOr(key, fallback) {
      if (!localeTranslate) return fallback;
      const value = localeTranslate(key);
      return value === key ? fallback : value;
    }

    function useT() {
      // The returned function reads the active locale at call time, so the
      // subscription only has to force a re-render on a published revision.
      const [, bump] = useState(0);
      useEffect(() => {
        if (!localeRuntime?.subscribe) return undefined;
        const off = localeRuntime.subscribe(() => bump((version) => version + 1));
        return typeof off === 'function' ? off : undefined;
      }, []);
      return useCallback((key, fallback) => translateOr(key, fallback), []);
    }

    // ── Leaflet loader ──────────────────────────────────────────────────
    // The host plugin streams the bundled Leaflet build, stylesheet, and
    // marker images from its own `vendor/` directory at
    // `/geojson-viewer-vendor/...`. The `/plugins` route only serves the
    // built client bundle and image assets, so the old
    // `plugins/@yuexushuang/dsh-geojson-map-viewer/leaflet.js` URLs always 404'd and
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
      // Feature layers in FeatureCollection order, so a table row can address
      // the exact Leaflet layer it describes.
      const featureLayersRef = useRef([]);
      const [baseKey, setBaseKey] = useState('arcgisImagery');
      const [showTable, setShowTable] = useState(false);
      const [leafletReady, setLeafletReady] = useState(false);
      const [error, setError] = useState(null);
      // Attribute-table paging and the row currently focused on the map.
      const [page, setPage] = useState(1);
      const [pageSize, setPageSize] = useState(25);
      const [activeRow, setActiveRow] = useState(null);

      const featureCollection = card.payload;

      // Flatten every feature's properties into one row schema. Rows keep their
      // FeatureCollection index (`__index`) so the table can zoom the map to
      // the matching layer; paging is applied when rendering, never here.
      const tableData = useMemo(() => {
        if (!featureCollection) return null;
        const columns = new Set();
        const rows = [];
        for (let index = 0; index < featureCollection.features.length; index += 1) {
          const feature = featureCollection.features[index];
          const props = (feature?.properties && typeof feature.properties === 'object') ? feature.properties : {};
          for (const key of Object.keys(props)) columns.add(key);
          const row = { __idx: index + 1, __index: index, __type: feature?.geometry?.type || '—' };
          for (const [key, value] of Object.entries(props)) row[key] = value;
          rows.push(row);
        }
        return { columns: [...columns], rows };
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
        // `onEachFeature` runs once per feature in collection order, so the
        // pushed layers stay index-aligned with the table rows.
        const layers = [];
        const layer = L.geoJSON(featureCollection, {
          pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
            radius: 6, fillColor: '#4285f4', fillOpacity: 0.8, color: '#fff', weight: 1,
          }),
          style: () => ({
            color: '#4285f4', weight: 2, fillColor: '#4285f4', fillOpacity: 0.15,
          }),
          onEachFeature: (feature, lyr) => {
            layers.push(lyr);
            const props = feature.properties || {};
            const lines = Object.entries(props).map(([k, v]) => `<b>${k}:</b> ${JSON.stringify(v)}`);
            lyr.bindPopup(lines.join('<br/>') || 'No attributes');
          },
        }).addTo(map);
        dataLayerRef.current = layer;
        featureLayersRef.current = layers;
        // A new payload starts a fresh page and clears the focused row.
        setActiveRow(null);
        setPage(1);
        if (card.bounds) {
          map.fitBounds([card.bounds.southWest, card.bounds.northEast], { padding: [20, 20] });
        }
      }, [leafletReady, layerKey]);

      // Keep the shown page inside the current range when the payload shrinks
      // or the page size changes.
      useEffect(() => { setPage(1); }, [layerKey, pageSize]);

      /** Zoom the map onto one table row's feature and open its popup. */
      const focusFeature = useCallback((row) => {
        const map = mapRef.current;
        const layer = featureLayersRef.current[row.__index];
        if (!map || !layer) return;
        setActiveRow(row.__index);
        try {
          if (typeof layer.getLatLng === 'function') {
            // Points have no meaningful extent: center them at a street-level zoom.
            map.setView(layer.getLatLng(), Math.max(map.getZoom(), 12), { animate: true });
          } else if (typeof layer.getBounds === 'function') {
            const bounds = layer.getBounds();
            if (bounds && bounds.isValid && bounds.isValid()) {
              map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
            }
          }
          if (typeof layer.bringToFront === 'function') layer.bringToFront();
        } catch { /* one malformed geometry must not break the table */ }
        if (typeof layer.openPopup === 'function') {
          try { layer.openPopup(); } catch { /* popup anchor unavailable */ }
        }
      }, []);

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
      // Paging window of the attribute table (all rows stay addressable by the
      // map, only the rendered slice changes).
      const allRows = tableData?.rows ?? [];
      const totalRows = allRows.length;
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      const currentPage = Math.min(page, totalPages);
      const pageRows = allRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

      return h('div', {
        className: 'gmv-card',
        style: {
          display: 'flex', flexDirection: 'column',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-layer-1)',
          // The card fills the conversation view instead of stopping at a
          // fixed reading width, so the map and the table get every pixel.
          width: '99%',
          maxWidth: 'none',
          margin: 0,
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
          // Tall enough to read a full-width map: grows with the window but
          // stays bounded so the table below never gets pushed off-screen.
          style: { position: 'relative', height: 'clamp(360px, 58vh, 560px)', background: '#0a0a0a' },
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
        // Attribute table: paged rows; clicking a row zooms the map to that
        // feature and opens its popup.
        showTable && tableData
          ? h('div', {
              style: {
                background: 'var(--dsw-alias-bg-base)',
              },
            },
              // Pager bar
              h('div', {
                style: {
                  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  color: 'var(--dsw-alias-label-secondary)', fontSize: 11,
                },
              },
                h('span', null, t('rowsCount', '{n} rows').replace('{n}', totalRows)),
                h('button', {
                  type: 'button', disabled: currentPage <= 1,
                  onClick: () => setPage(1), title: t('firstPage', 'First page'),
                  style: pagerStyle(currentPage <= 1),
                }, '«'),
                h('button', {
                  type: 'button', disabled: currentPage <= 1,
                  onClick: () => setPage(currentPage - 1), title: t('prevPage', 'Previous page'),
                  style: pagerStyle(currentPage <= 1),
                }, '‹'),
                h('span', { style: { fontVariantNumeric: 'tabular-nums' } },
                  t('pageInfo', '{page} / {total}')
                    .replace('{page}', currentPage)
                    .replace('{total}', totalPages)),
                h('button', {
                  type: 'button', disabled: currentPage >= totalPages,
                  onClick: () => setPage(currentPage + 1), title: t('nextPage', 'Next page'),
                  style: pagerStyle(currentPage >= totalPages),
                }, '›'),
                h('button', {
                  type: 'button', disabled: currentPage >= totalPages,
                  onClick: () => setPage(totalPages), title: t('lastPage', 'Last page'),
                  style: pagerStyle(currentPage >= totalPages),
                }, '»'),
                h('label', {
                  style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 },
                },
                  h('span', null, t('pageSizeLabel', 'Rows/page')),
                  h('select', {
                    value: pageSize,
                    onChange: (e) => setPageSize(Number(e.target.value) || 25),
                    'aria-label': t('pageSizeLabel', 'Rows/page'),
                    style: { ...selectStyle(), maxWidth: 80 },
                  },
                    [10, 25, 50, 100].map((size) => h('option', { key: size, value: size }, String(size))),
                  ),
                ),
              ),
              h('div', {
                style: {
                  maxHeight: 320, overflow: 'auto',
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
                    pageRows.map((row) => {
                      const focused = activeRow === row.__index;
                      return h('tr', {
                        key: row.__index,
                        onClick: () => focusFeature(row),
                        title: t('focusRowHint', 'Click to zoom to this feature'),
                        style: {
                          cursor: 'pointer',
                          borderBottom: '1px solid var(--dsw-alias-border-l1)',
                          background: focused
                            ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)'
                            : row.__index % 2
                              ? 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 40%, transparent)'
                              : 'transparent',
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
                      );
                    }),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    /** Small pager button styling shared by the four page controls. */
    function pagerStyle(disabled) {
      return {
        minWidth: 22, height: 20, padding: '0 6px',
        borderRadius: 4,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12, lineHeight: '18px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      };
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
          // The card keeps the view's width minus this gutter; the toolbar sits
          // inside the same gutter, so both line up.
          padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12,
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

    function CheckIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true },
        h('path', {
          d: 'M2.5 7.5 5.5 10.5 11.5 4',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    // ── Map surfaces ───────────────────────────────────────────────────
    // One registration path feeds three entry points — the assistant message
    // action strip, a JSON/GeoJSON code fence, and a delivered file card — and
    // every one of them shows the resulting map in the right Sidebar, which is
    // the supported "open a map now" surface for a plugin (the main View tabs
    // expose no programmatic selection API).

    /** Right-Sidebar tab type this plugin owns. */
    const PANE_KIND = 'geojson-map';
    const PANE_TAB_ID = 'dsh-geojson-map-viewer';
    const PANE_PREFIX = `dsh-resource://${PANE_KIND}/`;

    /** Plugin context captured in `apply()`, for services the components reach lazily. */
    let pluginContext = null;

    /** Build the address that carries one card into the map pane. */
    function paneAddress(sessionId, cardId) {
      return `${PANE_PREFIX}${encodeURIComponent(String(sessionId ?? ''))}/${encodeURIComponent(String(cardId ?? ''))}`;
    }

    /** @returns the `{ sessionId, cardId }` a pane address names, or null. */
    function parsePaneAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(PANE_PREFIX)) return null;
      const parts = address.slice(PANE_PREFIX.length).split('/');
      if (parts.length < 2) return null;
      try {
        return { sessionId: decodeURIComponent(parts[0]), cardId: decodeURIComponent(parts[1]) };
      } catch {
        return null;
      }
    }

    /** FNV-1a fingerprint: a stable identity for content-addressed fence cards. */
    function fingerprint(text) {
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }

    /** Register one card on the Host; resolves to the stored record. */
    async function registerCardOnHost(sessionId, card) {
      const response = await fetch('/api/geojson-viewer/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, card }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json().catch(() => null);
      return body?.card ?? null;
    }

    /** Show a registered card in the right Sidebar; false when that surface is absent. */
    function openCardPane(sessionId, cardId) {
      const sidebar = pluginContext?.get?.('sidebarRight');
      if (!sidebar?.openResource || !sessionId || !cardId) return false;
      try {
        sidebar.openResource(paneAddress(sessionId, cardId), { destination: 'sidebar' });
        return true;
      } catch {
        return false;
      }
    }

    /** A one-shot status that returns to `idle`, so the control stays clickable. */
    function useTransientPhase(resetMs = 2200) {
      const [phase, setPhase] = useState('idle');
      const timer = useRef(null);
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
      const settle = useCallback((next) => {
        setPhase(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setPhase('idle'), resetMs);
      }, [resetMs]);
      return [phase, setPhase, settle];
    }

    /** Register a card built from plain text and reveal it; reports how far it got. */
    function showTextCard(sessionId, text, identity) {
      const card = buildCardFromText(text, { sessionId, ...identity });
      if (!card) return Promise.resolve('stored');
      return registerCardOnHost(sessionId, card).then((record) => {
        if (!record?.id) return 'stored';
        return openCardPane(sessionId, record.id) ? 'opened' : 'stored';
      });
    }

    // ── Assistant-message "View as Map" action ─────────────────────────
    // The slot only hands over the durable `messageId`; there is no node or
    // body text in the owner props. The body is therefore read back from the
    // Chat target snapshot, which is what makes "the button appears only when
    // the message text contains GeoJSON" possible at all.

    /** Never-published source: keeps the Hook seat stable when no session is bound. */
    const ABSENT_CHAT = {
      getSnapshot: () => undefined,
      subscribe: () => () => {},
    };

    // One scan of the transcript per published snapshot, shared by every
    // mounted action button. The Chat snapshot object is immutable and
    // replaced on change, so a WeakMap is the natural cache axis and does not
    // leak when a session closes.
    const messageTextsCache = new WeakMap();

    /** @returns Map<messageId, assistant text> for one Chat snapshot. */
    function messageTextsOf(snapshot) {
      if (!snapshot) return new Map();
      const cached = messageTextsCache.get(snapshot);
      if (cached) return cached;
      const texts = new Map();
      for (const node of snapshot.nodes?.values?.() ?? []) {
        if (!node || node.kind !== 'assistant-step') continue;
        const messageId = node.data?.finalNode?.messageId;
        if (typeof messageId !== 'string' || messageId === '') continue;
        const text = assistantTextOf(node.data?.blocks);
        if (text) texts.set(messageId, text);
      }
      messageTextsCache.set(snapshot, texts);
      return texts;
    }

    /** Concatenate the text blocks of a finalized assistant message. */
    function assistantTextOf(blocks) {
      if (!Array.isArray(blocks)) return '';
      const parts = [];
      for (const block of blocks) {
        if (block && block.kind === 'text' && typeof block.text === 'string' && block.text !== '') {
          parts.push(block.text);
        }
      }
      return parts.join('\n');
    }

    /**
     * One per-message action. Rendered only for a finalized assistant message
     * whose body contains GeoJSON; clicking registers that exact text as a
     * card and opens the map pane. The control never latches: it confirms for
     * a moment and then invites another click (which re-opens the same card).
     */
    function ViewAsMapAction({ messageId, sessionId, useChat }) {
      // The plugin's own dictionary hook, like every other label in this
      // module (the entry does not declare a slot `locale` seat).
      const t = useT();
      // Hook order is unconditional: read the body first, decide afterwards.
      const text = useChat((snapshot) => messageTextsOf(snapshot).get(messageId) ?? '');
      const [phase, setPhase, settle] = useTransientPhase();
      if (!detectGeoJsonInText(text)) return null;

      const open = () => {
        if (phase === 'busy') return;
        setPhase('busy');
        showTextCard(sessionId, text, { messageId })
          .then(settle)
          .catch(() => settle('error'));
      };

      const label = phase === 'opened'
        ? t('opened', 'Opened in map')
        : phase === 'stored'
          ? t('added', 'Added to map')
          : phase === 'error'
            ? t('addFailed', 'Add failed — retry')
            : t('openButton', 'View as Map');

      return h('button', {
        type: 'button',
        onClick: open,
        disabled: phase === 'busy',
        title: t('openButtonHint', 'Register this message text as a card in the GeoJSON map viewer'),
        'aria-label': label,
        style: stripActionStyle(phase),
      },
        phase === 'idle' || phase === 'error' ? MapIcon() : CheckIcon(),
        h('span', null, label),
      );
    }

    /** Shared styling for the inline "map" chip used by the action strip and fences. */
    function stripActionStyle(phase) {
      return {
        display: 'inline-flex', alignItems: 'center', gap: 4,
        height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
        padding: '0 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        color: phase === 'error'
          ? 'var(--dsw-alias-label-error, #e5484d)'
          : phase === 'idle'
            ? 'var(--dsw-alias-label-tertiary)'
            : 'var(--dsw-alias-brand-primary)',
        font: 'inherit',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        cursor: phase === 'busy' ? 'default' : 'pointer',
        opacity: phase === 'busy' ? 0.6 : 1,
        whiteSpace: 'nowrap',
      };
    }

    // ── JSON / GeoJSON code-fence layer ────────────────────────────────
    /**
     * Markdown fence layer keyed by language: a code block whose body really is
     * GeoJSON gets a "地图查看" chip at its top-right corner. The default code
     * block renders unchanged underneath (`children`), so a non-GeoJSON block
     * is untouched.
     */
    function GeoJsonFenceLayer({ code, streaming, children, sessionId }) {
      const t = useT();
      const [phase, setPhase, settle] = useTransientPhase();
      const active = !streaming && typeof code === 'string' && detectGeoJsonInText(code);
      if (!active) return children;
      const open = () => {
        if (phase === 'busy') return;
        setPhase('busy');
        showTextCard(sessionId, code, { contentKey: `code:${fingerprint(code)}` })
          .then(settle)
          .catch(() => settle('error'));
      };
      const label = phase === 'opened'
        ? t('opened', 'Opened in map')
        : phase === 'stored'
          ? t('added', 'Added to map')
          : phase === 'error'
            ? t('addFailed', 'Add failed — retry')
            : t('openInMap', 'View as map');
      return h('div', { style: { position: 'relative' } },
        // The chip sits in its own row above the block rather than over the
        // code: the shipped code block keeps its own top-right controls, and
        // an overlay would cover them.
        h('div', {
          style: {
            display: 'flex', justifyContent: 'flex-end',
            marginBottom: 4, pointerEvents: 'none',
          },
        },
          h('button', {
            type: 'button',
            onClick: open,
            disabled: phase === 'busy',
            title: t('openButtonHint', 'Register this code block as a card in the GeoJSON map viewer'),
            style: {
              ...stripActionStyle(phase),
              height: 22,
              padding: '0 8px',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              pointerEvents: 'auto',
            },
          },
            MapIcon(),
            h('span', null, label),
          ),
        ),
        children,
      );
    }

    // ── Delivered-file card action ─────────────────────────────────────
    /** Read the presented-file coordinates out of a delivery card's action URL. */
    function presentedTarget(actionUrl) {
      try {
        const url = new URL(String(actionUrl), 'http://localhost');
        const seq = Number(url.searchParams.get('seq'));
        const index = Number(url.searchParams.get('index'));
        if (!Number.isFinite(seq) || !Number.isFinite(index)) return null;
        return { seq, index, sessionId: url.searchParams.get('sessionId') };
      } catch {
        return null;
      }
    }

    /**
     * One delivery card action: ask the Host for the card that belongs to the
     * presented file this card shows, then open it in the map pane.
     */
    function FileMapAction({ actionUrl, sessionId }) {
      const t = useT();
      const [phase, setPhase, settle] = useTransientPhase();
      const open = () => {
        if (phase === 'busy') return;
        const target = presentedTarget(actionUrl);
        if (!target) {
          settle('error');
          return;
        }
        setPhase('busy');
        fetch('/api/geojson-viewer/presented', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionId ?? target.sessionId,
            seq: target.seq,
            index: target.index,
          }),
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((body) => {
            const record = body?.card;
            if (!record?.id) return 'stored';
            return openCardPane(sessionId ?? target.sessionId, record.id) ? 'opened' : 'stored';
          })
          .then(settle)
          .catch(() => settle('error'));
      };
      const label = phase === 'opened'
        ? t('opened', 'Opened in map')
        : phase === 'stored'
          ? t('added', 'Added to map')
          : phase === 'error'
            ? t('addFailed', 'Add failed — retry')
            : t('openInMap', 'View as map');
      return h('button', {
        type: 'button',
        onClick: open,
        disabled: phase === 'busy',
        title: label,
        'aria-label': label,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          height: 24, padding: '0 6px',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 'var(--dsw-radius-sm, 6px)',
          background: 'transparent',
          color: phase === 'idle' ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-brand-primary)',
          fontSize: 11, cursor: 'pointer',
        },
      },
        MapIcon(),
        phase === 'idle' ? null : h('span', null, label),
      );
    }

    // ── Right-Sidebar map pane ─────────────────────────────────────────
    /**
     * Body of the `geojson-map` tab type: resolve the card named by the tab's
     * address and draw it with the same MapCard the GeoJSON view uses.
     */
    function GeoJsonMapPane({ useTabInfo }) {
      const t = useT();
      const info = useTabInfo?.();
      const address = info?.tab?.navigation?.address;
      const [card, setCard] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);

      useEffect(() => {
        let alive = true;
        const target = parsePaneAddress(address);
        setLoading(true);
        setError(null);
        setCard(null);
        if (!target) {
          setLoading(false);
          setError('invalid');
          return () => { alive = false; };
        }
        fetch(`/api/geojson-viewer/read?sessionId=${encodeURIComponent(target.sessionId)}&cardId=${encodeURIComponent(target.cardId)}`)
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((data) => {
            if (!alive) return;
            setLoading(false);
            if (!data?.payload) {
              setError(data?.error || 'empty');
              return;
            }
            setCard({
              id: target.cardId,
              title: t('paneTitle', 'GeoJSON map'),
              payload: data.payload,
              bounds: data.bounds ?? null,
              featureCount: data.featureCount ?? null,
            });
          })
          .catch((cause) => {
            if (!alive) return;
            setLoading(false);
            setError(String(cause?.message || cause));
          });
        return () => { alive = false; };
      }, [address]);

      const hint = (text) => h('div', {
        style: { padding: 16, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      }, text);

      if (loading) return hint(t('loading', 'Loading…'));
      if (error) {
        return hint(error === 'invalid'
          ? t('paneError', 'This map address is not valid.')
          : error === 'empty'
            ? t('paneEmpty', 'This card has no drawable GeoJSON.')
            : `${t('loadFailed', 'Failed to load map library')}: ${error}`);
      }
      if (!card) return null;
      return h('div', {
        style: { padding: 12, height: '100%', overflow: 'auto' },
      }, h(MapCard, { card, t }));
    }

    // ── Slot registrations ─────────────────────────────────────────────
    return {
      inject: ['slots', 'uiConversation', 'locale'],
      apply(ctx) {
        pluginContext = ctx;
        // Register the plugin's own dictionary and bind it for `useT()`.
        // Registering here (not in the module scope) keeps the effect owned
        // by this plugin's fiber, so disabling the plugin drops its copy.
        ctx.effect(
          () => ctx.locale.register(LOCALE_NS, DICTIONARIES),
          'geojson-viewer: dictionaries',
        );
        localeRuntime = ctx.locale;
        localeTranslate = ctx.locale.bind(LOCALE_NS);

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
            label: () => translateOr('viewTitle', 'GeoJSON Map Viewer'),
            // `inject` receives the bound session id for session-scoped slots
            // (same contract as the shipped Trajectory view). The view then
            // pulls `/api/geojson-viewer/list?sessionId=…` from the Host half.
            inject: (sessionId) => ({ sessionId }),
          }, (viewNode) => h(GeoJsonViewerView, { sessionId: viewNode?.sessionId })),
        );

        // 2) conversation.chat.assistant-actions — the "View as Map" action
        //    on the finalized assistant message. The slot hands over only the
        //    durable `messageId` (no body text), so the message body is read
        //    from the Chat target snapshot and the action renders nothing
        //    unless that body actually carries GeoJSON.
        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: 'dsh-geojson-map-viewer',
            order: 20,
            label: () => 'View as Map',
            inject: (sessionId) => {
              // `binding` throws for a session that is not currently bound;
              // the entry then has no text to inspect and stays hidden.
              let chat = ABSENT_CHAT;
              try {
                chat = ctx.uiConversation.binding(sessionId).target('chat');
              } catch { /* session binding unavailable — keep the action hidden */ }
              return { sessionId, hooks: { chat } };
            },
          }, ViewAsMapAction),
        );

        // 3) Markdown fence layers — the "地图查看" chip on a JSON/GeoJSON
        //    code block. Registering a key replaces only that language's
        //    layer; the layer renders the default code block itself.
        for (const lang of ['json', 'geojson']) {
          ctx.slots.inject('conversation.chat.markdown.fence', () =>
            ctx.slots.register({
              name: 'conversation.chat.markdown.fence',
              key: lang,
              id: `dsh-geojson-map-viewer/fence/${lang}`,
              inject: (sessionId) => ({ sessionId }),
            }, GeoJsonFenceLayer),
          );
        }

        // 4) Delivery card action — the same chip on a presented `.geojson`
        //    card. The card hands over an action URL that carries the
        //    presented-file coordinates; the Host resolves it to a card.
        ctx.slots.inject('deliverables.file.actions', () =>
          ctx.slots.register({
            name: 'deliverables.file.actions',
            id: 'dsh-geojson-map-viewer',
            order: 30,
            inject: (sessionId) => ({ sessionId }),
          }, FileMapAction),
        );

        // 5) Right-Sidebar map pane. Registered only while the Sidebar's two
        //    services exist: a profile without the right Sidebar keeps every
        //    other surface working and simply cannot open the pane.
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id: PANE_TAB_ID,
            kind: PANE_KIND,
            patterns: [`${PANE_PREFIX}**`],
            priority: 'extension',
            title: () => translateOr('paneTitle', 'GeoJSON map'),
            canOpen: (address) => parsePaneAddress(address) !== null,
          }), 'geojson-viewer: map pane tab type');
          scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: PANE_TAB_ID,
          }, GeoJsonMapPane));
        });
      },
    };

    // ── Helpers ─────────────────────────────────────────────────────────
    /**
     * Turn a text body into the card payload the Host registry accepts.
     * `messageId` (a message) or `contentKey` (a code fence) supplies a stable
     * identity, so repeated clicks and the Host's automatic scan of the same
     * source resolve to one card instead of stacking duplicates.
     */
    function buildCardFromText(text, { sessionId, messageId, contentKey, source = 'assistant-message' } = {}) {
      const found = extractFromText(text, { limit: 1 });
      const fc = found[0];
      if (!fc) return null;
      const inline = JSON.stringify(fc).length <= 512 * 1024;
      const dedupeKey = typeof messageId === 'string' && messageId !== ''
        // Must match the Host's key for the first FeatureCollection of this
        // message (`msg:<messageId>:<index>`, see index.js scanText).
        ? `msg:${messageId}:0`
        : typeof contentKey === 'string' && contentKey !== '' ? contentKey : null;
      return {
        sessionId,
        title: 'GeoJSON detected',
        source,
        description: `${fc.features.length} feature(s) in message.`,
        featureCount: fc.features.length,
        bounds: computeBounds(fc),
        payload: inline ? fc : null,
        tooLarge: !inline,
        dedupeKey,
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

    function detectGeoJsonInText(text) {
      if (!text) return false;
      return /"type"\s*:\s*"(FeatureCollection|Feature|Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon|GeometryCollection)"/.test(text)
        || text.includes('"features":[') || text.includes('"features": [');
    }
  },
});
