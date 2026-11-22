// LovePlan Travel Extras: Lazy-loaded Footprint Replay Engine + Annual Report & Poster Export
(function(global) {
    'use strict';

    // =========================================================================
    // 1. 双向奔赴「时光回放」引擎（SVG 零错位航线 + 双层流光 + 全局/跟随双视角 + 年份筛选）
    // =========================================================================
    let replaySvgRenderer = null;
    let replayState = {
        active: false,
        paused: false,
        allTrips: [],
        trips: [],
        yearFilter: 'ALL',
        cameraMode: 'follow',
        index: -1,
        speed: 1,
        timer: null,
        animFrames: [],
        activeArcLines: [],
        historyArcLines: [],
        activeRippleMarker: null,
        hengCum: 0,
        qinCum: 0
    };

    function buildSmoothArcPoints(lat1, lng1, lat2, lng2, bend = 0.16, steps = 40) {
        const pts = [];
        const midLat = (lat1 + lat2) / 2;
        const midLng = (lng1 + lng2) / 2;
        const dx = lng2 - lng1;
        const dy = lat2 - lat1;
        const ctrlLat = midLat + dx * bend;
        const ctrlLng = midLng - dy * bend;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const lat = (1 - t) * (1 - t) * lat1 + 2 * (1 - t) * t * ctrlLat + t * t * lat2;
            const lng = (1 - t) * (1 - t) * lng1 + 2 * (1 - t) * t * ctrlLng + t * t * lng2;
            pts.push([lat, lng]);
        }
        return pts;
    }

    function onReplayMapZoomEnd() {
        if (!replayState.active) return;
        (replayState.activeArcLines || []).forEach(item => {
            if (item.line && item.line._path) {
                item.line._path.style.transition = 'none';
                item.line._path.style.strokeDasharray = item.dash || '';
                item.line._path.style.strokeDashoffset = '0';
            }
        });
    }

    function startFootprintReplay(yearFilter = 'ALL') {
        const ctx = global.TravelApp;
        if (!ctx || !ctx.map()) return;
        const summary = ctx.computeTravelDistanceSummary();
        if (!summary.trips || summary.trips.length === 0) {
            ctx.showToast("还没有旅行记录可以回放哦，快去点亮第一座城市吧 ✈️");
            return;
        }

        stopFootprintReplay(false);

        const allPosts = ctx.getPosts();
        const allChrono = [...summary.trips].sort((a, b) => a.startTs - b.startTs);
        allChrono.forEach(t => {
            const matched = allPosts.find(p =>
                normalizeCityName(p.city) === t.city &&
                (p.tripDate === t.dateStr || Math.abs((p.time || 0) - t.startTs) < 15 * 86400000)
            ) || allPosts.find(p => normalizeCityName(p.city) === t.city);
            const imgs = matched ? ctx.getPostImages(matched) : [];
            t.postId = matched ? matched.id : null;
            t.coverThumb = imgs[0] ? (imgs[0].thumbUrl || imgs[0].url) : '';
            t.coverFull = imgs[0] ? (imgs[0].url || imgs[0].thumbUrl) : '';
            t.story = matched ? (matched.description || '在这里留下了美好的足迹 ✨') : '在这里留下了美好的足迹 ✨';
        });

        const filtered = yearFilter === 'ALL'
            ? allChrono
            : allChrono.filter(t => (t.dateStr || '').startsWith(yearFilter));
        const tripsToPlay = filtered.length > 0 ? filtered : allChrono;
        const actualYear = filtered.length > 0 ? yearFilter : 'ALL';

        replayState = {
            active: true,
            paused: false,
            allTrips: allChrono,
            trips: tripsToPlay,
            yearFilter: actualYear,
            cameraMode: replayState.cameraMode || 'follow',
            index: -1,
            speed: replayState.speed || 1,
            timer: null,
            animFrames: [],
            activeArcLines: [],
            historyArcLines: [],
            activeRippleMarker: null,
            hengCum: 0,
            qinCum: 0
        };

        const map = ctx.map();
        const layers = ctx.layers();
        if (layers.marker && map.hasLayer(layers.marker)) map.removeLayer(layers.marker);
        if (layers.route && map.hasLayer(layers.route)) map.removeLayer(layers.route);
        if (!replaySvgRenderer) replaySvgRenderer = L.svg({ padding: 0.6 });
        if (!layers.replay) {
            layers.replay = L.layerGroup().addTo(map);
        } else {
            layers.replay.clearLayers();
            layers.replay.addTo(map);
        }

        map.off('zoomend', onReplayMapZoomEnd);
        map.on('zoomend', onReplayMapZoomEnd);

        addReplayHomePins();
        renderReplayYearTabs();
        renderReplayStepDots(0);

        document.getElementById('replayHud').classList.remove('hidden');
        document.getElementById('mapSearchBoxWrap').classList.add('hidden');
        document.getElementById('replayPauseBtn').innerText = '⏸';
        document.getElementById('replaySpeedBtn').innerText = replayState.speed + 'x';
        document.getElementById('replayCamModeBtn').innerText = replayState.cameraMode === 'overview' ? '🗺️ 全局' : '🎯 跟随';
        document.getElementById('replayHengKm').innerText = '0';
        document.getElementById('replayQinKm').innerText = '0';

        if (replayState.cameraMode === 'overview') {
            ctx.fitChinaBoundsOnMobile(true);
        }

        ctx.showToast(actualYear === 'ALL' ? "🎬 开始双向奔赴时光回放！" : `🎬 开始回放 ${actualYear} 年足迹！`);
        playReplayStep(0);
    }

    function addReplayHomePins() {
        const ctx = global.TravelApp;
        const replayLayer = ctx.layers().replay;
        if (!replayLayer) return;
        const bases = ctx.getHomeBases();
        const hengIcon = L.divIcon({ className: 'geo-label-wrapper', html: `<span class="home-pin-badge home-pin-heng">👦 ${bases.heng.shortCity}</span>`, iconSize: [0, 0] });
        const qinIcon = L.divIcon({ className: 'geo-label-wrapper', html: `<span class="home-pin-badge home-pin-qin">👧 ${bases.qin.shortCity}</span>`, iconSize: [0, 0] });
        L.marker([bases.heng.lat, bases.heng.lng], { icon: hengIcon, interactive: false, zIndexOffset: 300 }).addTo(replayLayer);
        L.marker([bases.qin.lat, bases.qin.lng], { icon: qinIcon, interactive: false, zIndexOffset: 300 }).addTo(replayLayer);
    }

    function renderReplayYearTabs() {
        const wrap = document.getElementById('replayYearTabs');
        if (!wrap) return;
        const years = Array.from(new Set((replayState.allTrips || []).map(t => (t.dateStr || '').slice(0, 4)).filter(y => /^\d{4}$/.test(y)))).sort((a, b) => b.localeCompare(a));
        const items = [{ val: 'ALL', label: '全部' }, ...years.map(y => ({ val: y, label: y }))];
        wrap.innerHTML = items.map(it => `
            <button onclick="switchReplayYear('${it.val}')" class="px-2 py-0.5 rounded-full text-10 font-bold whitespace-nowrap transition-all ${replayState.yearFilter === it.val ? 'bg-rose-500 text-white shadow-xs' : 'bg-rose-50 text-rose-500'}">${it.label}</button>
        `).join('');
    }

    function switchReplayYear(y) {
        if (!replayState.active) return;
        startFootprintReplay(y);
    }

    function renderReplayStepDots(activeIdx) {
        const wrap = document.getElementById('replayStepDots');
        if (!wrap) return;
        wrap.innerHTML = (replayState.trips || []).map((t, idx) => {
            const cls = idx === activeIdx ? 'active' : (idx < activeIdx ? 'passed' : '');
            return `<button type="button" onclick="jumpToReplayStep(${idx})" title="${t.dateStr} ${t.city}" class="replay-dot-btn ${cls}"></button>`;
        }).join('');
    }

    function jumpToReplayStep(idx) {
        if (!replayState.active) return;
        clearTimeout(replayState.timer);
        replayState.paused = true;
        document.getElementById('replayPauseBtn').innerText = '▶';
        playReplayStep(idx);
    }

    function toggleReplayCameraMode() {
        const ctx = global.TravelApp;
        if (!replayState.active || !ctx) return;
        const map = ctx.map();
        const bases = ctx.getHomeBases();
        replayState.cameraMode = replayState.cameraMode === 'follow' ? 'overview' : 'follow';
        document.getElementById('replayCamModeBtn').innerText = replayState.cameraMode === 'overview' ? '🗺️ 全局' : '🎯 跟随';
        if (replayState.cameraMode === 'overview') {
            ctx.fitChinaBoundsOnMobile(true);
            ctx.showToast("已切换至全国总览视角 🗺️");
        } else {
            const cur = replayState.trips[replayState.index];
            if (cur && map) {
                const bounds = L.latLngBounds([
                    [bases.heng.lat, bases.heng.lng],
                    [bases.qin.lat, bases.qin.lng],
                    [cur.lat, cur.lng]
                ]);
                map.flyToBounds(bounds.pad(0.28), { maxZoom: 6.2, duration: 0.65 });
            }
            ctx.showToast("已切换至镜头跟随视角 🎯");
        }
    }

    function openReplayCurrentImage() {
        const cur = replayState.trips && replayState.trips[replayState.index];
        if (!cur || !cur.coverThumb) return;
        if (!replayState.paused) toggleReplayPause();
        global.openImageViewer(cur.coverThumb, cur.coverFull || cur.coverThumb, cur.postId, 0);
    }

    function openReplayCityAlbum() {
        const cur = replayState.trips && replayState.trips[replayState.index];
        if (!cur) return;
        if (!replayState.paused) toggleReplayPause();
        global.openCityInteraction(cur.province, cur.city);
    }

    function addAnimatedSvgArc(points, color, durationMs) {
        const replayLayer = global.TravelApp.layers().replay;
        if (!replayLayer || !points.length) return;

        const glowLine = L.polyline(points, {
            color, weight: 6, opacity: 0.2, lineCap: 'round', interactive: false, renderer: replaySvgRenderer
        }).addTo(replayLayer);

        const mainLine = L.polyline(points, {
            color, weight: 2.6, opacity: 0.94, lineCap: 'round', interactive: false, renderer: replaySvgRenderer
        }).addTo(replayLayer);

        const triggerStrokeAnim = () => {
            if (!replayState.active || !mainLine._path) return;
            try {
                [mainLine, glowLine].forEach(ln => {
                    if (!ln._path) return;
                    const len = ln._path.getTotalLength();
                    if (len > 0) {
                        ln._path.style.transition = 'none';
                        ln._path.style.strokeDasharray = `${len} ${len}`;
                        ln._path.style.strokeDashoffset = `${len}`;
                        ln._path.getBoundingClientRect();
                        ln._path.style.transition = `stroke-dashoffset ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
                        ln._path.style.strokeDashoffset = '0';
                    }
                });
            } catch (e) {}
        };

        requestAnimationFrame(triggerStrokeAnim);
        replayState.activeArcLines.push({ line: mainLine, glow: glowLine, dash: '' });
    }

    function demoteActiveArcsToHistory() {
        const replayLayer = global.TravelApp.layers().replay;
        (replayState.activeArcLines || []).forEach(item => {
            if (item.glow && replayLayer) replayLayer.removeLayer(item.glow);
            if (item.line) {
                if (item.line._path) {
                    item.line._path.style.transition = 'none';
                    item.line._path.style.strokeDasharray = '4, 6';
                    item.line._path.style.strokeDashoffset = '0';
                }
                item.line.setStyle({ weight: 1.4, opacity: 0.26, dashArray: '4, 6' });
                replayState.historyArcLines.push(item.line);
            }
        });
        replayState.activeArcLines = [];
        if (replayState.activeRippleMarker && replayLayer) {
            replayLayer.removeLayer(replayState.activeRippleMarker);
            replayState.activeRippleMarker = null;
        }
    }

    function animateMileageCounter(elId, fromVal, toVal, durationMs = 700) {
        const el = document.getElementById(elId);
        if (!el) return;
        const startTime = performance.now();
        function tick(now) {
            const p = Math.min(1, (now - startTime) / durationMs);
            const eased = 1 - Math.pow(1 - p, 3);
            el.innerText = Math.round(fromVal + (toVal - fromVal) * eased).toLocaleString();
            if (p < 1) {
                replayState.animFrames.push(requestAnimationFrame(tick));
            }
        }
        replayState.animFrames.push(requestAnimationFrame(tick));
    }

    function rebuildReplayUpTo(stepIdx) {
        const ctx = global.TravelApp;
        const replayLayer = ctx.layers().replay;
        const bases = ctx.getHomeBases();
        replayLayer.clearLayers();
        replayState.activeArcLines = [];
        replayState.historyArcLines = [];
        replayState.activeRippleMarker = null;
        addReplayHomePins();

        replayState.hengCum = 0;
        replayState.qinCum = 0;
        for (let i = 0; i < stepIdx; i++) {
            const pt = replayState.trips[i];
            replayState.hengCum += pt.hengKm;
            replayState.qinCum += pt.qinKm;
            if (pt.hengKm > 0) {
                const lH = L.polyline(buildSmoothArcPoints(bases.heng.lat, bases.heng.lng, pt.lat, pt.lng, 0.16), {
                    color: '#0284c7', weight: 1.4, opacity: 0.26, dashArray: '4, 6', interactive: false, renderer: replaySvgRenderer
                }).addTo(replayLayer);
                replayState.historyArcLines.push(lH);
            }
            if (pt.qinKm > 0) {
                const lQ = L.polyline(buildSmoothArcPoints(bases.qin.lat, bases.qin.lng, pt.lat, pt.lng, -0.16), {
                    color: '#e11d48', weight: 1.4, opacity: 0.26, dashArray: '4, 6', interactive: false, renderer: replaySvgRenderer
                }).addTo(replayLayer);
                replayState.historyArcLines.push(lQ);
            }
            drawStaticReplayStop(pt, false);
        }
    }

    function playReplayStep(stepIdx) {
        const ctx = global.TravelApp;
        if (!replayState.active || !ctx) return;
        clearTimeout(replayState.timer);

        const trips = replayState.trips;
        if (stepIdx < 0) stepIdx = 0;
        if (stepIdx >= trips.length) {
            replayState.paused = true;
            document.getElementById('replayPauseBtn').innerText = '↻';
            ctx.showToast("🎉 全部双向奔赴足迹回放完毕！");
            return;
        }

        if (stepIdx !== replayState.index + 1) {
            rebuildReplayUpTo(stepIdx);
        } else {
            demoteActiveArcsToHistory();
        }

        replayState.index = stepIdx;
        const trip = trips[stepIdx];
        const bases = ctx.getHomeBases();
        const prevHeng = replayState.hengCum;
        const prevQin = replayState.qinCum;
        replayState.hengCum += trip.hengKm;
        replayState.qinCum += trip.qinKm;

        document.getElementById('replayStepBadge').innerText = `${stepIdx + 1}/${trips.length}`;
        document.getElementById('replayCityTitle').innerText = trip.city;
        document.getElementById('replayDateText').innerText = trip.dateStr;
        document.getElementById('replayStoryText').innerText = trip.story;
        document.getElementById('replayTripDelta').innerHTML = trip.sharedDeparture
            ? `<span class="text-amber-600">🤝 共同出发行程</span>`
            : `<span class="text-sky-600">${bases.heng.shortCity} +${trip.hengKm.toLocaleString()}km</span><span class="text-gray-300">·</span><span class="text-rose-500">${bases.qin.shortCity} +${trip.qinKm.toLocaleString()}km</span>`;

        const thumbEl = document.getElementById('replayThumbImg');
        if (trip.coverThumb) {
            ctx.ThumbCacheDB.resolveUrl(trip.coverThumb).then(bUrl => {
                thumbEl.src = bUrl || trip.coverThumb;
            });
            thumbEl.classList.remove('hidden');
        } else {
            thumbEl.classList.add('hidden');
        }

        document.getElementById('replayProgressBar').style.width = `${Math.round(((stepIdx + 1) / trips.length) * 100)}%`;
        renderReplayStepDots(stepIdx);

        animateMileageCounter('replayHengKm', prevHeng, replayState.hengCum, 750);
        animateMileageCounter('replayQinKm', prevQin, replayState.qinCum, 750);

        const map = ctx.map();
        if (replayState.cameraMode === 'follow') {
            const bounds = L.latLngBounds([
                [bases.heng.lat, bases.heng.lng],
                [bases.qin.lat, bases.qin.lng],
                [trip.lat, trip.lng]
            ]);
            map.flyToBounds(bounds.pad(0.28), { maxZoom: 6.2, duration: 0.75 / replayState.speed });
        }

        const arcDur = Math.round(950 / replayState.speed);
        if (trip.hengKm > 0) {
            addAnimatedSvgArc(buildSmoothArcPoints(bases.heng.lat, bases.heng.lng, trip.lat, trip.lng, 0.16), '#0284c7', arcDur);
        }
        if (trip.qinKm > 0) {
            addAnimatedSvgArc(buildSmoothArcPoints(bases.qin.lat, bases.qin.lng, trip.lat, trip.lng, -0.16), '#e11d48', arcDur);
        }

        const replayLayer = ctx.layers().replay;
        const rippleIcon = L.divIcon({ className: 'geo-label-wrapper', html: `<div class="replay-ripple-ring"></div>`, iconSize: [0, 0] });
        replayState.activeRippleMarker = L.marker([trip.lat, trip.lng], { icon: rippleIcon, interactive: false, zIndexOffset: 280 }).addTo(replayLayer);
        drawStaticReplayStop(trip, true);

        if (!replayState.paused) {
            replayState.timer = setTimeout(() => {
                playReplayStep(stepIdx + 1);
            }, Math.round(3100 / replayState.speed));
        }
    }

    function drawStaticReplayStop(trip, highlight = false) {
        const ctx = global.TravelApp;
        const replayLayer = ctx.layers().replay;
        if (!replayLayer) return;
        const shortCity = trip.city.replace(/(市|自治州|地区|盟|特别行政区)$/g, '');
        const resolvedSrc = ctx.ThumbCacheDB.peek(trip.coverThumb) || trip.coverThumb;
        const html = trip.coverThumb
            ? `<div class="apple-photo-marker ${highlight ? 'replay-pulse-pin' : ''}" style="--marker-size: ${highlight ? 42 : 34}px;">
                    <div class="apple-photo-frame"><img src="${resolvedSrc}" alt="${shortCity}" decoding="async"></div>
                    <div class="apple-photo-pointer"></div>
                    <div class="apple-photo-city-label">${shortCity}</div>
               </div>`
            : `<span class="geo-label-capital visited"><span class="dot"></span>${shortCity}</span>`;
        const size = highlight ? 42 : 34;
        const icon = L.divIcon({
            className: 'apple-marker-wrapper',
            html,
            iconSize: trip.coverThumb ? [size, size] : [0, 0],
            iconAnchor: trip.coverThumb ? [size / 2, size] : [0, 0]
        });
        const m = L.marker([trip.lat, trip.lng], { icon, zIndexOffset: highlight ? 500 : 320 });
        m.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            if (!replayState.paused) toggleReplayPause();
            global.openCityInteraction(trip.province, trip.city);
        });
        m.addTo(replayLayer);
    }

    function toggleReplayPause() {
        if (!replayState.active) return;
        if (replayState.index >= replayState.trips.length - 1 && replayState.paused) {
            startFootprintReplay(replayState.yearFilter);
            return;
        }
        replayState.paused = !replayState.paused;
        document.getElementById('replayPauseBtn').innerText = replayState.paused ? '▶' : '⏸';
        if (replayState.paused) {
            clearTimeout(replayState.timer);
        } else {
            playReplayStep(replayState.index + 1);
        }
    }

    function stepReplay(delta) {
        if (!replayState.active) return;
        clearTimeout(replayState.timer);
        const nextIdx = Math.max(0, Math.min(replayState.trips.length - 1, replayState.index + delta));
        replayState.paused = true;
        document.getElementById('replayPauseBtn').innerText = '▶';
        playReplayStep(nextIdx);
    }

    function toggleReplaySpeed() {
        replayState.speed = replayState.speed === 1 ? 1.5 : (replayState.speed === 1.5 ? 2 : 1);
        document.getElementById('replaySpeedBtn').innerText = replayState.speed + 'x';
    }

    function stopFootprintReplay(restoreView = true) {
        const ctx = global.TravelApp;
        clearTimeout(replayState.timer);
        (replayState.animFrames || []).forEach(id => cancelAnimationFrame(id));
        replayState.active = false;
        replayState.paused = false;
        replayState.animFrames = [];
        replayState.activeArcLines = [];
        replayState.historyArcLines = [];
        replayState.activeRippleMarker = null;

        const map = ctx && ctx.map();
        const layers = ctx && ctx.layers();
        if (map) map.off('zoomend', onReplayMapZoomEnd);

        const hud = document.getElementById('replayHud');
        if (hud) hud.classList.add('hidden');
        const searchWrap = document.getElementById('mapSearchBoxWrap');
        if (searchWrap) searchWrap.classList.remove('hidden');

        if (layers && layers.replay && map) {
            layers.replay.clearLayers();
            if (map.hasLayer(layers.replay)) map.removeLayer(layers.replay);
        }
        if (map && restoreView && layers) {
            if (layers.route && !map.hasLayer(layers.route)) layers.route.addTo(map);
            if (layers.marker && !map.hasLayer(layers.marker)) layers.marker.addTo(map);
            ctx.renderRouteLines();
            ctx.renderApplePhotoMarkers(true);
            ctx.fitChinaBoundsOnMobile(true);
        }
    }

    // =========================================================================
    // 2. 年度 / 周年旅行总结卡 & 高清 Canvas 长图海报（支持自定义标题与照片拼贴）
    // =========================================================================
    let selectedReportYear = 'ALL';
    let lastReportStats = null;

    function openAnnualReportModal() {
        const ctx = global.TravelApp;
        const posts = ctx.getPosts();
        const yearsSet = new Set();
        posts.forEach(p => {
            const y = (p.tripDate || new Date(p.time || Date.now()).toISOString().split('T')[0]).slice(0, 4);
            if (/^\d{4}$/.test(y)) yearsSet.add(y);
        });
        const years = Array.from(yearsSet).sort((a, b) => b.localeCompare(a));
        if (selectedReportYear !== 'ALL' && !yearsSet.has(selectedReportYear)) {
            selectedReportYear = years[0] || 'ALL';
        }

        const tabsEl = document.getElementById('reportYearTabs');
        const tabItems = [{ val: 'ALL', label: '全部足迹' }, ...years.map(y => ({ val: y, label: y + '年' }))];
        tabsEl.innerHTML = tabItems.map(item => `
            <button data-year="${item.val}" onclick="selectReportYear('${item.val}')" class="rep-year-btn px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-all ${selectedReportYear === item.val ? 'bg-rose-500 text-white shadow-xs' : 'bg-white text-rose-500 border border-rose-100'}">${item.label}</button>
        `).join('');

        document.getElementById('posterExportPreviewBox').classList.add('hidden');
        renderAnnualReport();
        document.getElementById('annualReportModal').classList.remove('hidden');
    }

    function closeAnnualReportModal() {
        document.getElementById('annualReportModal').classList.add('hidden');
    }

    function selectReportYear(yearVal) {
        selectedReportYear = yearVal;
        document.querySelectorAll('#reportYearTabs .rep-year-btn').forEach(btn => {
            const active = btn.getAttribute('data-year') === yearVal;
            btn.className = `rep-year-btn px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-all ${active ? 'bg-rose-500 text-white shadow-xs' : 'bg-white text-rose-500 border border-rose-100'}`;
        });
        document.getElementById('posterExportPreviewBox').classList.add('hidden');
        renderAnnualReport();
    }

    function computeReportStats(yearVal) {
        const ctx = global.TravelApp;
        const allPosts = ctx.getPosts();
        const filteredPosts = yearVal === 'ALL'
            ? allPosts
            : allPosts.filter(p => (p.tripDate || new Date(p.time || Date.now()).toISOString().split('T')[0]).startsWith(yearVal));

        const provSet = new Set();
        const cityCounts = {};
        const featuredThumbs = [];
        let totalPhotos = 0;

        filteredPosts.forEach(p => {
            const c = normalizeCityName(p.city);
            const meta = CITY_MAP_BY_NAME[c];
            if (meta) provSet.add(meta.province);
            else if (p.province) provSet.add(p.province);
            cityCounts[c] = (cityCounts[c] || 0) + 1;
            const imgs = ctx.getPostImages(p);
            totalPhotos += imgs.length;
            if (imgs[0] && featuredThumbs.length < 6) {
                featuredThumbs.push({ url: imgs[0].thumbUrl || imgs[0].url, city: c });
            }
        });

        const fullSummary = ctx.computeTravelDistanceSummary();
        const trips = yearVal === 'ALL'
            ? fullSummary.trips
            : fullSummary.trips.filter(t => (t.dateStr || '').startsWith(yearVal));

        let hengKm = 0, qinKm = 0;
        let farthestTrip = null;
        trips.forEach(t => {
            hengKm += t.hengKm;
            qinKm += t.qinKm;
            const combined = t.hengKm + t.qinKm;
            if (!farthestTrip || combined > (farthestTrip.hengKm + farthestTrip.qinKm)) {
                farthestTrip = t;
            }
        });

        let mostVisitedCity = null, mostVisitedCount = 0;
        Object.entries(cityCounts).forEach(([city, cnt]) => {
            if (cnt > mostVisitedCount) {
                mostVisitedCount = cnt;
                mostVisitedCity = city;
            }
        });

        const defaultTitle = yearVal === 'ALL' ? '我们的双向奔赴足迹总览' : `我们的 ${yearVal} 年度旅行报告`;
        const customInput = document.getElementById('posterCustomTitle');
        const customTitle = customInput && customInput.value.trim();

        return {
            yearVal,
            title: customTitle || defaultTitle,
            defaultTitle,
            provCount: provSet.size,
            cityCount: Object.keys(cityCounts).length,
            tripCount: trips.length,
            photoCount: totalPhotos,
            hengKm,
            qinKm,
            combinedKm: hengKm + qinKm,
            earthPct: (((hengKm + qinKm) / 40075) * 100).toFixed(2),
            farthestTrip,
            mostVisitedCity,
            mostVisitedCount,
            cities: Object.keys(cityCounts),
            featuredThumbs
        };
    }

    function renderAnnualReport() {
        const ctx = global.TravelApp;
        const bases = ctx.getHomeBases();
        const s = computeReportStats(selectedReportYear);
        lastReportStats = s;

        document.getElementById('repTitle').innerText = s.title;
        document.getElementById('repBasesSub').innerText = `哼哼（${bases.heng.city}） ⇄ 亲亲（${bases.qin.city}）`;
        document.getElementById('repHengLabel').innerText = `👦 哼哼 · ${bases.heng.shortCity}出发`;
        document.getElementById('repQinLabel').innerText = `👧 亲亲 · ${bases.qin.shortCity}出发`;
        document.getElementById('repModeHint').innerText = ctx.isRoundTrip() ? '往返里程模式 (×2)' : '单程奔赴里程模式';
        document.getElementById('repProvCount').innerText = s.provCount;
        document.getElementById('repCityCount').innerText = s.cityCount;
        document.getElementById('repTripCount').innerText = s.tripCount;
        document.getElementById('repPhotoCount').innerText = s.photoCount;
        document.getElementById('repHengKm').innerText = s.hengKm.toLocaleString();
        document.getElementById('repQinKm').innerText = s.qinKm.toLocaleString();
        document.getElementById('repCombinedKm').innerText = `${s.combinedKm.toLocaleString()} km（约绕赤道 ${s.earthPct}%）`;

        document.getElementById('repFarthest').innerText = s.farthestTrip
            ? `${s.farthestTrip.city}（合奔 ${(s.farthestTrip.hengKm + s.farthestTrip.qinKm).toLocaleString()} km）`
            : '暂无记录';
        document.getElementById('repMostCity').innerText = s.mostVisitedCity
            ? `${s.mostVisitedCity}（${s.mostVisitedCount} 篇足迹）`
            : '暂无记录';

        const citiesWrap = document.getElementById('repCitiesList');
        citiesWrap.innerHTML = s.cities.length > 0
            ? s.cities.map(c => `<span class="px-2 py-0.5 rounded-full bg-white text-rose-500 text-10 font-bold border border-rose-100">📍 ${c.replace(/(市|自治州|地区|盟|特别行政区)$/g, '')}</span>`).join('')
            : `<span class="text-11 text-gray-400">该时段还没有点亮城市哦~</span>`;
    }

    function drawRoundedRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function loadImageForCanvas(url) {
        return new Promise(async (resolve) => {
            try {
                const resolved = await global.TravelApp.ThumbCacheDB.resolveUrl(url);
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => resolve(img);
                img.onerror = () => resolve(null);
                img.src = resolved || url;
            } catch (e) {
                resolve(null);
            }
        });
    }

    async function exportAnnualPoster() {
        const ctxApp = global.TravelApp;
        const bases = ctxApp.getHomeBases();
        const s = computeReportStats(selectedReportYear);
        const includePhotos = document.getElementById('posterIncludePhotos') && document.getElementById('posterIncludePhotos').checked;

        let loadedPhotos = [];
        if (includePhotos && s.featuredThumbs.length > 0) {
            ctxApp.showToast("正在合成精选照片海报...");
            const imgs = await Promise.all(s.featuredThumbs.map(it => loadImageForCanvas(it.url)));
            loadedPhotos = imgs.map((img, i) => img ? { img, city: s.featuredThumbs[i].city } : null).filter(Boolean);
        }

        const W = 750;
        const photoRows = loadedPhotos.length > 0 ? Math.ceil(loadedPhotos.length / 3) : 0;
        const photoSectionH = photoRows > 0 ? (64 + photoRows * 212) : 0;
        const cityRows = Math.max(1, Math.ceil(s.cities.length / 5));
        const H = 990 + photoSectionH + cityRows * 46;

        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        const bgGrad = ctx.createLinearGradient(0, 0, W, H);
        bgGrad.addColorStop(0, '#fff1f2');
        bgGrad.addColorStop(0.5, '#fdf2f8');
        bgGrad.addColorStop(1, '#f0f9ff');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        ctx.fillStyle = 'rgba(251, 113, 133, 0.12)';
        ctx.beginPath(); ctx.arc(670, 90, 120, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(56, 189, 248, 0.10)';
        ctx.beginPath(); ctx.arc(90, H - 120, 130, 0, Math.PI * 2); ctx.fill();

        // 标题
        ctx.fillStyle = '#e11d48';
        ctx.font = 'bold 38px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(s.title, W / 2, 102);

        ctx.fillStyle = '#9ca3af';
        ctx.font = '600 21px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        ctx.fillText(`哼哼（${bases.heng.shortCity}） ⇄ 亲亲（${bases.qin.shortCity}） · ${ctxApp.isRoundTrip() ? '往返总程' : '单程奔赴'}`, W / 2, 148);

        // 4项指标卡
        const statsItems = [
            { label: '点亮省份', val: `${s.provCount}` },
            { label: '点亮城市', val: `${s.cityCount}` },
            { label: '赴约次数', val: `${s.tripCount}` },
            { label: '旅行照片', val: `${s.photoCount}` }
        ];
        const cardY = 190, cardW = 152, cardH = 126, gap = 18;
        const startX = (W - (cardW * 4 + gap * 3)) / 2;
        statsItems.forEach((it, i) => {
            const x = startX + i * (cardW + gap);
            drawRoundedRect(ctx, x, cardY, cardW, cardH, 24);
            ctx.fillStyle = 'rgba(255,255,255,0.95)';
            ctx.fill();
            ctx.strokeStyle = '#fecdd3';
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.fillStyle = '#6b7280';
            ctx.font = '600 20px -apple-system, "PingFang SC", sans-serif';
            ctx.fillText(it.label, x + cardW / 2, cardY + 42);
            ctx.fillStyle = '#e11d48';
            ctx.font = '800 42px -apple-system, "PingFang SC", sans-serif';
            ctx.fillText(it.val, x + cardW / 2, cardY + 95);
        });

        // 双向奔赴里程大卡
        const distY = 348, distH = 262;
        drawRoundedRect(ctx, 44, distY, W - 88, distH, 30);
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        ctx.fill();
        ctx.strokeStyle = '#fda4af';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = '#374151';
        ctx.font = 'bold 26px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText('✈️ 双向奔赴总里程', 78, distY + 50);

        const halfW = (W - 88 - 68 - 22) / 2;
        drawRoundedRect(ctx, 78, distY + 74, halfW, 118, 22);
        ctx.fillStyle = '#f0f9ff';
        ctx.fill();
        ctx.fillStyle = '#0369a1';
        ctx.font = 'bold 21px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(`👦 哼哼 · ${bases.heng.shortCity}出发`, 98, distY + 112);
        ctx.fillStyle = '#0284c7';
        ctx.font = '900 38px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(`${s.hengKm.toLocaleString()} km`, 98, distY + 166);

        const qBoxX = 78 + halfW + 22;
        drawRoundedRect(ctx, qBoxX, distY + 74, halfW, 118, 22);
        ctx.fillStyle = '#fff1f2';
        ctx.fill();
        ctx.fillStyle = '#be123c';
        ctx.font = 'bold 21px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(`👧 亲亲 · ${bases.qin.shortCity}出发`, qBoxX + 20, distY + 112);
        ctx.fillStyle = '#e11d48';
        ctx.font = '900 38px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(`${s.qinKm.toLocaleString()} km`, qBoxX + 20, distY + 166);

        ctx.textAlign = 'center';
        ctx.fillStyle = '#f43f5e';
        ctx.font = 'bold 23px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(`两人合计奔赴 ${s.combinedKm.toLocaleString()} km · 约绕地球赤道 ${s.earthPct}%`, W / 2, distY + 234);

        // 亮点卡
        const hiY = 640, hiH = 160;
        drawRoundedRect(ctx, 44, hiY, W - 88, hiH, 28);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fill();
        ctx.strokeStyle = '#fecdd3';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = '#6b7280';
        ctx.font = 'bold 22px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText('🌟 最远的一次赴约', 78, hiY + 52);
        ctx.fillStyle = '#e11d48';
        ctx.font = 'bold 25px -apple-system, "PingFang SC", sans-serif';
        const farTxt = s.farthestTrip ? `${s.farthestTrip.city}（合计 ${(s.farthestTrip.hengKm + s.farthestTrip.qinKm).toLocaleString()} km）` : '等待点亮第一座城';
        ctx.fillText(farTxt, 305, hiY + 52);

        ctx.fillStyle = '#6b7280';
        ctx.font = 'bold 22px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText('❤️ 最常打卡的城市', 78, hiY + 116);
        ctx.fillStyle = '#e11d48';
        ctx.font = 'bold 25px -apple-system, "PingFang SC", sans-serif';
        const mostTxt = s.mostVisitedCity ? `${s.mostVisitedCity}（${s.mostVisitedCount} 篇旅行手账）` : '等待点亮第一座城';
        ctx.fillText(mostTxt, 305, hiY + 116);

        // 可选：精选旅行照拼贴区
        let curY = 830;
        if (loadedPhotos.length > 0) {
            ctx.textAlign = 'left';
            ctx.fillStyle = '#9d174d';
            ctx.font = 'bold 24px -apple-system, "PingFang SC", sans-serif';
            ctx.fillText(`📸 精选旅行瞬间（${loadedPhotos.length} 帧）`, 56, curY + 26);

            const cols = 3, cellW = 204, cellH = 196, cellGap = 18;
            const gridStartX = (W - (cols * cellW + (cols - 1) * cellGap)) / 2;
            loadedPhotos.forEach((item, idx) => {
                const row = Math.floor(idx / cols);
                const col = idx % cols;
                const x = gridStartX + col * (cellW + cellGap);
                const y = curY + 46 + row * (cellH + 16);

                ctx.save();
                drawRoundedRect(ctx, x, y, cellW, cellH, 18);
                ctx.clip();
                const iw = item.img.naturalWidth || item.img.width;
                const ih = item.img.naturalHeight || item.img.height;
                const scale = Math.max(cellW / iw, cellH / ih);
                const dw = iw * scale, dh = ih * scale;
                ctx.drawImage(item.img, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
                ctx.restore();

                drawRoundedRect(ctx, x, y, cellW, cellH, 18);
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 4;
                ctx.stroke();

                const label = item.city.replace(/(市|自治州|地区|盟|特别行政区)$/g, '');
                drawRoundedRect(ctx, x + 10, y + cellH - 36, Math.min(120, label.length * 20 + 26), 26, 13);
                ctx.fillStyle = 'rgba(0,0,0,0.52)';
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 15px -apple-system, "PingFang SC", sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText('📍 ' + label, x + 18, y + cellH - 18);
            });
            curY += photoSectionH;
        }

        // 点亮城市墙
        ctx.textAlign = 'left';
        ctx.fillStyle = '#9d174d';
        ctx.font = 'bold 24px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(`📍 已点亮城市足迹（${s.cities.length} 城）`, 56, curY + 26);

        let cx = 56, cy = curY + 56;
        ctx.font = 'bold 20px -apple-system, "PingFang SC", sans-serif';
        s.cities.forEach(city => {
            const label = city.replace(/(市|自治州|地区|盟|特别行政区)$/g, '');
            const tw = ctx.measureText(label).width + 34;
            if (cx + tw > W - 56) {
                cx = 56;
                cy += 44;
            }
            drawRoundedRect(ctx, cx, cy, tw, 34, 17);
            ctx.fillStyle = '#ffe4e6';
            ctx.fill();
            ctx.fillStyle = '#e11d48';
            ctx.textAlign = 'center';
            ctx.fillText(label, cx + tw / 2, cy + 24);
            cx += tw + 12;
        });

        ctx.textAlign = 'center';
        ctx.fillStyle = '#9ca3af';
        ctx.font = '600 20px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(`秘密基地 · 我们的旅游足迹 · 生成于 ${new Date().toISOString().split('T')[0]}`, W / 2, H - 36);

        let dataUrl;
        try {
            dataUrl = canvas.toDataURL('image/png');
        } catch (e) {
            ctxApp.showToast("部分图片跨域限制，已切换纯文字版海报");
            document.getElementById('posterIncludePhotos').checked = false;
            return exportAnnualPoster();
        }

        const previewBox = document.getElementById('posterExportPreviewBox');
        const previewImg = document.getElementById('posterExportImg');
        previewImg.src = dataUrl;
        previewBox.classList.remove('hidden');

        try {
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = `双向奔赴旅行报告_${s.yearVal}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch (e) {}
        ctxApp.showToast("🎉 高清总结海报已生成！iOS 可长按图片存相册");
    }

    // Export to window
    global.startFootprintReplay = startFootprintReplay;
    global.switchReplayYear = switchReplayYear;
    global.jumpToReplayStep = jumpToReplayStep;
    global.toggleReplayCameraMode = toggleReplayCameraMode;
    global.openReplayCurrentImage = openReplayCurrentImage;
    global.openReplayCityAlbum = openReplayCityAlbum;
    global.toggleReplayPause = toggleReplayPause;
    global.stepReplay = stepReplay;
    global.toggleReplaySpeed = toggleReplaySpeed;
    global.stopFootprintReplay = stopFootprintReplay;

    global.openAnnualReportModal = openAnnualReportModal;
    global.closeAnnualReportModal = closeAnnualReportModal;
    global.selectReportYear = selectReportYear;
    global.renderAnnualReport = renderAnnualReport;
    global.exportAnnualPoster = exportAnnualPoster;
    global.__TRAVEL_EXTRAS_LOADED__ = true;
})(window);
