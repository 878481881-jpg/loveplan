// LovePlan Travel Core App Engine (Map, GeoJSON Simplification, ThumbCacheDB, Paginated Wall, Compressed Upload + EXIF, Modals, ETag/409 Sync)
(function(global) {
    'use strict';

    // =========================================================================
    // 1. 常驻地配置（可自定义持久化）
    // =========================================================================
    const DEFAULT_HOME_BASES = {
        heng: { name: "哼哼", city: "福建省永安市", shortCity: "永安", lat: 25.9414, lng: 117.3651 },
        qin:  { name: "亲亲", city: "广东省东莞市", shortCity: "东莞", lat: 23.0207, lng: 113.7518 }
    };
    const HOME_BASES_KEY = 'loveGacha_homeBases_v1';
    let HOME_BASES = loadHomeBases();

    function loadHomeBases() {
        try {
            const raw = localStorage.getItem(HOME_BASES_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.heng && parsed.qin && parsed.heng.lat && parsed.qin.lat) {
                    return parsed;
                }
            }
        } catch (e) {}
        return JSON.parse(JSON.stringify(DEFAULT_HOME_BASES));
    }

    // =========================================================================
    // 2. IndexedDB GeoJSON 持久缓存（含客户端 Douglas-Peucker 顶点抽稀，渲染提速 3x）
    // =========================================================================
    const GeoCacheDB = (() => {
        const DB_NAME = 'LovePlanGeoCache_v2';
        const STORE = 'geojson';
        let dbPromise = null;

        function open() {
            if (dbPromise) return dbPromise;
            dbPromise = new Promise((resolve) => {
                if (!window.indexedDB) return resolve(null);
                try {
                    const req = indexedDB.open(DB_NAME, 1);
                    req.onupgradeneeded = (e) => {
                        const db = e.target.result;
                        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
                    };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => resolve(null);
                } catch (e) { resolve(null); }
            });
            return dbPromise;
        }

        async function get(key) {
            const db = await open();
            if (!db) return null;
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(STORE, 'readonly');
                    const req = tx.objectStore(STORE).get(key);
                    req.onsuccess = () => resolve(req.result || null);
                    req.onerror = () => resolve(null);
                } catch (e) { resolve(null); }
            });
        }

        async function set(key, value) {
            const db = await open();
            if (!db) return;
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(STORE, 'readwrite');
                    tx.objectStore(STORE).put(value, key);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => resolve();
                } catch (e) { resolve(); }
            });
        }

        async function clear() {
            const db = await open();
            if (!db) return;
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(STORE, 'readwrite');
                    tx.objectStore(STORE).clear();
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => resolve();
                } catch (e) { resolve(); }
            });
        }

        return { get, set, clear };
    })();

    function simplifyRing(ring, tol) {
        if (!Array.isArray(ring) || ring.length <= 6) return ring;
        const sqTol = tol * tol;
        function sqSegDist(p, a, b) {
            let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
            if (dx !== 0 || dy !== 0) {
                const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
                if (t > 1) { x = b[0]; y = b[1]; }
                else if (t > 0) { x += dx * t; y += dy * t; }
            }
            dx = p[0] - x; dy = p[1] - y;
            return dx * dx + dy * dy;
        }
        const last = ring.length - 1;
        const keep = new Uint8Array(ring.length);
        keep[0] = 1; keep[last] = 1;
        const stack = [[0, last]];
        while (stack.length) {
            const [first, end] = stack.pop();
            let maxDist = sqTol, idx = -1;
            for (let i = first + 1; i < end; i++) {
                const d = sqSegDist(ring[i], ring[first], ring[end]);
                if (d > maxDist) { idx = i; maxDist = d; }
            }
            if (idx !== -1) {
                keep[idx] = 1;
                stack.push([first, idx], [idx, end]);
            }
        }
        const out = [];
        for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);
        return out.length >= 4 ? out : ring;
    }

    function simplifyGeoJSON(geo, tol = 0.018) {
        if (!geo || !Array.isArray(geo.features)) return geo;
        return {
            type: 'FeatureCollection',
            features: geo.features.map(f => {
                if (!f.geometry || !f.geometry.coordinates) return f;
                const g = f.geometry;
                let coords = g.coordinates;
                if (g.type === 'Polygon') {
                    coords = coords.map(r => simplifyRing(r, tol));
                } else if (g.type === 'MultiPolygon') {
                    coords = coords.map(poly => poly.map(r => simplifyRing(r, tol)));
                }
                return {
                    type: 'Feature',
                    properties: { name: f.properties && f.properties.name, adcode: f.properties && f.properties.adcode },
                    geometry: { type: g.type, coordinates: coords }
                };
            })
        };
    }

    // =========================================================================
    // 3. ThumbCacheDB：内存级缩略图 Blob URL 复用池（避免地图缩放/回放重复解密）
    // =========================================================================
    const ThumbCacheDB = (() => {
        const cache = new Map();
        const inflight = new Map();

        function peek(url) {
            return url ? (cache.get(url) || '') : '';
        }

        async function resolveUrl(url) {
            if (!url) return '';
            if (url.startsWith('blob:') || url.startsWith('data:')) return url;
            if (cache.has(url)) return cache.get(url);
            if (inflight.has(url)) return inflight.get(url);

            const p = fetch(url)
                .then(r => r.ok ? r.blob() : null)
                .then(blob => {
                    if (!blob) return url;
                    const objUrl = URL.createObjectURL(blob);
                    cache.set(url, objUrl);
                    return objUrl;
                })
                .catch(() => url)
                .finally(() => inflight.delete(url));
            inflight.set(url, p);
            return p;
        }

        return { peek, resolveUrl };
    })();

    // =========================================================================
    // 4. GitHub 存储配置 & 状态变量
    // =========================================================================
    const GITHUB_TOKEN = localStorage.getItem('loveGacha_githubToken');
    const myIdentity = localStorage.getItem('loveGacha_myIdentity') || '游客';
    const OWNER_REPO = '878481881-jpg/loveplan';
    const FILE_TRAVEL = 'data/Travel.json';
    const TRAVEL_CACHE_KEY = 'loveGacha_travelCache_v1';
    const TRAVEL_ETAG_KEY = 'loveGacha_travelEtag_v1';
    const SHARED_TRIPS_KEY = 'loveGacha_sharedTrips_v1';
    const UPLOAD_DRAFT_KEY = 'loveGacha_travelDraft_v1';

    let travelData = { posts: [] };
    let travelSha = null;
    let travelEtag = localStorage.getItem(TRAVEL_ETAG_KEY) || null;
    let dataVersion = 0;
    let pollInterval = null;
    let isLikingSyncing = false;
    let toastTimer = null;

    const TAG_OPTIONS = [
        { key: '美食', icon: '🍜' },
        { key: '拍照', icon: '📸' },
        { key: '住宿', icon: '🏨' },
        { key: '风景', icon: '🌄' },
        { key: '踩雷', icon: '⚡' },
        { key: '二刷', icon: '💖' }
    ];

    function getPostImages(post) {
        if (!post) return [];
        if (Array.isArray(post.images) && post.images.length > 0) return post.images;
        if (post.url || post.thumbUrl) return [{ url: post.url || post.thumbUrl, thumbUrl: post.thumbUrl || post.url }];
        return [];
    }

    function getSharedTripKeys() {
        try { return new Set(JSON.parse(localStorage.getItem(SHARED_TRIPS_KEY) || '[]')); }
        catch (e) { return new Set(); }
    }

    function toggleTripShared(tripKey, event) {
        if (event) event.stopPropagation();
        const set = getSharedTripKeys();
        if (set.has(tripKey)) set.delete(tripKey);
        else set.add(tripKey);
        localStorage.setItem(SHARED_TRIPS_KEY, JSON.stringify(Array.from(set)));
        updateDistanceUI();
        renderRouteLines();
        showToast(set.has(tripKey) ? "已标记为共同出发，不计入双向奔赴里程 🤝" : "已恢复双向奔赴里程统计 ✈️");
    }

    let currentProvinceFilter = '全部';
    let currentWallTagFilter = '全部';
    let currentAlbumTagFilter = '全部';
    let currentAlbumCluster = null;
    let currentDistYear = 'ALL';
    let visitedOnlyLit = false;

    let wallFilteredList = [];
    let wallRenderedCount = 0;
    const WALL_PAGE_SIZE = 14;
    let wallObserver = null;

    let selectedUploadImages = [];
    let selectedUploadTags = [];
    let viewerImages = [];
    let viewerIndex = 0;
    let viewerCaptionHidden = false;

    let map = null;
    let canvasRenderer = null;
    let provinceGeoLayer = null;
    let cityGeoLayerGroup = null;
    let labelLayerGroup = null;
    let routeLayerGroup = null;
    let replayLayerGroup = null;
    let markerLayerGroup = null;

    let currentLabelMode = localStorage.getItem('loveGacha_mapLabelMode') || 'province';
    let isRouteVisible = localStorage.getItem('loveGacha_mapRouteVisible') === 'true';
    let isRoundTripMode = localStorage.getItem('loveGacha_distRoundTrip') === 'true';
    let showCityBounds = true;
    let loadedProvinceCityGeo = {};
    let loadingProvinceCityGeo = {};
    let lastDistanceSummary = { hengTotal: 0, qinTotal: 0, trips: [] };
    let lastMarkerRenderKey = '';

    let extrasLoadPromise = null;
    function ensureExtrasLoaded() {
        if (global.__TRAVEL_EXTRAS_LOADED__) return Promise.resolve();
        if (extrasLoadPromise) return extrasLoadPromise;
        extrasLoadPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'travel-extras.js';
            s.onload = () => resolve();
            s.onerror = () => { extrasLoadPromise = null; reject(new Error('extras load failed')); };
            document.head.appendChild(s);
        });
        return extrasLoadPromise;
    }

    async function launchFootprintReplay() {
        closeMapToolsMenu();
        try {
            if (!global.__TRAVEL_EXTRAS_LOADED__) showToast("正在加载时光回放引擎...");
            await ensureExtrasLoaded();
            global.startFootprintReplay('ALL');
        } catch (e) {
            showToast("时光回放模块加载失败，请刷新重试");
        }
    }

    async function launchAnnualReportModal() {
        try {
            if (!global.__TRAVEL_EXTRAS_LOADED__) showToast("正在加载年度海报模块...");
            await ensureExtrasLoaded();
            global.openAnnualReportModal();
        } catch (e) {
            showToast("年度海报模块加载失败，请刷新重试");
        }
    }

    // =========================================================================
    // 5. 极速初始化入口
    // =========================================================================
    let chinaGeoPreloadPromise = null;

    function scheduleIdle(fn, delay = 350) {
        if (window.requestIdleCallback) requestIdleCallback(() => fn(), { timeout: delay + 400 });
        else setTimeout(fn, delay);
    }

    document.addEventListener('DOMContentLoaded', async function() {
        document.getElementById('uploaderText').innerText = myIdentity;
        document.getElementById('uploaderEmoji').innerText = myIdentity.includes('亲') ? '👦' : '👦';
        if (window.ALL_CITIES_FLAT) {
            document.getElementById('statTotalCityLabel').innerText = '/' + ALL_CITIES_FLAT.length;
        }

        initProvinceCitySelects();
        renderUploadTagsUI();
        initWallTagFilterBarOnce();
        restoreUploadDraft();
        updateHomeBaseLabels();
        updateLabelModeButtons();
        updateRouteButtonUI();

        document.addEventListener('click', () => closeMapToolsMenu());

        try {
            const cachedStr = localStorage.getItem(TRAVEL_CACHE_KEY);
            if (cachedStr) {
                const parsed = JSON.parse(cachedStr);
                if (parsed && Array.isArray(parsed.posts)) {
                    travelData = parsed;
                    dataVersion++;
                    updateStatsAndChips();
                }
            }
        } catch (e) {}

        const initialTab = getInitialTabFromUrl();
        if (initialTab !== 'map') switchMainTab(initialTab, false);

        if (!GITHUB_TOKEN) {
            showToast("未检测到Token，仅支持预览模式 💡");
        }

        chinaGeoPreloadPromise = fetchGeoJSONWithCache(
            'china_100000_lite',
            'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json',
            0.022
        );
        const dataPromise = fetchTravelData();
        await ensureLeafletLoaded();
        initChinaMap();

        if (travelData.posts && travelData.posts.length > 0) {
            renderApplePhotoMarkers(true);
            renderRouteLines();
            scheduleIdle(() => loadVisitedProvincesCityGeo(), 350);
        }

        const updated = await dataPromise;
        if (updated) {
            refreshAllViews();
            scheduleIdle(() => loadVisitedProvincesCityGeo(), 200);
        }
        startPolling();
    });

    function getInitialTabFromUrl() {
        const params = new URLSearchParams(location.search);
        const q = params.get('tab') || location.hash.replace('#', '');
        return ['map', 'wall', 'upload'].includes(q) ? q : 'map';
    }

    function ensureLeafletLoaded() {
        return new Promise((resolve) => {
            if (window.L) return resolve();
            let tries = 0, injectedUnpkg = false;
            const timer = setInterval(() => {
                tries++;
                if (window.L) { clearInterval(timer); return resolve(); }
                if (tries === 35 && !injectedUnpkg) {
                    injectedUnpkg = true;
                    const s = document.createElement('script');
                    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.min.js';
                    document.head.appendChild(s);
                } else if (tries > 120) {
                    clearInterval(timer);
                    resolve();
                }
            }, 50);
        });
    }

    function updateHomeBaseLabels() {
        const hEl = document.getElementById('statHengCityLabel');
        const qEl = document.getElementById('statQinCityLabel');
        if (hEl) hEl.innerText = HOME_BASES.heng.shortCity;
        if (qEl) qEl.innerText = HOME_BASES.qin.shortCity;
    }

    // =========================================================================
    // 6. 矢量中国地图引擎
    // =========================================================================
    function initChinaMap() {
        if (!window.L) {
            document.getElementById('mapLoadingText').innerText = "地图组件加载失败，请刷新重试";
            return;
        }

        canvasRenderer = L.canvas({ padding: 0.5, tolerance: 2 });
        map = L.map('chinaMap', {
            renderer: canvasRenderer,
            preferCanvas: true,
            zoomSnap: 0.1,
            zoomDelta: 0.5,
            minZoom: 2.8,
            maxZoom: 12,
            zoomControl: false,
            attributionControl: false,
            tap: false,
            touchZoom: true,
            bounceAtZoomLimits: false
        });

        cityGeoLayerGroup = L.layerGroup().addTo(map);
        routeLayerGroup = L.layerGroup().addTo(map);
        labelLayerGroup = L.layerGroup().addTo(map);
        markerLayerGroup = L.layerGroup().addTo(map);

        fitChinaBoundsOnMobile(false);

        const mapWrapper = document.getElementById('mapWrapper');
        if (window.ResizeObserver && mapWrapper) {
            let resizeTimer = null;
            new ResizeObserver(() => {
                if (!map) return;
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => {
                    map.invalidateSize({ pan: false });
                    renderGeoLabels();
                }, 80);
            }).observe(mapWrapper);
        }

        let moveDebounce = null;
        map.on('zoomend', () => {
            renderApplePhotoMarkers(false);
            renderGeoLabels();
            if (showCityBounds && map.getZoom() >= 5.5) {
                scheduleIdle(() => loadVisibleProvincesCityGeo(), 120);
            }
        });
        map.on('moveend', () => {
            clearTimeout(moveDebounce);
            moveDebounce = setTimeout(() => {
                if (currentLabelMode !== 'none') renderGeoLabels();
                if (showCityBounds && map.getZoom() >= 5.5) loadVisibleProvincesCityGeo();
            }, 100);
        });

        loadChinaProvinceGeoJSON();
        renderGeoLabels();
    }

    function fitChinaBoundsOnMobile(animate = true) {
        if (!map) return;
        map.invalidateSize();
        map.fitBounds([[18.2, 74.0], [53.2, 134.5]], { padding: [8, 8], animate, duration: 0.5 });
    }

    async function fetchGeoJSONWithCache(cacheKey, url, simplifyTol = 0.015) {
        const cached = await GeoCacheDB.get(cacheKey);
        if (cached) return cached;
        const res = await fetch(url, { referrerPolicy: 'no-referrer', cache: 'force-cache' });
        if (!res.ok) return null;
        const raw = await res.json();
        const simplified = simplifyTol > 0 ? simplifyGeoJSON(raw, simplifyTol) : raw;
        GeoCacheDB.set(cacheKey, simplified);
        return simplified;
    }

    async function loadChinaProvinceGeoJSON() {
        const badge = document.getElementById('mapLoadingBadge');
        try {
            const chinaGeo = await (chinaGeoPreloadPromise || fetchGeoJSONWithCache(
                'china_100000_lite',
                'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json',
                0.022
            ));
            if (chinaGeo && map) {
                provinceGeoLayer = L.geoJSON(chinaGeo, {
                    renderer: canvasRenderer,
                    style: feature => getProvinceStyle(feature.properties.name),
                    onEachFeature: (feature, layer) => {
                        layer.on('click', async (e) => {
                            const provName = feature.properties.name;
                            if (['北京市', '天津市', '上海市', '重庆市', '香港特别行政区', '澳门特别行政区'].includes(provName)) {
                                L.DomEvent.stopPropagation(e);
                                openCityInteraction(provName, provName);
                            } else {
                                const provObj = PROV_MAP_BY_NAME[provName];
                                if (provObj) {
                                    showToast(`正在展开 ${provName} 的地级市...`);
                                    await fetchProvinceCitiesGeo(provObj.code, provObj.prov);
                                    refreshMapPolygonStyles();
                                    if (e.latlng && map.getZoom() < 5.5) map.flyTo(e.latlng, 6, { duration: 0.5 });
                                }
                            }
                        });
                    }
                }).addTo(map);
                provinceGeoLayer.bringToBack();
            }
        } catch (err) {
            console.warn('省级边界加载失败', err);
        } finally {
            if (badge) badge.classList.add('hidden');
        }
    }

    const DIRECT_PROV_CODES = new Set(['110000', '120000', '310000', '500000', '810000', '820000']);

    async function loadVisitedProvincesCityGeo() {
        const posts = travelData.posts || [];
        const codes = new Set();
        posts.forEach(p => {
            const meta = CITY_MAP_BY_NAME[normalizeCityName(p.city)];
            if (meta && !DIRECT_PROV_CODES.has(meta.provCode)) codes.add(meta.provCode);
        });
        const tasks = [];
        codes.forEach(code => {
            const provObj = CHINA_REGIONS.find(r => r.code === code);
            if (provObj) tasks.push(fetchProvinceCitiesGeo(provObj.code, provObj.prov));
        });
        if (tasks.length > 0) {
            await Promise.allSettled(tasks);
            refreshMapPolygonStyles();
        }
    }

    async function loadVisibleProvincesCityGeo() {
        if (!map || !showCityBounds) return;
        const bounds = map.getBounds().pad(0.15);
        const toLoad = [];
        CHINA_REGIONS.forEach(r => {
            if (DIRECT_PROV_CODES.has(r.code) || loadedProvinceCityGeo[r.code] || loadingProvinceCityGeo[r.code]) return;
            if (bounds.contains([r.labelLat, r.labelLng]) || r.cities.some(c => bounds.contains([c.lat, c.lng]))) {
                toLoad.push(r);
            }
        });
        if (toLoad.length === 0) return;
        await Promise.allSettled(toLoad.slice(0, 6).map(r => fetchProvinceCitiesGeo(r.code, r.prov)));
        refreshMapPolygonStyles();
    }

    function toggleCityBoundaries() {
        showCityBounds = !showCityBounds;
        const btnText = document.getElementById('cityBoundText');
        if (showCityBounds) {
            if (cityGeoLayerGroup && !map.hasLayer(cityGeoLayerGroup)) cityGeoLayerGroup.addTo(map);
            if (btnText) btnText.innerText = "市界自动";
            loadVisibleProvincesCityGeo();
            showToast("已开启市界（缩放自动按需加载）✨");
        } else {
            if (cityGeoLayerGroup && map.hasLayer(cityGeoLayerGroup)) map.removeLayer(cityGeoLayerGroup);
            if (btnText) btnText.innerText = "市界已关";
            showToast("已隐藏地级市边界线");
        }
    }

    async function fetchProvinceCitiesGeo(provCode, provName) {
        if (loadedProvinceCityGeo[provCode] || loadingProvinceCityGeo[provCode]) return;
        loadingProvinceCityGeo[provCode] = true;
        try {
            const geoData = await fetchGeoJSONWithCache(
                `prov_${provCode}_lite`,
                `https://geo.datav.aliyun.com/areas_v3/bound/${provCode}_full.json`,
                0.012
            );
            if (!geoData || !map) return;
            loadedProvinceCityGeo[provCode] = geoData;

            const layer = L.geoJSON(geoData, {
                renderer: canvasRenderer,
                style: feature => getCityPolygonStyle(feature.properties.name),
                onEachFeature: (feature, lyr) => {
                    const cityName = feature.properties.name;
                    lyr.on('click', (e) => {
                        L.DomEvent.stopPropagation(e);
                        openCityInteraction(provName, cityName);
                    });
                }
            });
            cityGeoLayerGroup.addLayer(layer);
        } catch (e) {
        } finally {
            delete loadingProvinceCityGeo[provCode];
        }
    }

    function isCityVisited(cityName) {
        if (!travelData.posts || travelData.posts.length === 0) return false;
        const norm = normalizeCityName(cityName);
        return travelData.posts.some(p => normalizeCityName(p.city) === norm);
    }

    function isProvinceVisited(provName) {
        if (!travelData.posts || travelData.posts.length === 0) return false;
        const shortProv = provName.replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区)$/g, '');
        return travelData.posts.some(p => (p.province && p.province.includes(shortProv)) || (p.city && p.city.includes(shortProv)));
    }

    function getProvinceStyle(provName) {
        const visited = isProvinceVisited(provName);
        const isDirect = ['北京市', '天津市', '上海市', '重庆市', '香港特别行政区', '澳门特别行政区'].includes(provName);
        return {
            color: visited ? '#f43f5e' : '#f9a8d4',
            weight: visited ? 1.4 : 1.0,
            opacity: 0.9,
            fillColor: isDirect ? (visited ? '#fb7185' : '#ffffff') : (visited ? '#ffe4e6' : '#ffffff'),
            fillOpacity: isDirect ? (visited ? 0.85 : 0.92) : 0.92
        };
    }

    function getCityPolygonStyle(cityName) {
        const visited = isCityVisited(cityName);
        return {
            color: visited ? '#e11d48' : '#fbcfe8',
            weight: visited ? 1.5 : 0.75,
            opacity: visited ? 0.95 : 0.8,
            fillColor: visited ? '#fb7185' : '#fff7fa',
            fillOpacity: visited ? 0.82 : 0.35
        };
    }

    function refreshMapPolygonStyles() {
        if (provinceGeoLayer) provinceGeoLayer.setStyle(f => getProvinceStyle(f.properties.name));
        if (cityGeoLayerGroup) {
            cityGeoLayerGroup.eachLayer(geoLayer => {
                if (geoLayer.setStyle) geoLayer.setStyle(f => getCityPolygonStyle(f.properties.name));
            });
        }
    }

    function toggleMapToolsMenu(e) {
        if (e) e.stopPropagation();
        const menu = document.getElementById('mapToolsMenu');
        if (menu) menu.classList.toggle('hidden');
    }
    function closeMapToolsMenu() {
        const menu = document.getElementById('mapToolsMenu');
        if (menu && !menu.classList.contains('hidden')) menu.classList.add('hidden');
    }

    // =========================================================================
    // 7. 地名标注（限制同屏最大 42 个标签 + 碰撞避让）
    // =========================================================================
    function toggleLabelMode(mode) {
        currentLabelMode = mode;
        const modeNames = { province: '省份名称', capital: '全国省会城市', city: '全国地级市', none: '已关闭地名标注' };
        showToast(mode === 'none' ? modeNames.none : `已显示：${modeNames[mode]} 🏷️`);
        localStorage.setItem('loveGacha_mapLabelMode', currentLabelMode);
        updateLabelModeButtons();
        renderGeoLabels();
    }

    function updateLabelModeButtons() {
        const mapBtns = {
            province: document.getElementById('lblBtnProv'),
            capital: document.getElementById('lblBtnCap'),
            city: document.getElementById('lblBtnCity'),
            none: document.getElementById('lblBtnNone')
        };
        Object.entries(mapBtns).forEach(([key, btn]) => {
            if (!btn) return;
            btn.className = currentLabelMode === key
                ? "py-0.5 rounded-full text-10 font-bold bg-rose-500 text-white"
                : "py-0.5 rounded-full text-10 font-bold text-gray-500";
        });
    }

    function renderGeoLabels() {
        if (!map || !labelLayerGroup) return;
        labelLayerGroup.clearLayers();
        if (currentLabelMode === 'none') return;

        const bounds = map.getBounds().pad(0.08);
        const occupiedBoxes = [];
        const MAX_LABELS = 42;
        let placed = 0;

        function tryPlaceBox(pt, w, h) {
            if (placed >= MAX_LABELS) return false;
            const x1 = pt.x - w / 2, x2 = pt.x + w / 2, y1 = pt.y - h / 2, y2 = pt.y + h / 2;
            for (let i = 0; i < occupiedBoxes.length; i++) {
                const b = occupiedBoxes[i];
                if (!(x2 < b.x1 || x1 > b.x2 || y2 < b.y1 || y1 > b.y2)) return false;
            }
            occupiedBoxes.push({ x1, x2, y1, y2 });
            placed++;
            return true;
        }

        if (currentLabelMode === 'province') {
            CHINA_REGIONS.forEach(reg => {
                if (!bounds.contains([reg.labelLat, reg.labelLng])) return;
                const pt = map.latLngToContainerPoint([reg.labelLat, reg.labelLng]);
                if (!tryPlaceBox(pt, 26, 13)) return;
                const visited = isProvinceVisited(reg.prov);
                const icon = L.divIcon({
                    className: 'geo-label-wrapper',
                    html: `<span class="geo-label-prov ${visited ? 'visited' : ''}">${reg.short}</span>`,
                    iconSize: [0, 0]
                });
                L.marker([reg.labelLat, reg.labelLng], { icon, interactive: false, zIndexOffset: -200 }).addTo(labelLayerGroup);
            });
        } else if (currentLabelMode === 'capital') {
            const sortedCaps = [...CAPITAL_CITIES].sort((a, b) => (isCityVisited(b.city) ? 1 : 0) - (isCityVisited(a.city) ? 1 : 0));
            for (const c of sortedCaps) {
                if (placed >= MAX_LABELS) break;
                if (!bounds.contains([c.lat, c.lng])) continue;
                const pt = map.latLngToContainerPoint([c.lat, c.lng]);
                if (!tryPlaceBox(pt, 34, 15)) continue;
                const visited = isCityVisited(c.city);
                const icon = L.divIcon({
                    className: 'geo-label-wrapper',
                    html: `<span class="geo-label-capital ${visited ? 'visited' : ''}"><span class="dot"></span>${c.shortCity}</span>`,
                    iconSize: [0, 0]
                });
                const m = L.marker([c.lat, c.lng], { icon, zIndexOffset: -150 });
                m.on('click', e => { L.DomEvent.stopPropagation(e); openCityInteraction(c.province, c.city); });
                m.addTo(labelLayerGroup);
            }
        } else if (currentLabelMode === 'city') {
            const zoom = map.getZoom();
            const boxW = zoom >= 6.5 ? 28 : (zoom >= 5 ? 32 : 36);
            const boxH = zoom >= 6.5 ? 12 : 14;
            const candidates = ALL_CITIES_FLAT
                .filter(c => bounds.contains([c.lat, c.lng]))
                .sort((a, b) => (isCityVisited(b.city) ? 2 : (b.isCapital ? 1 : 0)) - (isCityVisited(a.city) ? 2 : (a.isCapital ? 1 : 0)));
            for (const c of candidates) {
                if (placed >= MAX_LABELS) break;
                const pt = map.latLngToContainerPoint([c.lat, c.lng]);
                if (!tryPlaceBox(pt, boxW, boxH)) continue;
                const visited = isCityVisited(c.city);
                const icon = L.divIcon({
                    className: 'geo-label-wrapper',
                    html: `<span class="geo-label-city ${visited ? 'visited' : ''}"><span class="dot"></span>${c.shortCity}</span>`,
                    iconSize: [0, 0]
                });
                const m = L.marker([c.lat, c.lng], { icon, zIndexOffset: -150 });
                m.on('click', e => { L.DomEvent.stopPropagation(e); openCityInteraction(c.province, c.city); });
                m.addTo(labelLayerGroup);
            }
        }
    }

    // =========================================================================
    // 8. 双向奔赴里程计算
    // =========================================================================
    function haversineKm(lat1, lng1, lat2, lng2) {
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    }

    function computeTravelDistanceSummary() {
        const posts = travelData.posts || [];
        const byCity = {};
        const sharedSet = getSharedTripKeys();

        posts.forEach(post => {
            const canonicalCity = normalizeCityName(post.city);
            const meta = CITY_MAP_BY_NAME[canonicalCity] || CITY_MAP_BY_NAME[post.city];
            const lat = post.lat || (meta ? meta.lat : null);
            const lng = post.lng || (meta ? meta.lng : null);
            if (!lat || !lng) return;

            const ts = post.tripDate ? new Date(post.tripDate + 'T00:00:00').getTime() : (post.time || Date.now());
            if (!byCity[canonicalCity]) byCity[canonicalCity] = [];
            byCity[canonicalCity].push({
                city: canonicalCity,
                province: post.province || (meta ? meta.province : ''),
                lat, lng,
                ts: isNaN(ts) ? (post.time || Date.now()) : ts,
                dateStr: post.tripDate || new Date(post.time || Date.now()).toISOString().split('T')[0]
            });
        });

        const TRIP_GAP_MS = 14 * 24 * 3600 * 1000;
        const trips = [];
        Object.values(byCity).forEach(items => {
            items.sort((a, b) => a.ts - b.ts);
            let cur = null;
            items.forEach(item => {
                if (!cur || (item.ts - cur.endTs > TRIP_GAP_MS)) {
                    cur = {
                        tripKey: `${item.city}_${item.dateStr}`,
                        city: item.city, province: item.province,
                        lat: item.lat, lng: item.lng,
                        startTs: item.ts, endTs: item.ts,
                        dateStr: item.dateStr, photoCount: 1
                    };
                    trips.push(cur);
                } else {
                    cur.endTs = item.ts;
                    cur.photoCount++;
                }
            });
        });

        trips.sort((a, b) => b.startTs - a.startTs);
        const mult = isRoundTripMode ? 2 : 1;
        let hengTotal = 0, qinTotal = 0;

        trips.forEach(t => {
            t.sharedDeparture = sharedSet.has(t.tripKey);
            if (t.sharedDeparture) {
                t.hengKm = 0;
                t.qinKm = 0;
            } else {
                const hOneWay = haversineKm(HOME_BASES.heng.lat, HOME_BASES.heng.lng, t.lat, t.lng);
                const qOneWay = haversineKm(HOME_BASES.qin.lat, HOME_BASES.qin.lng, t.lat, t.lng);
                t.hengKm = (hOneWay < 15 ? 0 : hOneWay) * mult;
                t.qinKm = (qOneWay < 15 ? 0 : qOneWay) * mult;
            }
            hengTotal += t.hengKm;
            qinTotal += t.qinKm;
        });

        lastDistanceSummary = { hengTotal, qinTotal, trips };
        return lastDistanceSummary;
    }

    function updateDistanceUI() {
        const summary = computeTravelDistanceSummary();
        document.getElementById('statHengDist').innerText = summary.hengTotal.toLocaleString();
        document.getElementById('statQinDist').innerText = summary.qinTotal.toLocaleString();
        document.getElementById('distModeBadge').innerText = isRoundTripMode ? '往返 ›' : '单程 ›';
        if (!document.getElementById('distanceDetailModal').classList.contains('hidden')) {
            renderDistanceModalContent();
        }
    }

    function openDistanceModal() {
        renderDistanceModalContent();
        document.getElementById('distanceDetailModal').classList.remove('hidden');
    }
    function closeDistanceModal() {
        document.getElementById('distanceDetailModal').classList.add('hidden');
    }
    function setDistanceMode(roundTrip) {
        isRoundTripMode = roundTrip;
        localStorage.setItem('loveGacha_distRoundTrip', String(roundTrip));
        updateDistanceUI();
    }
    function selectDistYear(y) {
        currentDistYear = y;
        renderDistanceModalContent();
    }

    function renderDistanceModalContent() {
        const summary = computeTravelDistanceSummary();
        const years = Array.from(new Set(summary.trips.map(t => (t.dateStr || '').slice(0, 4)).filter(y => /^\d{4}$/.test(y)))).sort((a, b) => b.localeCompare(a));
        if (currentDistYear !== 'ALL' && !years.includes(currentDistYear)) currentDistYear = 'ALL';

        const yearTabs = [{ val: 'ALL', label: '全部年份' }, ...years.map(y => ({ val: y, label: y + '年' }))];
        document.getElementById('distYearTabs').innerHTML = yearTabs.map(it => `
            <button onclick="selectDistYear('${it.val}')" class="px-3 py-1 rounded-full text-11 font-bold whitespace-nowrap ${currentDistYear === it.val ? 'bg-rose-500 text-white shadow-xs' : 'bg-white text-rose-500 border border-rose-100'}">${it.label}</button>
        `).join('');

        const filteredTrips = currentDistYear === 'ALL'
            ? summary.trips
            : summary.trips.filter(t => (t.dateStr || '').startsWith(currentDistYear));

        let hTotal = 0, qTotal = 0;
        filteredTrips.forEach(t => { hTotal += t.hengKm; qTotal += t.qinKm; });
        const combined = hTotal + qTotal;
        const earthPct = ((combined / 40075) * 100).toFixed(2);

        document.getElementById('modalHengTotal').innerText = hTotal.toLocaleString();
        document.getElementById('modalQinTotal').innerText = qTotal.toLocaleString();
        document.getElementById('modalHengOrigin').innerText = `起点：${HOME_BASES.heng.city}`;
        document.getElementById('modalQinOrigin').innerText = `起点：${HOME_BASES.qin.city}`;
        document.getElementById('modalCombinedTotal').innerText = combined.toLocaleString();
        document.getElementById('modalEarthRatio').innerText = combined > 0 ? `(约绕地球赤道 ${earthPct}%)` : '';
        document.getElementById('distModalSub').innerText = `共 ${filteredTrips.length} 次行程 · ${isRoundTripMode ? '往返(×2)' : '单程'}直线距离`;

        document.getElementById('btnModeOneWay').className = isRoundTripMode ? "px-3 py-1 rounded-full text-11 font-bold text-rose-500" : "px-3 py-1 rounded-full text-11 font-bold bg-rose-500 text-white";
        document.getElementById('btnModeRoundTrip').className = isRoundTripMode ? "px-3 py-1 rounded-full text-11 font-bold bg-rose-500 text-white" : "px-3 py-1 rounded-full text-11 font-bold text-rose-500";

        const listEl = document.getElementById('distanceTripsList');
        if (filteredTrips.length === 0) {
            listEl.innerHTML = `<div class="bg-white rounded-2xl p-5 text-center text-xs text-gray-400 border border-rose-100">该时段还没有旅行打卡记录哦 ✈️</div>`;
            return;
        }

        listEl.innerHTML = filteredTrips.map(t => `
            <div onclick="closeDistanceModal(); flyToSearchedCity('${t.province}', '${t.city}', ${t.lat}, ${t.lng})" class="bg-white rounded-2xl p-3 border border-rose-100 shadow-xs cursor-pointer">
                <div class="flex items-center justify-between mb-1.5 gap-2">
                    <div class="flex items-center gap-1.5 min-w-0">
                        <span class="text-xs font-bold text-rose-500 truncate">📍 ${t.city}</span>
                        <span class="text-10 text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded-full shrink-0">${t.photoCount}张</span>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <button onclick="toggleTripShared('${t.tripKey}', event)" class="text-10 px-2 py-0.5 rounded-full font-bold border ${t.sharedDeparture ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-gray-50 text-gray-400 border-gray-200'}">${t.sharedDeparture ? '🤝 已标共同出发' : '标记共同出发'}</button>
                        <span class="text-10 text-gray-400 font-mono">${t.dateStr}</span>
                    </div>
                </div>
                ${t.sharedDeparture
                    ? `<div class="text-11 bg-amber-50 text-amber-600 px-2.5 py-1 rounded-xl font-bold">🤝 共同出发行程（不计入异地双向奔赴里程）</div>`
                    : `<div class="grid grid-cols-2 gap-2 text-11">
                        <div class="bg-sky-50 text-sky-700 px-2.5 py-1 rounded-xl flex items-center justify-between">
                            <span>👦 ${HOME_BASES.heng.shortCity} →</span>
                            <span class="font-bold">${t.hengKm.toLocaleString()} km</span>
                        </div>
                        <div class="bg-rose-50 text-rose-600 px-2.5 py-1 rounded-xl flex items-center justify-between">
                            <span>👦 ${HOME_BASES.qin.shortCity} →</span>
                            <span class="font-bold">${t.qinKm.toLocaleString()} km</span>
                        </div>
                    </div>`
                }
            </div>
        `).join('');
    }

    function buildArcPoints(lat1, lng1, lat2, lng2, bend = 0.16) {
        const pts = [];
        const midLat = (lat1 + lat2) / 2, midLng = (lng1 + lng2) / 2;
        const ctrlLat = midLat + (lng2 - lng1) * bend, ctrlLng = midLng - (lat2 - lat1) * bend;
        for (let i = 0; i <= 18; i++) {
            const t = i / 18;
            pts.push([
                (1 - t) * (1 - t) * lat1 + 2 * (1 - t) * t * ctrlLat + t * t * lat2,
                (1 - t) * (1 - t) * lng1 + 2 * (1 - t) * t * ctrlLng + t * t * lng2
            ]);
        }
        return pts;
    }

    function toggleRouteLines() {
        isRouteVisible = !isRouteVisible;
        localStorage.setItem('loveGacha_mapRouteVisible', String(isRouteVisible));
        updateRouteButtonUI();
        renderRouteLines();
        showToast(isRouteVisible ? "已开启哼哼 & 亲亲奔赴航线 ✨" : "已隐藏奔赴航线");
    }

    function updateRouteButtonUI() {
        const btn = document.getElementById('btnRouteToggle');
        const text = document.getElementById('routeToggleText');
        if (!btn || !text) return;
        if (isRouteVisible) {
            btn.className = "px-2 py-1.5 bg-rose-500 text-white rounded-xl border border-rose-500 flex items-center justify-center gap-1 font-bold text-10 active-scale-95";
            text.innerText = "航线已开";
        } else {
            btn.className = "px-2 py-1.5 bg-rose-50 rounded-xl border border-rose-100 flex items-center justify-center gap-1 text-rose-500 font-bold text-10 active-scale-95";
            text.innerText = "奔赴航线";
        }
    }

    function renderRouteLines() {
        if (!map || !routeLayerGroup) return;
        routeLayerGroup.clearLayers();
        if (!isRouteVisible) return;

        const hengIcon = L.divIcon({ className: 'geo-label-wrapper', html: `<span class="home-pin-badge home-pin-heng">👦 ${HOME_BASES.heng.shortCity}</span>`, iconSize: [0, 0] });
        const qinIcon = L.divIcon({ className: 'geo-label-wrapper', html: `<span class="home-pin-badge home-pin-qin">👦 ${HOME_BASES.qin.shortCity}</span>`, iconSize: [0, 0] });
        L.marker([HOME_BASES.heng.lat, HOME_BASES.heng.lng], { icon: hengIcon, interactive: false, zIndexOffset: 200 }).addTo(routeLayerGroup);
        L.marker([HOME_BASES.qin.lat, HOME_BASES.qin.lng], { icon: qinIcon, interactive: false, zIndexOffset: 200 }).addTo(routeLayerGroup);

        const drawn = new Set();
        (lastDistanceSummary.trips || []).forEach(t => {
            if (t.sharedDeparture || drawn.has(t.city)) return;
            drawn.add(t.city);
            if (t.hengKm > 0) {
                L.polyline(buildArcPoints(HOME_BASES.heng.lat, HOME_BASES.heng.lng, t.lat, t.lng, 0.14), {
                    color: '#0284c7', weight: 1.8, opacity: 0.72, dashArray: '4, 5', interactive: false, renderer: canvasRenderer
                }).addTo(routeLayerGroup);
            }
            if (t.qinKm > 0) {
                L.polyline(buildArcPoints(HOME_BASES.qin.lat, HOME_BASES.qin.lng, t.lat, t.lng, -0.14), {
                    color: '#e11d48', weight: 1.8, opacity: 0.72, dashArray: '4, 5', interactive: false, renderer: canvasRenderer
                }).addTo(routeLayerGroup);
            }
        });
    }

    // =========================================================================
    // 9. 苹果相册风格地图缩略图
    // =========================================================================
    function getZoomTier(z) {
        if (z >= 6.8) return 3;
        if (z >= 6.0) return 2;
        if (z >= 5.0) return 1;
        return 0;
    }

    function renderApplePhotoMarkers(force = false) {
        if (!map || !markerLayerGroup) return;
        const currentZoom = map.getZoom();
        const tier = getZoomTier(currentZoom);
        const renderKey = `${dataVersion}_${tier}`;
        if (!force && renderKey === lastMarkerRenderKey) return;
        lastMarkerRenderKey = renderKey;

        markerLayerGroup.clearLayers();
        if (!travelData.posts || travelData.posts.length === 0) return;

        const cityGroups = {};
        travelData.posts.forEach(post => {
            const canonicalCity = normalizeCityName(post.city);
            const cityMeta = CITY_MAP_BY_NAME[canonicalCity] || CITY_MAP_BY_NAME[post.city];
            const lat = post.lat || (cityMeta ? cityMeta.lat : null);
            const lng = post.lng || (cityMeta ? cityMeta.lng : null);
            const prov = post.province || (cityMeta ? cityMeta.province : '');
            if (!lat || !lng) return;
            if (!cityGroups[canonicalCity]) {
                cityGroups[canonicalCity] = { city: canonicalCity, province: prov, lat, lng, posts: [] };
            }
            cityGroups[canonicalCity].posts.push(post);
        });

        const cityGroupList = Object.values(cityGroups);
        cityGroupList.forEach(g => g.posts.sort((a, b) => b.time - a.time));

        const markerSize = currentZoom >= 6 ? 48 : (currentZoom >= 4.5 ? 42 : 38);
        const clusterPixelThreshold = currentZoom >= 6.8 ? 0 : (currentZoom >= 5 ? 34 : 42);
        const clusters = [];

        cityGroupList.forEach(group => {
            const pt = map.latLngToLayerPoint([group.lat, group.lng]);
            let merged = false;
            if (clusterPixelThreshold > 0) {
                for (const cluster of clusters) {
                    const cpt = map.latLngToLayerPoint([cluster.lat, cluster.lng]);
                    if (Math.hypot(pt.x - cpt.x, pt.y - cpt.y) < clusterPixelThreshold) {
                        cluster.posts.push(...group.posts);
                        cluster.cities.push(group.city);
                        cluster.posts.sort((a, b) => b.time - a.time);
                        merged = true;
                        break;
                    }
                }
            }
            if (!merged) {
                clusters.push({ lat: group.lat, lng: group.lng, province: group.province, cities: [group.city], posts: [...group.posts] });
            }
        });

        clusters.forEach((cluster, idx) => {
            const coverPost = cluster.posts[0];
            const rawThumb = coverPost.thumbUrl || coverPost.url;
            const cachedSrc = ThumbCacheDB.peek(rawThumb);
            const totalCount = cluster.posts.length;
            const displayCityName = cluster.cities.length > 1
                ? `${cluster.cities[0].replace(/(市|自治州|地区|盟)$/g, '')}等${cluster.cities.length}城`
                : cluster.cities[0].replace(/(市|自治州|地区|盟|特别行政区)$/g, '');

            const imgId = `mthumb_${dataVersion}_${idx}`;
            const iconHtml = `
                <div class="apple-photo-marker" style="--marker-size: ${markerSize}px;">
                    ${totalCount > 1 ? '<div class="apple-photo-stack-bg"></div>' : ''}
                    <div class="apple-photo-frame">
                        <img id="${imgId}" src="${cachedSrc || rawThumb}" alt="${displayCityName}" loading="lazy" decoding="async">
                    </div>
                    <div class="apple-photo-pointer"></div>
                    ${totalCount > 1 ? `<div class="apple-photo-badge">${totalCount}</div>` : ''}
                    <div class="apple-photo-city-label">${displayCityName}</div>
                </div>
            `;

            const divIcon = L.divIcon({
                className: 'apple-marker-wrapper',
                html: iconHtml,
                iconSize: [markerSize, markerSize],
                iconAnchor: [markerSize / 2, markerSize]
            });

            const marker = L.marker([cluster.lat, cluster.lng], { icon: divIcon, zIndexOffset: 300 });
            marker.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                openClusterAlbumModal(cluster);
            });
            markerLayerGroup.addLayer(marker);

            if (!cachedSrc && rawThumb) {
                ThumbCacheDB.resolveUrl(rawThumb).then(objUrl => {
                    const imgEl = document.getElementById(imgId);
                    if (imgEl && objUrl && imgEl.src !== objUrl) imgEl.src = objUrl;
                });
            }
        });
    }

    function mapZoomIn() { if (map) map.zoomIn(0.8); }
    function mapZoomOut() { if (map) map.zoomOut(0.8); }
    function resetMapView() { fitChinaBoundsOnMobile(true); }

    function handleMapCitySearch(val) {
        const kw = val.trim();
        const clearBtn = document.getElementById('clearMapSearchBtn');
        const dropdown = document.getElementById('mapSearchDropdown');
        if (!kw) {
            clearBtn.classList.add('hidden');
            dropdown.classList.add('hidden');
            return;
        }
        clearBtn.classList.remove('hidden');
        const matches = searchChinaCities(kw, 10);
        if (matches.length === 0) {
            dropdown.innerHTML = `<div class="text-xs text-gray-400 p-2 text-center">未找到该地级市</div>`;
        } else {
            dropdown.innerHTML = matches.map(m => {
                const visited = isCityVisited(m.city);
                return `
                    <div onclick="flyToSearchedCity('${m.province}', '${m.city}', ${m.lat}, ${m.lng})" class="px-2.5 py-1.5 text-xs hover-bg-rose-50 rounded-lg cursor-pointer flex items-center justify-between">
                        <span class="font-bold ${visited ? 'text-rose-500' : 'text-gray-700'}">${visited ? '🚩 ' : ''}${m.city}</span>
                        <span class="text-10 text-gray-400">${m.provShort}</span>
                    </div>
                `;
            }).join('');
        }
        dropdown.classList.remove('hidden');
    }

    function clearMapCitySearch() {
        document.getElementById('mapCitySearch').value = '';
        document.getElementById('clearMapSearchBtn').classList.add('hidden');
        document.getElementById('mapSearchDropdown').classList.add('hidden');
    }

    async function flyToSearchedCity(prov, city, lat, lng) {
        clearMapCitySearch();
        const provObj = PROV_MAP_BY_NAME[prov];
        if (provObj && !DIRECT_PROV_CODES.has(provObj.code)) {
            fetchProvinceCitiesGeo(provObj.code, provObj.prov).then(() => refreshMapPolygonStyles());
        }
        if (map) map.flyTo([lat, lng], 7, { duration: 0.7 });
        setTimeout(() => openCityInteraction(prov, city), 480);
    }

    function openCityInteraction(provName, cityName) {
        const canonicalCity = normalizeCityName(cityName);
        const cityMeta = CITY_MAP_BY_NAME[canonicalCity];
        const province = provName || (cityMeta ? cityMeta.province : '');
        const cityPosts = (travelData.posts || []).filter(p => normalizeCityName(p.city) === canonicalCity);
        openClusterAlbumModal({
            province,
            cities: [canonicalCity],
            posts: cityPosts.sort((a, b) => (b.tripDate || '').localeCompare(a.tripDate || '') || b.time - a.time)
        });
    }

    function switchAlbumTagFilter(tagKey) {
        currentAlbumTagFilter = tagKey;
        if (currentAlbumCluster) renderClusterAlbumPosts(currentAlbumCluster);
    }

    function openClusterAlbumModal(cluster) {
        currentAlbumCluster = cluster;
        currentAlbumTagFilter = '全部';
        const primaryCity = cluster.cities[0];
        const cityMeta = CITY_MAP_BY_NAME[primaryCity];
        const primaryProv = cluster.province || (cityMeta ? cityMeta.province : '中国');

        document.getElementById('modalCityTitle').innerText = cluster.cities.length > 1
            ? `${primaryCity} 等 ${cluster.cities.length} 个城市` : primaryCity;
        document.getElementById('modalCitySub').innerText = `${primaryProv} · 共 ${cluster.posts.length} 篇旅行记忆`;
        document.getElementById('modalQuickUploadBtn').onclick = () => {
            closeCityAlbumModal();
            jumpToUploadWithCity(primaryProv, primaryCity);
        };

        renderClusterAlbumPosts(cluster);
        document.getElementById('cityAlbumModal').classList.remove('hidden');
    }

    function renderClusterAlbumPosts(cluster) {
        const listEl = document.getElementById('modalCityPostsList');
        const primaryCity = cluster.cities[0];
        const cityMeta = CITY_MAP_BY_NAME[primaryCity];
        const primaryProv = cluster.province || (cityMeta ? cityMeta.province : '中国');

        if (cluster.posts.length === 0) {
            listEl.innerHTML = `
                <div class="text-center py-7 bg-white rounded-2xl border border-rose-100 p-4">
                    <div class="text-3xl mb-2">✈️</div>
                    <p class="text-sm font-bold text-gray-600 mb-1">我们还没在【${primaryCity}】留下照片哦</p>
                    <p class="text-xs text-gray-400 mb-4">快去上传第一张照片，点亮这座城市吧！</p>
                    <button onclick="closeCityAlbumModal(); jumpToUploadWithCity('${primaryProv}', '${primaryCity}')" class="px-5 py-2 bg-grad-rose text-white text-xs font-bold rounded-full shadow-md">立即去点亮 ${primaryCity} 🚀</button>
                </div>
            `;
            return;
        }

        const filterItems = [{ key: '全部', icon: '✨' }, ...TAG_OPTIONS];
        const filterBarHtml = `<div class="flex items-center gap-1.5 overflow-x-auto custom-scrollbar pb-1">
            ${filterItems.map(t => `<button onclick="switchAlbumTagFilter('${t.key}')" class="px-2.5 py-0.5 rounded-full text-11 font-bold whitespace-nowrap border ${currentAlbumTagFilter === t.key ? 'bg-rose-500 text-white border-rose-500' : 'bg-white text-gray-500 border-rose-100'}">${t.icon} ${t.key}</button>`).join('')}
        </div>`;

        const filtered = currentAlbumTagFilter === '全部'
            ? cluster.posts
            : cluster.posts.filter(p => Array.isArray(p.tags) && p.tags.includes(currentAlbumTagFilter));

        if (filtered.length === 0) {
            listEl.innerHTML = filterBarHtml + `<div class="bg-white rounded-2xl p-6 text-center text-xs text-gray-400 border border-rose-100">该标签下还没有【${primaryCity}】的记录哦 🍃</div>`;
            return;
        }

        const localLikes = JSON.parse(localStorage.getItem('loveGacha_myTravelLikes') || '[]');
        const cardsHtml = filtered.map(post => {
            const imgs = getPostImages(post);
            const thumb = imgs[0] ? (ThumbCacheDB.peek(imgs[0].thumbUrl || imgs[0].url) || imgs[0].thumbUrl || imgs[0].url) : '';
            const fullUrl = imgs[0] ? imgs[0].url : '';
            const dateStr = post.tripDate || new Date(post.time).toLocaleDateString();
            const isLiked = localLikes.includes(post.id);
            const uploaderEmoji = (post.uploader || '').includes('亲') ? '👦' : '👦';
            return `
                <div class="bg-white rounded-2xl p-3 shadow-sm border border-rose-100 space-y-2">
                    <div class="flex gap-3 items-start">
                        <div class="relative w-20 h-20 shrink-0 cursor-zoom-in" onclick="openImageViewer('${thumb}', '${fullUrl}', ${post.id}, 0)">
                            <img src="${thumb}" loading="lazy" decoding="async" class="w-full h-full rounded-xl object-cover border border-rose-50 shadow-xs bg-rose-50">
                            ${imgs.length > 1 ? `<span class="absolute bottom-1 right-1 bg-black-60 text-white text-9 font-bold px-1.5 py-0.5 rounded-full">📷 ${imgs.length}</span>` : ''}
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center justify-between mb-1">
                                <span class="text-11 font-bold text-rose-500 bg-rose-50 px-2 py-0.5 rounded-full truncate">📍 ${post.city}</span>
                                <span class="text-10 text-gray-400 font-mono shrink-0 ml-1">${dateStr}</span>
                            </div>
                            ${buildTagsHtml(post.tags)}
                            <p class="text-xs text-gray-700 leading-relaxed break-words line-clamp-3 my-1">${escapeHtml(post.description || '在这里留下了美好的足迹~')}</p>
                        </div>
                    </div>
                    ${buildDualNotesHtml(post.notes)}
                    <div class="flex items-center justify-between pt-1.5 border-t border-rose-50">
                        <div class="flex items-center gap-1.5">
                            <span class="text-11 text-gray-500 font-medium">${uploaderEmoji} ${escapeHtml(post.uploader || '我们')}</span>
                            <button onclick="openQuickNoteModal(${post.id}, event)" class="text-10 bg-sky-50 text-sky-600 px-2 py-0.5 rounded-full font-bold">💬 碎碎念</button>
                            <button onclick="openEditPostModal(${post.id}, event)" class="text-10 bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full font-bold">✏️ 编辑</button>
                            <button onclick="deleteTravelPost(${post.id}, event)" class="text-10 bg-gray-50 text-gray-400 px-1.5 py-0.5 rounded-full font-bold">🗑️</button>
                        </div>
                        <button onclick="toggleLike(${post.id}, event)" class="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${isLiked ? 'bg-rose-50 text-rose-500 border-rose-200' : 'bg-gray-50 text-gray-500 border-gray-200'} border">
                            <span>${isLiked ? '❤️' : '🤍'}</span>
                            <span class="font-bold text-11">${post.likes || 0}</span>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        listEl.innerHTML = filterBarHtml + cardsHtml;
    }

    function closeCityAlbumModal() { document.getElementById('cityAlbumModal').classList.add('hidden'); }

    function jumpToUploadWithCity(province, city) {
        switchMainTab('upload');
        if (province) {
            document.getElementById('formProvince').value = province;
            onProvinceChange(city);
            saveUploadDraft();
        }
        showToast(`已为你选中：${city} 📍`);
    }

    // =========================================================================
    // 10. 全国地级市点亮图鉴
    // =========================================================================
    function updateStatsAndChips() {
        const posts = travelData.posts || [];
        const visitedCitiesSet = new Set();
        const visitedProvsSet = new Set();
        let totalPhotos = 0;

        posts.forEach(p => {
            const canonicalCity = normalizeCityName(p.city);
            visitedCitiesSet.add(canonicalCity);
            totalPhotos += getPostImages(p).length;
            const meta = CITY_MAP_BY_NAME[canonicalCity];
            if (meta) visitedProvsSet.add(meta.province);
            else if (p.province) visitedProvsSet.add(p.province);
        });

        document.getElementById('statProvCount').innerText = visitedProvsSet.size;
        document.getElementById('statCityCount').innerText = visitedCitiesSet.size;
        document.getElementById('statPhotoCount').innerText = totalPhotos;
        updateDistanceUI();

        const chipsBar = document.getElementById('visitedCityChipsBar');
        if (visitedCitiesSet.size === 0) {
            chipsBar.innerHTML = `<div onclick="switchMainTab('upload')" class="w-full text-center py-1.5 bg-white rounded-full border border-rose-100 text-xs text-rose-400 font-bold cursor-pointer">✨ 还没有点亮城市哦，点击发布第一张旅行照片吧！</div>`;
        } else {
            const cityCounts = {};
            posts.forEach(p => { const c = normalizeCityName(p.city); cityCounts[c] = (cityCounts[c] || 0) + 1; });
            chipsBar.innerHTML = Array.from(visitedCitiesSet).map(cityName => {
                const meta = CITY_MAP_BY_NAME[cityName];
                const lat = meta ? meta.lat : 35.8, lng = meta ? meta.lng : 104.2, prov = meta ? meta.province : '';
                return `
                    <button onclick="flyToSearchedCity('${prov}', '${cityName}', ${lat}, ${lng})" class="px-2.5 py-1 bg-white text-rose-500 rounded-full text-11 font-bold shadow-xs border border-rose-100 whitespace-nowrap flex items-center gap-1 shrink-0 active-scale-95">
                        <span>📍 ${cityName.replace(/(市|自治州|地区|盟|特别行政区)$/g, '')}</span>
                        <span class="text-10 opacity-75">(${cityCounts[cityName]})</span>
                    </button>
                `;
            }).join('');
        }
    }

    function openVisitedModal() {
        renderVisitedModalList();
        document.getElementById('visitedOverviewModal').classList.remove('hidden');
    }
    function closeVisitedModal() { document.getElementById('visitedOverviewModal').classList.add('hidden'); }
    function toggleVisitedOnlyLit() {
        visitedOnlyLit = !visitedOnlyLit;
        const btn = document.getElementById('visitedOnlyLitBtn');
        btn.className = visitedOnlyLit
            ? "px-2.5 py-1.5 rounded-full text-11 font-bold border border-rose-500 bg-rose-500 text-white shrink-0"
            : "px-2.5 py-1.5 rounded-full text-11 font-bold border border-rose-200 bg-white text-rose-500 shrink-0";
        renderVisitedModalList();
    }

    function renderVisitedModalList() {
        const content = document.getElementById('visitedOverviewContent');
        const sub = document.getElementById('visitedOverviewSub');
        const kw = (document.getElementById('visitedSearchInput').value || '').trim().toLowerCase();

        const visitedCitiesSet = new Set((travelData.posts || []).map(p => normalizeCityName(p.city)));
        let visitedProvCount = 0;

        const groups = CHINA_REGIONS.map(region => {
            const litCities = region.cities.filter(c => visitedCitiesSet.has(c.name));
            if (litCities.length > 0) visitedProvCount++;
            return { region, litCities };
        });

        sub.innerText = `已点亮 ${visitedProvCount} 个省级行政区 · ${visitedCitiesSet.size} / ${ALL_CITIES_FLAT.length} 个地级市`;
        groups.sort((a, b) => (b.litCities.length > 0 ? 1 : 0) - (a.litCities.length > 0 ? 1 : 0) || b.litCities.length - a.litCities.length);

        let html = '';
        groups.forEach(({ region, litCities }) => {
            if (visitedOnlyLit && litCities.length === 0) return;

            let citiesToShow = region.cities;
            if (kw) {
                const provMatch = region.prov.includes(kw) || (region.py || '').startsWith(kw);
                if (!provMatch) {
                    citiesToShow = region.cities.filter(c => c.name.includes(kw) || (c.py || '').startsWith(kw));
                    if (citiesToShow.length === 0) return;
                }
            }

            const shouldOpen = litCities.length > 0 || Boolean(kw);
            html += `
                <details class="bg-white rounded-2xl p-3 shadow-xs border border-rose-100" ${shouldOpen ? 'open' : ''}>
                    <summary class="flex items-center justify-between cursor-pointer list-none">
                        <span class="text-xs font-bold ${litCities.length > 0 ? 'text-rose-500' : 'text-gray-600'}">
                            ${litCities.length > 0 ? '🚩 ' : '▸ '}${region.prov}
                        </span>
                        <span class="text-10 font-bold ${litCities.length > 0 ? 'text-rose-500 bg-rose-50' : 'text-gray-400 bg-gray-50'} px-2 py-0.5 rounded-full">
                            ${litCities.length} / ${region.cities.length}
                        </span>
                    </summary>
                    <div class="flex flex-wrap gap-1.5 mt-2">
                        ${citiesToShow.map(c => {
                            const lit = visitedCitiesSet.has(c.name);
                            return `<span onclick="closeVisitedModal(); flyToSearchedCity('${region.prov}', '${c.name}', ${c.lat}, ${c.lng})" class="px-2 py-0.5 rounded-md text-11 cursor-pointer ${lit ? 'bg-rose-500 text-white font-bold shadow-xs' : 'bg-gray-50 text-gray-500'}">${c.name.replace(/(市|自治州|地区|盟|特别行政区)$/g, '')}</span>`;
                        }).join('')}
                    </div>
                </details>
            `;
        });

        content.innerHTML = html || `<div class="bg-white rounded-2xl p-6 text-center text-xs text-gray-400 border border-rose-100">没有找到匹配的城市 🍃</div>`;
    }

    // =========================================================================
    // 11. 主视图切换 + 旅行手账
    // =========================================================================
    function switchMainTab(tab, updateUrl = true) {
        const views = { map: document.getElementById('mapView'), wall: document.getElementById('wallView'), upload: document.getElementById('uploadView') };
        const btns = { map: document.getElementById('tabMapBtn'), wall: document.getElementById('tabWallBtn'), upload: document.getElementById('tabUploadBtn') };

        for (const key in views) {
            const active = key === tab;
            views[key].classList.toggle('hidden', !active);
            btns[key].className = active
                ? "flex-1 py-1.5 bg-rose-500 text-white rounded-full font-bold shadow-md transition-all text-xs"
                : "flex-1 py-1.5 bg-transparent text-rose-500 rounded-full font-bold transition-all text-xs hover-bg-rose-50";
        }

        if (updateUrl) {
            try {
                const url = new URL(location.href);
                url.searchParams.set('tab', tab);
                history.replaceState(null, '', url.toString());
            } catch (e) {}
        }

        if (tab === 'map' && map) {
            setTimeout(() => {
                map.invalidateSize();
                renderGeoLabels();
                renderApplePhotoMarkers(false);
            }, 60);
        }
        if (tab === 'wall') {
            renderWallFilterOptions();
            renderWall(true);
        }
    }

    function initWallTagFilterBarOnce() {
        const bar = document.getElementById('wallTagFilterBar');
        if (!bar) return;
        const items = [{ key: '全部', icon: '✨' }, ...TAG_OPTIONS];
        bar.innerHTML = items.map(t => `
            <button data-tag="${t.key}" onclick="switchWallTagFilter('${t.key}')" class="wall-tag-btn px-2.5 py-0.5 rounded-full text-11 font-bold whitespace-nowrap border ${t.key === '全部' ? 'bg-rose-500 text-white border-rose-500 shadow-xs' : 'bg-white text-gray-500 border-rose-100'}">${t.icon} ${t.key}</button>
        `).join('');
    }

    function switchWallTagFilter(tagKey) {
        currentWallTagFilter = tagKey;
        document.querySelectorAll('#wallTagFilterBar .wall-tag-btn').forEach(btn => {
            const active = btn.getAttribute('data-tag') === tagKey;
            btn.className = `wall-tag-btn px-2.5 py-0.5 rounded-full text-11 font-bold whitespace-nowrap border ${active ? 'bg-rose-500 text-white border-rose-500 shadow-xs' : 'bg-white text-gray-500 border-rose-100'}`;
        });
        renderWall(true);
    }

    function renderWallFilterOptions() {
        const posts = travelData.posts || [];
        const tabContainer = document.getElementById('provinceFilterTabs');
        const citySet = new Set(['全部']);
        const yearSet = new Set();
        posts.forEach(p => {
            if (p.city) citySet.add(normalizeCityName(p.city));
            const y = (p.tripDate || new Date(p.time || Date.now()).toISOString().split('T')[0]).slice(0, 4);
            if (/^\d{4}$/.test(y)) yearSet.add(y);
        });
        tabContainer.innerHTML = Array.from(citySet).map(cat => {
            const active = cat === currentProvinceFilter;
            const label = cat === '全部' ? '全部城市' : cat.replace(/(市|自治州|地区|盟|特别行政区)$/g, '');
            return `<button onclick="switchCityFilter('${cat}')" class="px-2.5 py-1 text-11 font-bold rounded-md whitespace-nowrap ${active ? 'bg-rose-100 text-rose-600' : 'text-gray-500'}">${label}</button>`;
        }).join('');

        const yearSel = document.getElementById('wallYearSelect');
        const prevYear = yearSel.value || 'ALL';
        const years = Array.from(yearSet).sort((a, b) => b.localeCompare(a));
        yearSel.innerHTML = `<option value="ALL">全部年份</option>` + years.map(y => `<option value="${y}">${y}年</option>`).join('');
        yearSel.value = years.includes(prevYear) ? prevYear : 'ALL';
    }

    function switchCityFilter(cat) {
        currentProvinceFilter = cat;
        renderWallFilterOptions();
        renderWall(true);
    }

    function onWallFilterChange() { renderWall(true); }

    function buildTagsHtml(tags) {
        if (!tags || tags.length === 0) return '';
        return `<div class="flex flex-wrap gap-1 mb-1.5">${tags.map(t => {
            const opt = TAG_OPTIONS.find(o => o.key === t);
            return `<span class="text-9 font-bold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-500 border border-rose-100">${opt ? opt.icon + ' ' : '#'}${escapeHtml(t)}</span>`;
        }).join('')}</div>`;
    }

    function buildDualNotesHtml(notes) {
        if (!notes) return '';
        const h = (notes.heng || '').trim(), q = (notes.qin || '').trim();
        if (!h && !q) return '';
        return `<div class="space-y-1 mb-1.5">
            ${h ? `<div class="text-10 bg-sky-50 text-sky-700 px-2 py-1 rounded-lg border border-sky-100 leading-snug break-words"><span class="font-bold">👦 哼哼：</span>${escapeHtml(h)}</div>` : ''}
            ${q ? `<div class="text-10 bg-rose-50 text-rose-600 px-2 py-1 rounded-lg border border-rose-100 leading-snug break-words"><span class="font-bold">👦 亲亲：</span>${escapeHtml(q)}</div>` : ''}
        </div>`;
    }

    function buildWallCardHtml(item, localLikes) {
        const dateStr = item.tripDate || new Date(item.time).toLocaleDateString();
        const imgs = getPostImages(item);
        const rawThumb = imgs[0] ? (imgs[0].thumbUrl || imgs[0].url) : '';
        const displayThumb = ThumbCacheDB.peek(rawThumb) || rawThumb;
        const fullUrl = imgs[0] ? imgs[0].url : '';
        const likesCount = item.likes || 0;
        const isLiked = localLikes.includes(item.id);
        const shortCity = (item.city || '未知城市').replace(/(市|自治州|地区|盟|特别行政区)$/g, '');
        const descHtml = item.description ? `<p class="text-xs text-gray-600 leading-relaxed line-clamp-3 mb-1.5 break-words">${escapeHtml(item.description)}</p>` : '';

        return `
            <div class="bg-white rounded-xl shadow-sm border border-rose-100 relative overflow-hidden w-full mb-2.5">
                <div class="cursor-zoom-in relative w-full overflow-hidden bg-rose-50 min-h-100" onclick="openImageViewer('${rawThumb}', '${fullUrl}', ${item.id}, 0)">
                    <img src="${displayThumb}" loading="lazy" decoding="async" class="w-full h-auto block object-cover">
                    <div class="absolute top-1.5 left-1.5 bg-white-95 text-rose-500 text-10 font-bold px-2 py-0.5 rounded-full shadow-xs flex items-center gap-0.5">
                        <span>📍</span><span>${shortCity}</span>
                    </div>
                    <div class="absolute top-1.5 right-1.5 bg-black-55 text-white text-9 font-mono px-1.5 py-0.5 rounded-full">${dateStr}</div>
                    ${imgs.length > 1 ? `<div class="absolute bottom-1.5 right-1.5 bg-black-60 text-white text-9 font-bold px-1.5 py-0.5 rounded-full">📷 1/${imgs.length}</div>` : ''}
                </div>
                <div class="p-2.5">
                    ${buildTagsHtml(item.tags)}
                    ${descHtml}
                    ${buildDualNotesHtml(item.notes)}
                    <div class="flex items-center justify-between pt-1.5 border-t border-rose-50 gap-1">
                        <div class="flex items-center gap-1">
                            <button onclick="openQuickNoteModal(${item.id}, event)" title="写碎碎念" class="text-10 bg-sky-50 text-sky-600 px-1.5 py-0.5 rounded-md font-bold">💬</button>
                            <button onclick="openEditPostModal(${item.id}, event)" title="编辑" class="text-10 bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded-md font-bold">✏️</button>
                            <button onclick="deleteTravelPost(${item.id}, event)" title="删除" class="text-10 bg-gray-50 text-gray-400 px-1.5 py-0.5 rounded-md font-bold">🗑️</button>
                        </div>
                        <div class="flex items-center gap-1">
                            <button onclick="locatePostOnMap('${item.province || ''}', '${item.city}')" class="text-10 bg-rose-50 text-rose-500 px-1.5 py-0.5 rounded-md font-bold">地图</button>
                            <button onclick="toggleLike(${item.id}, event)" class="flex items-center gap-0.5 bg-rose-50 px-1.5 py-0.5 rounded-md border border-rose-100">
                                <span class="text-10">${isLiked ? '❤️' : '🤍'}</span>
                                <span class="text-10 font-bold ${isLiked ? 'text-rose-500' : 'text-gray-500'}">${likesCount}</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    function renderWall(reset = true) {
        const container = document.getElementById('photoGrid');
        const loadMoreWrap = document.getElementById('wallLoadMoreWrap');
        const sortMode = document.getElementById('sortSelect').value;
        const kw = (document.getElementById('wallSearchInput').value || '').trim().toLowerCase();
        const yearFilter = document.getElementById('wallYearSelect').value;
        const uploaderFilter = document.getElementById('wallUploaderSelect').value;

        if (!travelData.posts || travelData.posts.length === 0) {
            container.innerHTML = `<div class="w-full text-center text-sm text-gray-400 py-12">还没有旅行记录哦，快去“打卡发布”点亮第一座城市吧~ ✈️</div>`;
            loadMoreWrap.classList.add('hidden');
            return;
        }

        let list = [...travelData.posts];
        if (currentProvinceFilter !== '全部') {
            list = list.filter(p => normalizeCityName(p.city) === currentProvinceFilter);
        }
        if (currentWallTagFilter !== '全部') {
            list = list.filter(p => Array.isArray(p.tags) && p.tags.includes(currentWallTagFilter));
        }
        if (yearFilter && yearFilter !== 'ALL') {
            list = list.filter(p => (p.tripDate || new Date(p.time || Date.now()).toISOString().split('T')[0]).startsWith(yearFilter));
        }
        if (uploaderFilter && uploaderFilter !== 'ALL') {
            list = list.filter(p => (p.uploader || '').includes(uploaderFilter));
        }
        if (kw) {
            list = list.filter(p => {
                const hay = `${p.city || ''} ${p.province || ''} ${p.description || ''} ${(p.tags || []).join(' ')} ${(p.notes && p.notes.heng) || ''} ${(p.notes && p.notes.qin) || ''}`.toLowerCase();
                return hay.includes(kw);
            });
        }

        if (sortMode === 'tripDateDesc') {
            list.sort((a, b) => (b.tripDate || '').localeCompare(a.tripDate || '') || b.time - a.time);
        } else if (sortMode === 'tripDateAsc') {
            list.sort((a, b) => (a.tripDate || '').localeCompare(b.tripDate || '') || a.time - b.time);
        } else if (sortMode === 'likes') {
            list.sort((a, b) => (b.likes || 0) - (a.likes || 0) || b.time - a.time);
        } else {
            list.sort((a, b) => b.time - a.time);
        }

        if (list.length === 0) {
            container.innerHTML = `<div class="w-full text-center text-sm text-gray-400 py-10">当前筛选条件下还没有记录哦~ 🍃</div>`;
            loadMoreWrap.classList.add('hidden');
            return;
        }

        wallFilteredList = list;
        if (reset) {
            wallRenderedCount = 0;
            container.innerHTML = `
                <div class="flex gap-2.5 items-start w-full">
                    <div id="wallColLeft" class="flex flex-col w-1-2"></div>
                    <div id="wallColRight" class="flex flex-col w-1-2"></div>
                </div>
            `;
        }

        appendNextWallPage();
        setupWallInfiniteObserver();
    }

    function appendNextWallPage() {
        const leftCol = document.getElementById('wallColLeft');
        const rightCol = document.getElementById('wallColRight');
        const loadMoreWrap = document.getElementById('wallLoadMoreWrap');
        if (!leftCol || !rightCol) return;

        const slice = wallFilteredList.slice(wallRenderedCount, wallRenderedCount + WALL_PAGE_SIZE);
        if (slice.length === 0) {
            loadMoreWrap.classList.add('hidden');
            return;
        }

        const localLikes = JSON.parse(localStorage.getItem('loveGacha_myTravelLikes') || '[]');
        let leftHtml = '', rightHtml = '';
        slice.forEach((item, idx) => {
            const absIdx = wallRenderedCount + idx;
            const html = buildWallCardHtml(item, localLikes);
            if (absIdx % 2 === 0) leftHtml += html;
            else rightHtml += html;
        });

        leftCol.insertAdjacentHTML('beforeend', leftHtml);
        rightCol.insertAdjacentHTML('beforeend', rightHtml);
        wallRenderedCount += slice.length;

        loadMoreWrap.classList.toggle('hidden', wallRenderedCount >= wallFilteredList.length);
    }

    function setupWallInfiniteObserver() {
        if (!window.IntersectionObserver) return;
        if (wallObserver) wallObserver.disconnect();
        const sentinel = document.getElementById('wallLoadMoreSentinel');
        const root = document.getElementById('wallScrollContainer');
        if (!sentinel || !root) return;
        wallObserver = new IntersectionObserver((entries) => {
            if (entries[0] && entries[0].isIntersecting && wallRenderedCount < wallFilteredList.length) {
                appendNextWallPage();
            }
        }, { root, rootMargin: '220px' });
        wallObserver.observe(sentinel);
    }

    function locatePostOnMap(prov, city) {
        const meta = CITY_MAP_BY_NAME[normalizeCityName(city)];
        switchMainTab('map');
        if (meta && map) setTimeout(() => map.flyTo([meta.lat, meta.lng], 7, { duration: 0.7 }), 120);
    }

    // =========================================================================
    // 12. 打卡发布：ObjectURL 预览 + 设封面 + EXIF 识别 + 客户端 HD 压缩 + 草稿暂存
    // =========================================================================
    function initProvinceCitySelects() {
        const provSelect = document.getElementById('formProvince');
        provSelect.innerHTML = CHINA_REGIONS.map(p => `<option value="${p.prov}">${p.prov}</option>`).join('');
        onProvinceChange();
    }

    function onProvinceChange(targetCityName) {
        const provName = document.getElementById('formProvince').value;
        const provObj = CHINA_REGIONS.find(p => p.prov === provName) || CHINA_REGIONS[0];
        const citySelect = document.getElementById('formCity');
        citySelect.innerHTML = provObj.cities.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
        if (targetCityName) citySelect.value = targetCityName;
    }

    function quickMatchCity(keyword) {
        const dropdown = document.getElementById('quickMatchDropdown');
        const kw = keyword.trim();
        if (!kw) { dropdown.classList.add('hidden'); return; }
        const matches = searchChinaCities(kw, 12);
        dropdown.innerHTML = matches.length === 0
            ? `<div class="text-xs text-gray-400 p-2 text-center">未找到匹配的地级市</div>`
            : matches.map(m => `
                <div onclick="selectCityInForm('${m.province}', '${m.city}')" class="px-3 py-1.5 text-xs hover-bg-rose-50 rounded-lg cursor-pointer flex items-center justify-between">
                    <span class="font-bold text-rose-500">${m.city}</span>
                    <span class="text-10 text-gray-400">${m.provShort}</span>
                </div>
            `).join('');
        dropdown.classList.remove('hidden');
    }

    function selectCityInForm(province, city) {
        document.getElementById('formProvince').value = province;
        onProvinceChange(city);
        document.getElementById('cityQuickFilter').value = '';
        document.getElementById('quickMatchDropdown').classList.add('hidden');
        saveUploadDraft();
        showToast(`已选择：${province} · ${city} 📍`);
    }

    async function extractJpegExif(file) {
        try {
            const buf = await file.slice(0, 131072).arrayBuffer();
            const view = new DataView(buf);
            if (view.byteLength < 12 || view.getUint16(0, false) !== 0xFFD8) return null;
            let offset = 2;
            while (offset + 4 < view.byteLength) {
                const marker = view.getUint16(offset, false);
                offset += 2;
                if (marker === 0xFFE1) {
                    if (view.getUint32(offset + 2, false) !== 0x45786966) return null;
                    const tiff = offset + 8;
                    const little = view.getUint16(tiff, false) === 0x4949;
                    const firstIfd = view.getUint32(tiff + 4, little);
                    const res = {};

                    function readAscii(off, len) {
                        let s = '';
                        for (let i = 0; i < len - 1 && off + i < view.byteLength; i++) {
                            s += String.fromCharCode(view.getUint8(off + i));
                        }
                        return s;
                    }
                    function readRational(off) {
                        const num = view.getUint32(off, little), den = view.getUint32(off + 4, little);
                        return den ? num / den : 0;
                    }
                    function parseIfd(ifdStart, target) {
                        if (!ifdStart || ifdStart + 2 > view.byteLength) return;
                        const entries = view.getUint16(ifdStart, little);
                        for (let i = 0; i < entries; i++) {
                            const e = ifdStart + 2 + i * 12;
                            if (e + 12 > view.byteLength) break;
                            const tag = view.getUint16(e, little);
                            const count = view.getUint32(e + 4, little);
                            const valOff = tiff + view.getUint32(e + 8, little);
                            if (tag === 0x8769) parseIfd(valOff, 'exif');
                            else if (tag === 0x8825) parseIfd(valOff, 'gps');
                            else if ((tag === 0x9003 || tag === 0x0132) && !res.dateStr) {
                                const dt = readAscii(valOff, count);
                                const m = dt.match(/^(\d{4}):(\d{2}):(\d{2})/);
                                if (m) res.dateStr = `${m[1]}-${m[2]}-${m[3]}`;
                            } else if (target === 'gps') {
                                if (tag === 0x0001) res.latRef = String.fromCharCode(view.getUint8(e + 8));
                                else if (tag === 0x0003) res.lngRef = String.fromCharCode(view.getUint8(e + 8));
                                else if (tag === 0x0002 && count === 3) {
                                    res.lat = readRational(valOff) + readRational(valOff + 8) / 60 + readRational(valOff + 16) / 3600;
                                } else if (tag === 0x0004 && count === 3) {
                                    res.lng = readRational(valOff) + readRational(valOff + 8) / 60 + readRational(valOff + 16) / 3600;
                                }
                            }
                        }
                    }
                    parseIfd(tiff + firstIfd, 'ifd0');
                    if (res.lat && res.latRef === 'S') res.lat = -res.lat;
                    if (res.lng && res.lngRef === 'W') res.lng = -res.lng;
                    return (res.dateStr || (res.lat && res.lng)) ? res : null;
                } else if ((marker & 0xFF00) !== 0xFF00) {
                    break;
                } else {
                    offset += view.getUint16(offset, false);
                }
            }
        } catch (e) {}
        return null;
    }

    function findNearestCity(lat, lng) {
        let best = null, minKm = Infinity;
        for (const c of ALL_CITIES_FLAT) {
            const d = haversineKm(lat, lng, c.lat, c.lng);
            if (d < minKm) { minKm = d; best = c; }
        }
        return minKm <= 160 ? best : null;
    }

    async function handleImageSelect(event) {
        const files = Array.from(event.target.files || []);
        if (files.length === 0) return;

        const remain = 9 - selectedUploadImages.length;
        if (remain <= 0) {
            showToast("每次打卡最多上传 9 张照片哦 📸");
            event.target.value = '';
            return;
        }
        const toProcess = files.slice(0, remain);
        if (files.length > remain) showToast(`最多支持 9 张，已选取前 ${remain} 张`);

        const wasEmpty = selectedUploadImages.length === 0;
        toProcess.forEach(file => {
            if (file.size > 20 * 1024 * 1024) {
                showToast(`${file.name} 超过 20MB，已跳过`);
                return;
            }
            selectedUploadImages.push({
                file,
                objectUrl: URL.createObjectURL(file),
                ext: 'jpg'
            });
        });
        renderUploadPreviewGrid();
        event.target.value = '';

        if (wasEmpty && selectedUploadImages[0]) {
            const exif = await extractJpegExif(selectedUploadImages[0].file);
            if (exif) {
                const hints = [];
                if (exif.dateStr) {
                    document.getElementById('formTripDate').value = exif.dateStr;
                    hints.push(`日期 ${exif.dateStr}`);
                }
                if (exif.lat && exif.lng) {
                    const near = findNearestCity(exif.lat, exif.lng);
                    if (near) {
                        document.getElementById('formProvince').value = near.province;
                        onProvinceChange(near.city);
                        hints.push(`城市 ${near.city}`);
                    }
                }
                if (hints.length > 0) {
                    saveUploadDraft();
                    showToast(`✨ 已从照片识别：${hints.join(' · ')}`);
                }
            }
        }
    }

    function renderUploadPreviewGrid() {
        const placeholder = document.getElementById('uploadPlaceholder');
        const grid = document.getElementById('uploadPreviewGrid');
        const countLabel = document.getElementById('uploadPhotoCountLabel');
        if (countLabel) countLabel.innerText = `${selectedUploadImages.length}/9 张`;

        if (selectedUploadImages.length === 0) {
            placeholder.classList.remove('hidden');
            grid.classList.add('hidden');
            grid.innerHTML = '';
            return;
        }

        placeholder.classList.add('hidden');
        grid.classList.remove('hidden');

        let html = selectedUploadImages.map((img, idx) => `
            <div class="relative aspect-square rounded-xl overflow-hidden border border-rose-200 bg-white shadow-xs" onclick="event.stopPropagation()">
                <img src="${img.objectUrl}" class="w-full h-full object-cover">
                ${idx === 0
                    ? '<span class="absolute bottom-1 left-1 bg-rose-500 text-white text-9 font-bold px-1.5 py-0.5 rounded-full">封面</span>'
                    : `<button type="button" onclick="setUploadCover(${idx}, event)" class="absolute bottom-1 left-1 bg-black-60 text-white text-9 font-bold px-1.5 py-0.5 rounded-full">设封面</button>`
                }
                <button type="button" onclick="removeUploadImage(${idx}, event)" class="absolute top-1 right-1 w-5 h-5 rounded-full bg-black-60 text-white text-xs font-bold flex items-center justify-center">×</button>
            </div>
        `).join('');

        if (selectedUploadImages.length < 9) {
            html += `
                <div onclick="event.stopPropagation(); document.getElementById('imageInput').click()" class="aspect-square rounded-xl border-2 border-dashed border-rose-300 bg-rose-50 flex flex-col items-center justify-center cursor-pointer text-rose-400">
                    <span class="text-xl leading-none font-bold">+</span>
                    <span class="text-10 mt-0.5 font-bold">继续添加</span>
                </div>
            `;
        }
        grid.innerHTML = html;
    }

    function setUploadCover(idx, event) {
        if (event) event.stopPropagation();
        if (idx <= 0 || idx >= selectedUploadImages.length) return;
        const [item] = selectedUploadImages.splice(idx, 1);
        selectedUploadImages.unshift(item);
        renderUploadPreviewGrid();
        showToast("已设为封面图 ✨");
    }

    function removeUploadImage(idx, event) {
        if (event) event.stopPropagation();
        const [removed] = selectedUploadImages.splice(idx, 1);
        if (removed && removed.objectUrl) URL.revokeObjectURL(removed.objectUrl);
        renderUploadPreviewGrid();
    }

    function clearImage(event) {
        if (event) event.stopPropagation();
        selectedUploadImages.forEach(it => { if (it.objectUrl) URL.revokeObjectURL(it.objectUrl); });
        selectedUploadImages = [];
        document.getElementById('imageInput').value = '';
        renderUploadPreviewGrid();
    }

    function renderUploadTagsUI() {
        const wrap = document.getElementById('uploadTagsWrap');
        if (!wrap) return;
        wrap.innerHTML = TAG_OPTIONS.map(t => {
            const active = selectedUploadTags.includes(t.key);
            return `<button type="button" onclick="toggleUploadTag('${t.key}')" class="px-2.5 py-1 rounded-full text-11 font-bold border ${active ? 'bg-rose-500 text-white border-rose-500 shadow-xs' : 'bg-rose-50 text-gray-500 border-rose-100'}">${t.icon} ${t.key}</button>`;
        }).join('');
    }

    function toggleUploadTag(tagKey) {
        if (selectedUploadTags.includes(tagKey)) selectedUploadTags = selectedUploadTags.filter(t => t !== tagKey);
        else selectedUploadTags.push(tagKey);
        renderUploadTagsUI();
        saveUploadDraft();
    }

    function saveUploadDraft() {
        try {
            const draft = {
                province: document.getElementById('formProvince').value,
                city: document.getElementById('formCity').value,
                tripDate: document.getElementById('formTripDate').value,
                description: document.getElementById('formDescription').value,
                note: document.getElementById('formInitialNote').value,
                tags: selectedUploadTags
            };
            localStorage.setItem(UPLOAD_DRAFT_KEY, JSON.stringify(draft));
        } catch (e) {}
    }

    function restoreUploadDraft() {
        document.getElementById('formTripDate').value = new Date().toISOString().split('T')[0];
        try {
            const raw = localStorage.getItem(UPLOAD_DRAFT_KEY);
            if (!raw) return;
            const d = JSON.parse(raw);
            if (d.province) {
                document.getElementById('formProvince').value = d.province;
                onProvinceChange(d.city);
            }
            if (d.tripDate) document.getElementById('formTripDate').value = d.tripDate;
            if (d.description) {
                document.getElementById('formDescription').value = d.description;
                document.getElementById('descCount').innerText = `${d.description.length}/300`;
            }
            if (d.note) document.getElementById('formInitialNote').value = d.note;
            if (Array.isArray(d.tags)) {
                selectedUploadTags = d.tags;
                renderUploadTagsUI();
            }
        } catch (e) {}
    }

    function clearUploadDraft() {
        try { localStorage.removeItem(UPLOAD_DRAFT_KEY); } catch (e) {}
    }

    function compressImagePair(objectUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                function renderToB64(maxSide, quality) {
                    let w = img.naturalWidth || img.width;
                    let h = img.naturalHeight || img.height;
                    if (w > maxSide || h > maxSide) {
                        const ratio = Math.min(maxSide / w, maxSide / h);
                        w = Math.round(w * ratio);
                        h = Math.round(h * ratio);
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    return canvas.toDataURL('image/jpeg', quality).split(',')[1];
                }
                resolve({
                    thumbBase64: renderToB64(420, 0.62),
                    hdBase64: renderToB64(1920, 0.82)
                });
            };
            img.onerror = reject;
            img.src = objectUrl;
        });
    }

    // =========================================================================
    // 13. GitHub API 同步（ETag 304 + 可见性感知轮询 + 409 冲突自动重试）
    // =========================================================================
    async function fetchTravelData(forceNoEtag = false) {
        if (!GITHUB_TOKEN) return false;
        try {
            const headers = {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `Bearer ${GITHUB_TOKEN}`
            };
            if (!forceNoEtag && travelEtag) headers['If-None-Match'] = travelEtag;

            const response = await fetch(`https://api.github.com/repos/${OWNER_REPO}/contents/${FILE_TRAVEL}`, {
                method: 'GET',
                headers,
                cache: 'no-cache'
            });

            if (response.status === 304) return false;
            if (response.status === 404) {
                const hadPosts = (travelData.posts || []).length > 0;
                travelData = { posts: [] };
                return hadPosts;
            }
            if (!response.ok) return false;

            const newEtag = response.headers.get('ETag');
            if (newEtag) {
                travelEtag = newEtag;
                try { localStorage.setItem(TRAVEL_ETAG_KEY, newEtag); } catch (e) {}
            }

            const result = await response.json();
            const contentStr = decodeURIComponent(escape(atob(result.content.replace(/\s/g, ''))));
            const nextData = JSON.parse(contentStr || '{"posts":[]}');
            if (!nextData.posts) nextData.posts = [];
            const nextJson = JSON.stringify(nextData);
            const prevJson = localStorage.getItem(TRAVEL_CACHE_KEY);
            travelData = nextData;
            travelSha = result.sha;
            try { localStorage.setItem(TRAVEL_CACHE_KEY, nextJson); } catch (e) {}

            if (nextJson !== prevJson) {
                dataVersion++;
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    async function updateFileRaw(filePath, newData, sha) {
        try {
            const encodedContent = btoa(unescape(encodeURIComponent(JSON.stringify(newData, null, 2))));
            const body = { message: `Update travel footprint data`, content: encodedContent };
            if (sha) body.sha = sha;
            const response = await fetch(`https://api.github.com/repos/${OWNER_REPO}/contents/${filePath}`, {
                method: 'PUT',
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `Bearer ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            if (!response.ok) return { success: false, status: response.status, sha };
            const result = await response.json();
            return { success: true, status: response.status, sha: result.content.sha };
        } catch (error) {
            return { success: false, status: 0, sha };
        }
    }

    async function mutateAndSync(mutatorFn) {
        mutatorFn(travelData);
        let res = await updateFileRaw(FILE_TRAVEL, travelData, travelSha);
        if (!res.success && res.status === 409) {
            await fetchTravelData(true);
            mutatorFn(travelData);
            res = await updateFileRaw(FILE_TRAVEL, travelData, travelSha);
        }
        if (res.success) {
            travelSha = res.sha;
            travelEtag = null;
            dataVersion++;
            try {
                localStorage.setItem(TRAVEL_CACHE_KEY, JSON.stringify(travelData));
                localStorage.removeItem(TRAVEL_ETAG_KEY);
            } catch (e) {}
        }
        return res;
    }

    function uploadMediaToGithubWithProgress(base64Data, extension, folderName, prefix) {
        return new Promise((resolve, reject) => {
            const filename = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${extension}`;
            const path = `${folderName}/${filename}`;
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', `https://api.github.com/repos/${OWNER_REPO}/contents/${path}`);
            xhr.setRequestHeader('Accept', 'application/vnd.github.v3+json');
            xhr.setRequestHeader('Authorization', `Bearer ${GITHUB_TOKEN}`);
            xhr.setRequestHeader('Content-Type', 'application/json');

            xhr.upload.onprogress = function(event) {
                if (event.lengthComputable) {
                    const pct = Math.floor((event.loaded / event.total) * 100);
                    const bar = document.getElementById('progressBar');
                    const txt = document.getElementById('progressText');
                    if (bar) bar.style.width = pct + '%';
                    if (txt) txt.innerText = pct + '%';
                }
            };
            xhr.onload = function() {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(JSON.parse(xhr.responseText).content.download_url);
                } else {
                    reject(new Error('Upload failed ' + xhr.status));
                }
            };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(JSON.stringify({ message: `Upload travel photo ${filename}`, content: base64Data }));
        });
    }

    async function submitTravelPost() {
        if (!selectedUploadImages.length) { showToast("请至少选择一张旅行照片哦！📸"); return; }
        if (!GITHUB_TOKEN) { showToast("未配置Token，无法上传！"); return; }

        const province = document.getElementById('formProvince').value;
        const city = document.getElementById('formCity').value;
        const tripDate = document.getElementById('formTripDate').value;
        const description = document.getElementById('formDescription').value.trim();
        const noteText = document.getElementById('formInitialNote').value.trim();
        if (!city) { showToast("请选择打卡的地级市哦 📍"); return; }

        const cityMeta = CITY_MAP_BY_NAME[city] || { lat: 35.8, lng: 104.2 };
        const btn = document.getElementById('submitBtn');
        const progressContainer = document.getElementById('progressContainer');
        const progressTitle = document.getElementById('progressTitle');

        btn.disabled = true;
        btn.classList.add('opacity-50');
        progressContainer.classList.remove('hidden');

        try {
            const total = selectedUploadImages.length;
            progressTitle.innerText = `⚡ 正在本地压缩 ${total} 张照片...`;
            const pairs = await Promise.all(selectedUploadImages.map(it => compressImagePair(it.objectUrl)));

            const uploadedImages = [];
            for (let i = 0; i < total; i++) {
                btn.innerText = `正在上传第 ${i + 1}/${total} 张...`;
                progressTitle.innerText = `🚀 上传第 ${i + 1}/${total} 张缩略图...`;
                const uploadedThumbUrl = await uploadMediaToGithubWithProgress(pairs[i].thumbBase64, 'jpg', 'travel', `thumb_${i}`);

                progressTitle.innerText = `🚀 上传第 ${i + 1}/${total} 张高清图...`;
                const uploadedImageUrl = await uploadMediaToGithubWithProgress(pairs[i].hdBase64, 'jpg', 'travel', `origin_${i}`);
                uploadedImages.push({ url: uploadedImageUrl, thumbUrl: uploadedThumbUrl });
            }

            btn.innerText = "正在点亮城市并同步...";
            const notesObj = {};
            if (noteText) notesObj[myIdentity.includes('亲') ? 'qin' : 'heng'] = noteText;

            const newPost = {
                id: Date.now(),
                url: uploadedImages[0].url,
                thumbUrl: uploadedImages[0].thumbUrl,
                images: uploadedImages,
                tags: [...selectedUploadTags],
                notes: notesObj,
                uploader: myIdentity,
                province, city,
                lat: cityMeta.lat, lng: cityMeta.lng,
                tripDate: tripDate || new Date().toISOString().split('T')[0],
                description,
                time: Date.now(),
                likes: 0
            };

            const upRes = await mutateAndSync(data => {
                if (!data.posts) data.posts = [];
                if (!data.posts.some(p => p.id === newPost.id)) data.posts.unshift(newPost);
            });

            if (upRes.success) {
                showToast(`🎉 成功点亮【${city}】(${uploadedImages.length}张照片)！`);
                clearImage();
                clearUploadDraft();
                selectedUploadTags = [];
                renderUploadTagsUI();
                document.getElementById('formDescription').value = '';
                document.getElementById('descCount').innerText = '0/300';
                document.getElementById('formInitialNote').value = '';

                await loadVisitedProvincesCityGeo();
                refreshAllViews();
                switchMainTab('map');
                if (map) setTimeout(() => map.flyTo([cityMeta.lat, cityMeta.lng], 6.2, { duration: 0.8 }), 180);
            } else {
                showToast("数据保存失败，请稍后重试");
            }
        } catch (error) {
            console.error(error);
            showToast("文件上传失败，请检查网络或文件大小");
        } finally {
            btn.innerHTML = "点亮城市并发布 🚀";
            btn.disabled = false;
            btn.classList.remove('opacity-50');
            setTimeout(() => progressContainer.classList.add('hidden'), 1000);
        }
    }

    async function toggleLike(postId, event) {
        if (event) event.stopPropagation();
        if (!GITHUB_TOKEN) { showToast("预览模式无法点赞哦，请先配置Token 💡"); return; }
        if (isLikingSyncing) { showToast("正在保存上次的点赞，请稍候... ⏳"); return; }

        let localLikes = JSON.parse(localStorage.getItem('loveGacha_myTravelLikes') || '[]');
        if (!localLikes.includes(postId)) {
            localLikes.push(postId);
            localStorage.setItem('loveGacha_myTravelLikes', JSON.stringify(localLikes));
        }

        isLikingSyncing = true;
        const upRes = await mutateAndSync(data => {
            const target = (data.posts || []).find(p => p.id === postId);
            if (target) target.likes = (target.likes || 0) + 1;
        });
        isLikingSyncing = false;

        if (upRes.success) {
            showToast("喜欢 +1 ❤️");
            refreshAllViews();
            if (!document.getElementById('cityAlbumModal').classList.contains('hidden') && currentAlbumCluster) {
                openCityInteraction(currentAlbumCluster.province, currentAlbumCluster.cities[0]);
            }
        } else {
            showToast("点赞保存失败，请检查网络 ❌");
        }
    }

    function refreshAllViews() {
        updateStatsAndChips();
        refreshMapPolygonStyles();
        renderGeoLabels();
        renderRouteLines();
        renderApplePhotoMarkers(true);
        if (!document.getElementById('wallView').classList.contains('hidden')) {
            renderWallFilterOptions();
            renderWall(true);
        }
    }

    function startPolling() {
        const runPoll = async () => {
            if (document.hidden) return;
            if (await fetchTravelData()) {
                await loadVisitedProvincesCityGeo();
                refreshAllViews();
            }
        };
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(runPoll, 60000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) runPoll();
        });
    }

    // =========================================================================
    // 14. 全屏高清图片查看器
    // =========================================================================
    let scale = 1, panning = false, pointX = 0, pointY = 0, startX = 0, startY = 0, lastDistance = 0;
    let touchStartX = 0, touchStartY = 0, touchStartTime = 0, lastTapTime = 0;

    function openImageViewer(thumbUrl, fullUrl, postId, startIdx = 0) {
        const modal = document.getElementById('imageViewerModal');
        const captionBar = document.getElementById('viewerCaptionBar');
        const post = (travelData.posts || []).find(p => p.id === postId);
        viewerCaptionHidden = false;
        captionBar.style.opacity = '1';

        if (post) {
            viewerImages = getPostImages(post);
            viewerIndex = Math.max(0, Math.min(startIdx || 0, viewerImages.length - 1));
            captionBar.classList.remove('hidden');
            const emoji = (post.uploader || '').includes('亲') ? '👦' : '👦';
            document.getElementById('viewerCityBadge').innerText = `📍 ${post.province || ''} · ${post.city}`;
            document.getElementById('viewerMetaText').innerText = `${emoji} ${post.uploader || '我们'} · ${post.tripDate || new Date(post.time).toLocaleDateString()}`;
            document.getElementById('viewerDescText').innerText = post.description || '在这里留下了美好的旅行足迹 ✨';
        } else {
            viewerImages = [{ thumbUrl: thumbUrl || fullUrl, url: fullUrl || thumbUrl }];
            viewerIndex = 0;
            captionBar.classList.add('hidden');
        }

        renderViewerCurrentImage();
        modal.classList.remove('hidden');
        requestAnimationFrame(() => modal.classList.remove('opacity-0'));
        setupZoomAndPan();
    }

    function preloadAdjacentViewerImages() {
        if (viewerImages.length <= 1) return;
        const nextItem = viewerImages[(viewerIndex + 1) % viewerImages.length];
        const prevItem = viewerImages[(viewerIndex - 1 + viewerImages.length) % viewerImages.length];
        [nextItem, prevItem].forEach(it => {
            if (it && it.url) ThumbCacheDB.resolveUrl(it.url);
        });
    }

    function renderViewerCurrentImage() {
        const img = document.getElementById('fullSizeImage');
        const loader = document.getElementById('imageViewerLoader');
        const prevBtn = document.getElementById('viewerPrevBtn');
        const nextBtn = document.getElementById('viewerNextBtn');
        const counterEl = document.getElementById('viewerCounterBadge');

        const item = viewerImages[viewerIndex] || { thumbUrl: '', url: '' };
        const thumbUrl = item.thumbUrl || item.url;
        const fullUrl = item.url || item.thumbUrl;

        scale = 1; pointX = 0; pointY = 0; setTransform();

        const multi = viewerImages.length > 1;
        prevBtn.classList.toggle('hidden', !multi);
        nextBtn.classList.toggle('hidden', !multi);
        counterEl.classList.toggle('hidden', !multi);
        if (multi) counterEl.innerText = `${viewerIndex + 1} / ${viewerImages.length}`;

        const cachedFull = ThumbCacheDB.peek(fullUrl);
        img.src = cachedFull || ThumbCacheDB.peek(thumbUrl) || thumbUrl;
        img.onload = function() {
            const container = document.getElementById('imageContainer');
            const initialScale = Math.min(container.clientWidth / img.naturalWidth, container.clientHeight / img.naturalHeight, 1);
            img.style.width = (img.naturalWidth * initialScale) + 'px';
            img.style.height = (img.naturalHeight * initialScale) + 'px';
        };

        if (!cachedFull && fullUrl && thumbUrl !== fullUrl) {
            loader.classList.remove('hidden');
            const expectedIdx = viewerIndex;
            ThumbCacheDB.resolveUrl(fullUrl).then(resolved => {
                if (viewerIndex === expectedIdx) {
                    img.src = resolved || fullUrl;
                    loader.classList.add('hidden');
                }
            });
        } else {
            loader.classList.add('hidden');
        }
        preloadAdjacentViewerImages();
    }

    function viewerPrevImage(event) {
        if (event) event.stopPropagation();
        if (viewerImages.length <= 1) return;
        viewerIndex = (viewerIndex - 1 + viewerImages.length) % viewerImages.length;
        renderViewerCurrentImage();
    }

    function viewerNextImage(event) {
        if (event) event.stopPropagation();
        if (viewerImages.length <= 1) return;
        viewerIndex = (viewerIndex + 1) % viewerImages.length;
        renderViewerCurrentImage();
    }

    async function downloadViewerImage(event) {
        if (event) event.stopPropagation();
        const item = viewerImages[viewerIndex];
        if (!item) return;
        const url = await ThumbCacheDB.resolveUrl(item.url || item.thumbUrl);
        const a = document.createElement('a');
        a.href = url;
        a.download = `travel_${Date.now()}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showToast("已触发保存原图（iOS 也可长按图片保存）💾");
    }

    function closeImageViewer(event) {
        if (event) event.stopPropagation();
        const modal = document.getElementById('imageViewerModal');
        modal.classList.add('opacity-0');
        setTimeout(() => {
            modal.classList.add('hidden');
            document.getElementById('fullSizeImage').src = '';
        }, 250);
        removeZoomAndPan();
    }

    function setTransform() {
        document.getElementById('fullSizeImage').style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
    }

    function handlePointerDown(e) {
        e.preventDefault();
        panning = true;
        if (e.touches && e.touches.length === 2) {
            lastDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        } else {
            const cx = e.touches ? e.touches[0].clientX : e.clientX;
            const cy = e.touches ? e.touches[0].clientY : e.clientY;
            touchStartX = cx; touchStartY = cy; touchStartTime = Date.now();
            startX = cx - pointX; startY = cy - pointY;
        }
    }

    function handlePointerMove(e) {
        e.preventDefault();
        if (!panning) return;
        if (e.touches && e.touches.length === 2) {
            const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            scale = Math.min(Math.max(0.5, scale + (dist - lastDistance) * 0.01), 5);
            lastDistance = dist;
            setTransform();
        } else if (scale > 1.05) {
            const cx = e.touches ? e.touches[0].clientX : e.clientX;
            const cy = e.touches ? e.touches[0].clientY : e.clientY;
            pointX = cx - startX; pointY = cy - startY;
            setTransform();
        }
    }

    function handlePointerUp(e) {
        e.preventDefault();
        if (!panning) return;
        panning = false;
        const changed = e.changedTouches ? e.changedTouches[0] : e;
        const dx = changed.clientX - touchStartX;
        const dy = changed.clientY - touchStartY;
        const dt = Date.now() - touchStartTime;

        if (scale <= 1.05 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 500) {
            if (dx < 0) viewerNextImage();
            else viewerPrevImage();
            return;
        }
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 280) {
            const now = Date.now();
            if (now - lastTapTime < 280) {
                lastTapTime = 0;
                if (scale > 1.2) { scale = 1; pointX = 0; pointY = 0; }
                else { scale = 2.2; pointX = 0; pointY = 0; }
                setTransform();
            } else {
                lastTapTime = now;
                setTimeout(() => {
                    if (lastTapTime === now) {
                        viewerCaptionHidden = !viewerCaptionHidden;
                        const bar = document.getElementById('viewerCaptionBar');
                        if (bar && !bar.classList.contains('hidden')) {
                            bar.style.opacity = viewerCaptionHidden ? '0' : '1';
                        }
                    }
                }, 290);
            }
        }
    }

    function handleWheel(e) {
        e.preventDefault();
        scale = Math.min(Math.max(0.5, scale + Math.sign(e.deltaY) * -0.1), 5);
        setTransform();
    }

    function setupZoomAndPan() {
        const c = document.getElementById('imageContainer');
        c.addEventListener('mousedown', handlePointerDown);
        c.addEventListener('mousemove', handlePointerMove);
        c.addEventListener('mouseup', handlePointerUp);
        c.addEventListener('wheel', handleWheel, { passive: false });
        c.addEventListener('touchstart', handlePointerDown, { passive: false });
        c.addEventListener('touchmove', handlePointerMove, { passive: false });
        c.addEventListener('touchend', handlePointerUp);
    }

    function removeZoomAndPan() {
        const c = document.getElementById('imageContainer');
        c.removeEventListener('mousedown', handlePointerDown);
        c.removeEventListener('mousemove', handlePointerMove);
        c.removeEventListener('mouseup', handlePointerUp);
        c.removeEventListener('wheel', handleWheel);
        c.removeEventListener('touchstart', handlePointerDown);
        c.removeEventListener('touchmove', handlePointerMove);
        c.removeEventListener('touchend', handlePointerUp);
    }

    // =========================================================================
    // 15. 足迹编辑 / 删除 / 碎碎念 / 设置
    // =========================================================================
    let editingPostId = null, editingTags = [], editingImages = [];
    let quickNotePostId = null, quickNoteAuthor = 'heng';

    function openEditPostModal(postId, event) {
        if (event) event.stopPropagation();
        if (!GITHUB_TOKEN) { showToast("未配置Token，预览模式无法编辑哦 💡"); return; }
        const post = (travelData.posts || []).find(p => p.id === postId);
        if (!post) return;

        editingPostId = postId;
        editingTags = [...(post.tags || [])];
        editingImages = getPostImages(post).map(img => ({ ...img, isNew: false }));

        const provSel = document.getElementById('editFormProvince');
        provSel.innerHTML = CHINA_REGIONS.map(p => `<option value="${p.prov}">${p.prov}</option>`).join('');
        const normCity = normalizeCityName(post.city);
        const meta = CITY_MAP_BY_NAME[normCity];
        provSel.value = post.province || (meta ? meta.province : CHINA_REGIONS[0].prov);
        onEditProvinceChange(normCity);

        document.getElementById('editFormDate').value = post.tripDate || new Date(post.time || Date.now()).toISOString().split('T')[0];
        document.getElementById('editFormDesc').value = post.description || '';
        document.getElementById('editNoteHeng').value = (post.notes && post.notes.heng) || '';
        document.getElementById('editNoteQin').value = (post.notes && post.notes.qin) || '';

        renderEditTagsUI();
        renderEditImagesUI();
        document.getElementById('editPostModal').classList.remove('hidden');
    }

    function onEditProvinceChange(targetCity) {
        const provObj = CHINA_REGIONS.find(p => p.prov === document.getElementById('editFormProvince').value) || CHINA_REGIONS[0];
        const citySel = document.getElementById('editFormCity');
        citySel.innerHTML = provObj.cities.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
        if (targetCity && provObj.cities.some(c => c.name === targetCity)) citySel.value = targetCity;
    }

    function renderEditTagsUI() {
        document.getElementById('editTagsWrap').innerHTML = TAG_OPTIONS.map(t => {
            const active = editingTags.includes(t.key);
            return `<button type="button" onclick="toggleEditTag('${t.key}')" class="px-2.5 py-1 rounded-full text-11 font-bold border ${active ? 'bg-rose-500 text-white border-rose-500 shadow-xs' : 'bg-white text-gray-500 border-rose-100'}">${t.icon} ${t.key}</button>`;
        }).join('');
    }

    function toggleEditTag(tagKey) {
        if (editingTags.includes(tagKey)) editingTags = editingTags.filter(t => t !== tagKey);
        else editingTags.push(tagKey);
        renderEditTagsUI();
    }

    function handleEditAddImages(event) {
        const files = Array.from(event.target.files || []);
        const remain = 9 - editingImages.length;
        if (remain <= 0) { showToast("最多保留 9 张照片哦 📸"); event.target.value = ''; return; }
        files.slice(0, remain).forEach(file => {
            editingImages.push({ isNew: true, file, objectUrl: URL.createObjectURL(file) });
        });
        event.target.value = '';
        renderEditImagesUI();
    }

    function renderEditImagesUI() {
        document.getElementById('editPhotoCountLabel').innerText = `${editingImages.length}/9`;
        const wrap = document.getElementById('editImagesWrap');
        let html = editingImages.map((img, idx) => {
            const src = img.isNew ? img.objectUrl : (ThumbCacheDB.peek(img.thumbUrl || img.url) || img.thumbUrl || img.url);
            return `
                <div class="relative aspect-square rounded-xl overflow-hidden border border-rose-100 bg-rose-50">
                    <img src="${src}" class="w-full h-full object-cover">
                    ${idx === 0
                        ? '<span class="absolute bottom-1 left-1 bg-rose-500 text-white text-9 font-bold px-1.5 py-0.5 rounded-full">封面</span>'
                        : `<button type="button" onclick="setEditCoverImage(${idx})" class="absolute bottom-1 left-1 bg-black-60 text-white text-9 font-bold px-1.5 py-0.5 rounded-full">设封面</button>`
                    }
                    ${editingImages.length > 1 ? `<button type="button" onclick="removeEditPostImage(${idx})" class="absolute top-1 right-1 w-5 h-5 rounded-full bg-black-60 text-white text-xs font-bold flex items-center justify-center">×</button>` : ''}
                </div>
            `;
        }).join('');

        if (editingImages.length < 9) {
            html += `
                <div onclick="document.getElementById('editAddImageInput').click()" class="aspect-square rounded-xl border-2 border-dashed border-rose-300 bg-white flex flex-col items-center justify-center cursor-pointer text-rose-400">
                    <span class="text-xl leading-none font-bold">+</span>
                    <span class="text-10 mt-0.5 font-bold">追加照片</span>
                </div>
            `;
        }
        wrap.innerHTML = html;
    }

    function setEditCoverImage(idx) {
        if (idx <= 0 || idx >= editingImages.length) return;
        const [it] = editingImages.splice(idx, 1);
        editingImages.unshift(it);
        renderEditImagesUI();
    }

    function removeEditPostImage(idx) {
        if (editingImages.length <= 1) { showToast("至少保留 1 张照片哦 📸"); return; }
        const [rem] = editingImages.splice(idx, 1);
        if (rem && rem.isNew && rem.objectUrl) URL.revokeObjectURL(rem.objectUrl);
        renderEditImagesUI();
    }

    function closeEditPostModal() {
        editingImages.forEach(it => { if (it.isNew && it.objectUrl) URL.revokeObjectURL(it.objectUrl); });
        document.getElementById('editPostModal').classList.add('hidden');
        editingPostId = null;
    }

    async function saveEditedPost() {
        const targetId = editingPostId;
        if (!targetId) return;
        const btn = document.getElementById('saveEditPostBtn');
        btn.disabled = true;
        btn.innerText = '正在保存...';

        try {
            const finalImages = [];
            for (let i = 0; i < editingImages.length; i++) {
                const img = editingImages[i];
                if (img.isNew) {
                    btn.innerText = `上传追加照片...`;
                    const pair = await compressImagePair(img.objectUrl);
                    const thumbUrl = await uploadMediaToGithubWithProgress(pair.thumbBase64, 'jpg', 'travel', `thumb_add_${i}`);
                    const url = await uploadMediaToGithubWithProgress(pair.hdBase64, 'jpg', 'travel', `origin_add_${i}`);
                    finalImages.push({ url, thumbUrl });
                } else {
                    finalImages.push({ url: img.url, thumbUrl: img.thumbUrl });
                }
            }

            const newProv = document.getElementById('editFormProvince').value;
            const newCity = document.getElementById('editFormCity').value;
            const meta = CITY_MAP_BY_NAME[newCity];
            const newDate = document.getElementById('editFormDate').value;
            const newDesc = document.getElementById('editFormDesc').value.trim();
            const newNotes = {
                heng: document.getElementById('editNoteHeng').value.trim(),
                qin: document.getElementById('editNoteQin').value.trim()
            };

            const upRes = await mutateAndSync(data => {
                const p = (data.posts || []).find(x => x.id === targetId);
                if (!p) return;
                p.province = newProv; p.city = newCity;
                if (meta) { p.lat = meta.lat; p.lng = meta.lng; }
                p.tripDate = newDate || p.tripDate;
                p.description = newDesc;
                p.tags = [...editingTags];
                p.notes = newNotes;
                p.images = finalImages;
                if (finalImages[0]) { p.url = finalImages[0].url; p.thumbUrl = finalImages[0].thumbUrl; }
            });

            if (upRes.success) {
                closeEditPostModal();
                refreshAllViews();
                if (!document.getElementById('cityAlbumModal').classList.contains('hidden')) {
                    openCityInteraction(newProv, newCity);
                }
                showToast("足迹已更新并同步 ✨");
            } else {
                showToast("保存失败，请检查网络 ❌");
            }
        } catch (e) {
            showToast("追加照片上传失败，请重试 ❌");
        } finally {
            btn.disabled = false;
            btn.innerText = '保存修改 ✨';
        }
    }

    async function deleteTravelPost(postId, event) {
        if (event) event.stopPropagation();
        if (!GITHUB_TOKEN) { showToast("未配置Token，预览模式无法删除哦 💡"); return; }
        if (!confirm("确定要删除这篇旅行足迹吗？删除后无法恢复哦~")) return;

        showToast("正在删除并同步...");
        const upRes = await mutateAndSync(data => {
            data.posts = (data.posts || []).filter(p => p.id !== postId);
        });
        if (upRes.success) {
            refreshAllViews();
            if (!document.getElementById('cityAlbumModal').classList.contains('hidden') && currentAlbumCluster) {
                openCityInteraction(currentAlbumCluster.province, currentAlbumCluster.cities[0]);
            }
            showToast("已删除该条旅行足迹 🗑️");
        } else {
            showToast("删除失败，请检查网络 ❌");
        }
    }

    function openQuickNoteModal(postId, event) {
        if (event) event.stopPropagation();
        if (!GITHUB_TOKEN) { showToast("未配置Token，预览模式无法留言哦 💡"); return; }
        const post = (travelData.posts || []).find(p => p.id === postId);
        if (!post) return;
        quickNotePostId = postId;
        quickNoteAuthor = myIdentity.includes('亲') ? 'qin' : 'heng';
        document.getElementById('quickNoteTitle').innerText = `📍 ${post.city} · 双人碎碎念`;
        selectQuickNoteAuthor(quickNoteAuthor);
        document.getElementById('quickNoteModal').classList.remove('hidden');
    }

    function selectQuickNoteAuthor(who) {
        quickNoteAuthor = who;
        const post = (travelData.posts || []).find(p => p.id === quickNotePostId);
        document.getElementById('qnBtnHeng').className = who === 'heng'
            ? "flex-1 py-1.5 rounded-full text-xs font-bold bg-sky-500 text-white shadow-xs"
            : "flex-1 py-1.5 rounded-full text-xs font-bold text-sky-600";
        document.getElementById('qnBtnQin').className = who === 'qin'
            ? "flex-1 py-1.5 rounded-full text-xs font-bold bg-rose-500 text-white shadow-xs"
            : "flex-1 py-1.5 rounded-full text-xs font-bold text-rose-500";
        document.getElementById('quickNoteInput').value = (post && post.notes && post.notes[who]) || '';
    }

    function closeQuickNoteModal() {
        document.getElementById('quickNoteModal').classList.add('hidden');
        quickNotePostId = null;
    }

    async function saveQuickNote() {
        const targetId = quickNotePostId, author = quickNoteAuthor;
        if (!targetId) return;
        const text = document.getElementById('quickNoteInput').value.trim();
        const btn = document.getElementById('saveQuickNoteBtn');
        btn.disabled = true; btn.innerText = '保存中...';

        const upRes = await mutateAndSync(data => {
            const p = (data.posts || []).find(x => x.id === targetId);
            if (!p) return;
            if (!p.notes) p.notes = {};
            p.notes[author] = text;
        });

        btn.disabled = false; btn.innerText = '保存碎碎念 💌';
        if (upRes.success) {
            closeQuickNoteModal();
            refreshAllViews();
            if (!document.getElementById('cityAlbumModal').classList.contains('hidden') && currentAlbumCluster) {
                openCityInteraction(currentAlbumCluster.province, currentAlbumCluster.cities[0]);
            }
            showToast(`${author === 'heng' ? '哼哼' : '亲亲'}的碎碎念已保存 💌`);
        } else {
            showToast("保存失败，请检查网络 ❌");
        }
    }

    function openSettingsModal() {
        const opts = [
            `<option value="CUSTOM_YONGAN">福建省永安市（默认）</option>`,
            ...ALL_CITIES_FLAT.map(c => `<option value="${c.city}">${c.provShort} · ${c.city}</option>`)
        ].join('');
        const hSel = document.getElementById('settingHengCity');
        const qSel = document.getElementById('settingQinCity');
        hSel.innerHTML = opts;
        qSel.innerHTML = opts;
        hSel.value = HOME_BASES.heng.shortCity === '永安' ? 'CUSTOM_YONGAN' : (CITY_MAP_BY_NAME[HOME_BASES.heng.shortCity] ? CITY_MAP_BY_NAME[HOME_BASES.heng.shortCity].city : 'CUSTOM_YONGAN');
        qSel.value = CITY_MAP_BY_NAME[HOME_BASES.qin.shortCity] ? CITY_MAP_BY_NAME[HOME_BASES.qin.shortCity].city : '东莞市';
        document.getElementById('settingsModal').classList.remove('hidden');
    }
    function closeSettingsModal() { document.getElementById('settingsModal').classList.add('hidden'); }

    function saveHomeBaseSettings() {
        function resolveBase(val, name) {
            if (val === 'CUSTOM_YONGAN') return { name, city: "福建省永安市", shortCity: "永安", lat: 25.9414, lng: 117.3651 };
            const meta = CITY_MAP_BY_NAME[val];
            if (!meta) return DEFAULT_HOME_BASES.heng;
            return { name, city: `${meta.province}${meta.city}`, shortCity: meta.shortCity, lat: meta.lat, lng: meta.lng };
        }
        HOME_BASES = {
            heng: resolveBase(document.getElementById('settingHengCity').value, '哼哼'),
            qin: resolveBase(document.getElementById('settingQinCity').value, '亲亲')
        };
        localStorage.setItem(HOME_BASES_KEY, JSON.stringify(HOME_BASES));
        updateHomeBaseLabels();
        updateDistanceUI();
        renderRouteLines();
        closeSettingsModal();
        showToast(`常驻地已更新：${HOME_BASES.heng.shortCity} ⇄ ${HOME_BASES.qin.shortCity} ✨`);
    }

    async function manualSyncNow() {
        closeSettingsModal();
        showToast("正在同步云端最新足迹...");
        const updated = await fetchTravelData(true);
        if (updated) {
            await loadVisitedProvincesCityGeo();
            refreshAllViews();
            showToast("已同步到最新云端足迹 ✨");
        } else {
            showToast("当前已是最新数据 ✅");
        }
    }

    async function clearGeoCacheNow() {
        await GeoCacheDB.clear();
        closeSettingsModal();
        showToast("地图缓存已清理，下次打开将重新拉取 🧹");
    }

    function escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function showToast(msg) {
        const toast = document.getElementById('toast');
        if (toastTimer) clearTimeout(toastTimer);
        toast.innerText = msg;
        toast.classList.remove('hidden', 'toast-animate');
        void toast.offsetWidth;
        toast.classList.add('toast-animate');
        toastTimer = setTimeout(() => {
            toast.classList.add('hidden');
            toast.classList.remove('toast-animate');
        }, 2600);
    }

    // iOS Standalone PWA 内部无感跳转拦截器
    document.addEventListener("click", function(e) {
        var a = e.target.closest("a");
        if (!a) return;
        var href = a.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("javascript:") || a.getAttribute("target") === "_blank") return;
        if (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
            e.preventDefault();
            window.location.href = href;
        }
    });

    // 暴露全局交互接口与懒加载桥接对象
    Object.assign(global, {
        switchMainTab, openVisitedModal, closeVisitedModal, toggleVisitedOnlyLit, renderVisitedModalList,
        resetMapView, openDistanceModal, closeDistanceModal, setDistanceMode, selectDistYear, toggleTripShared,
        launchFootprintReplay, launchAnnualReportModal, toggleMapToolsMenu, closeMapToolsMenu,
        toggleLabelMode, toggleRouteLines, toggleCityBoundaries, mapZoomIn, mapZoomOut,
        handleMapCitySearch, clearMapCitySearch, flyToSearchedCity, openCityInteraction,
        switchAlbumTagFilter, closeCityAlbumModal, jumpToUploadWithCity,
        switchCityFilter, switchWallTagFilter, onWallFilterChange, appendNextWallPage, locatePostOnMap,
        handleImageSelect, setUploadCover, removeUploadImage, clearImage, toggleUploadTag,
        onProvinceChange, quickMatchCity, selectCityInForm, saveUploadDraft, submitTravelPost,
        toggleLike, openImageViewer, viewerPrevImage, viewerNextImage, downloadViewerImage, closeImageViewer,
        openEditPostModal, onEditProvinceChange, toggleEditTag, handleEditAddImages, setEditCoverImage,
        removeEditPostImage, closeEditPostModal, saveEditedPost, deleteTravelPost,
        openQuickNoteModal, selectQuickNoteAuthor, closeQuickNoteModal, saveQuickNote,
        openSettingsModal, closeSettingsModal, saveHomeBaseSettings, manualSyncNow, clearGeoCacheNow,
        isRouteVisible: false
    });

    Object.defineProperty(global, 'isRouteVisible', {
        get: () => isRouteVisible
    });

    global.TravelApp = {
        map: () => map,
        layers: () => ({ marker: markerLayerGroup, route: routeLayerGroup, replay: replayLayerGroup }),
        getPosts: () => travelData.posts || [],
        getPostImages,
        getHomeBases: () => HOME_BASES,
        isRoundTrip: () => isRoundTripMode,
        computeTravelDistanceSummary,
        fitChinaBoundsOnMobile,
        renderRouteLines,
        renderApplePhotoMarkers,
        ThumbCacheDB,
        showToast
    };
})(window);
