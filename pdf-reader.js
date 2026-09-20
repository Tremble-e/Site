(() => {
    'use strict';

    const state = {
        url: '',
        title: '',
        page: 1,
        numPages: 0,
        zoomIndex: -1,
        manualZoomPercent: null,
        currentCssScale: 1,
        pageBaseWidth: 0,
        pageBaseHeight: 0,
        pageMetrics: new Map(),
        renderedPages: new Map(),
        visiblePages: new Set(),
        renderEpoch: 0,
        pinch: null,
        pan: null,
        documentId: '',
        fileName: '',
        pdf: null,
        loadingTask: null,
        fallback: false,
        historyToken: '',
        closingFromHistory: false,
        pageObserver: null,
        scrollRaf: 0,
        zoomRaf: 0,
        pendingZoom: null,
        pseudoFullscreen: false
    };

    const zoomSteps = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
    const byId = id => document.getElementById(id);
    const activePointers = new Map();
    let gestureRenderTimer = 0;
    let resizeTimer = 0;

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function getStage() {
        return byId('site-pdf-reader-stage') || document.querySelector('.site-pdf-reader-stage');
    }

    function getPagesWrap() {
        return byId('site-pdf-reader-canvas-wrap');
    }

    function safePdfUrl(value) {
        try {
            const url = new URL(String(value || ''), window.location.href);
            return ['http:', 'https:', 'blob:'].includes(url.protocol) ? url.href : '';
        } catch {
            return '';
        }
    }

    function setLoading(visible, label = 'Chargement du document…') {
        const loading = byId('site-pdf-reader-loading');
        if (!loading) return;
        const text = loading.querySelector('span');
        if (text) text.textContent = label;
        loading.hidden = !visible;
    }

    function currentPercent() {
        return clamp((state.currentCssScale || 1) * 100, 25, 500);
    }

    function explicitZoomPercent() {
        if (Number.isFinite(state.manualZoomPercent)) return state.manualZoomPercent;
        return null;
    }

    function zoomFieldValue() {
        return String(Math.round(currentPercent()));
    }

    function updateToolbar() {
        const page = byId('site-pdf-reader-page');
        const total = byId('site-pdf-reader-page-total');
        const zoomInput = byId('site-pdf-reader-zoom-input');
        const prev = byId('site-pdf-reader-prev');
        const next = byId('site-pdf-reader-next');

        if (page) {
            if (document.activeElement !== page) page.value = String(Math.max(1, state.page || 1));
            page.setAttribute('aria-valuemax', state.numPages ? String(state.numPages) : '');
        }
        if (total) total.textContent = state.numPages ? `/ ${state.numPages}` : '';
        if (zoomInput && document.activeElement !== zoomInput) zoomInput.value = zoomFieldValue();
        if (prev) prev.disabled = state.page <= 1;
        if (next) next.disabled = Boolean(state.numPages) && state.page >= state.numPages;
    }

    function cancelAllPageRenders() {
        for (const item of state.renderedPages.values()) {
            if (item?.task) {
                try { item.task.cancel(); } catch {}
                item.task = null;
            }
        }
        state.renderEpoch += 1;
    }

    function disconnectObserver() {
        try { state.pageObserver?.disconnect(); } catch {}
        state.pageObserver = null;
        state.visiblePages.clear();
    }

    function clearPages() {
        cancelAllPageRenders();
        disconnectObserver();
        state.renderedPages.clear();
        state.pageMetrics.clear();
        const wrap = getPagesWrap();
        if (wrap) wrap.replaceChildren();
    }

    function destroyDocument() {
        clearTimeout(gestureRenderTimer);
        if (state.zoomRaf) cancelAnimationFrame(state.zoomRaf);
        if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf);
        state.zoomRaf = 0;
        state.scrollRaf = 0;
        state.pendingZoom = null;
        clearPages();

        if (state.loadingTask) {
            try { state.loadingTask.destroy(); } catch {}
            state.loadingTask = null;
        }
        if (state.pdf) {
            try { state.pdf.destroy(); } catch {}
            state.pdf = null;
        }
    }

    function nativeViewerUrl() {
        if (!state.url) return 'about:blank';
        const base = state.url.split('#')[0];
        return `${base}#page=${Math.max(1, state.page || 1)}`;
    }

    function showFallback() {
        state.fallback = true;
        const canvasWrap = getPagesWrap();
        const frame = byId('site-pdf-reader-frame');
        if (canvasWrap) canvasWrap.hidden = true;
        if (frame) {
            frame.hidden = false;
            frame.src = nativeViewerUrl();
        }
        setLoading(false);
        updateToolbar();
    }

    function stageAvailableWidth(baseWidth = state.pageBaseWidth || 1) {
        const stage = getStage();
        if (!stage) return baseWidth;
        const style = getComputedStyle(stage);
        const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        return Math.max(160, stage.clientWidth - horizontalPadding - 8);
    }

    function fitScale() {
        if (!state.pageBaseWidth) return 1;
        return Math.max(0.1, stageAvailableWidth(state.pageBaseWidth) / state.pageBaseWidth);
    }

    function metricFor(pageNumber) {
        return state.pageMetrics.get(pageNumber) || {
            width: state.pageBaseWidth || 612,
            height: state.pageBaseHeight || 792
        };
    }

    function pageShell(pageNumber) {
        return getPagesWrap()?.querySelector(`.site-pdf-reader-page-shell[data-page="${pageNumber}"]`) || null;
    }

    function updateShellSize(shell, pageNumber, scale = state.currentCssScale) {
        if (!shell) return;
        const metric = metricFor(pageNumber);
        shell.style.width = `${Math.max(1, metric.width * scale)}px`;
        shell.style.height = `${Math.max(1, metric.height * scale)}px`;
    }

    function pageAnchorAt(clientX, clientY) {
        let shell = null;
        try { shell = document.elementFromPoint(clientX, clientY)?.closest?.('.site-pdf-reader-page-shell') || null; } catch {}
        if (!shell) shell = pageShell(state.page);
        if (!shell) return null;
        const rect = shell.getBoundingClientRect();
        return {
            pageNumber: Number(shell.dataset.page || state.page || 1),
            fx: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
            fy: clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1),
            clientX,
            clientY
        };
    }

    function centerAnchor() {
        const stage = getStage();
        if (!stage) return null;
        const rect = stage.getBoundingClientRect();
        return pageAnchorAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    function restoreAnchor(anchor) {
        const stage = getStage();
        if (!stage || !anchor) return;
        const shell = pageShell(anchor.pageNumber);
        if (!shell) return;
        const rect = shell.getBoundingClientRect();
        stage.scrollLeft += (rect.left + anchor.fx * rect.width) - anchor.clientX;
        stage.scrollTop += (rect.top + anchor.fy * rect.height) - anchor.clientY;
        clampStageScroll(stage);
    }

    function applyZoomLayout(percent, anchor = null) {
        const nextPercent = clamp(Number(percent) || 100, 25, 500);
        const scale = nextPercent / 100;
        const savedAnchor = anchor || centerAnchor();
        state.currentCssScale = scale;

        const wrap = getPagesWrap();
        if (wrap) {
            wrap.querySelectorAll('.site-pdf-reader-page-shell').forEach(shell => {
                updateShellSize(shell, Number(shell.dataset.page || 1), scale);
            });
        }

        restoreAnchor(savedAnchor);
        updateToolbar();
    }

    function previewZoom(percent, anchor = null) {
        state.pendingZoom = { percent: clamp(Number(percent) || 100, 25, 500), anchor };
        if (state.zoomRaf) return;
        state.zoomRaf = requestAnimationFrame(() => {
            state.zoomRaf = 0;
            const pending = state.pendingZoom;
            state.pendingZoom = null;
            if (pending) applyZoomLayout(pending.percent, pending.anchor);
        });
    }

    function nearestZoomIndex(percent) {
        let best = 0;
        let distance = Infinity;
        zoomSteps.forEach((value, index) => {
            const current = Math.abs(value - percent);
            if (current < distance) {
                distance = current;
                best = index;
            }
        });
        return best;
    }

    function renderKey() {
        return `${state.renderEpoch}:${Math.round(state.currentCssScale * 1000)}`;
    }

    function maxOutputScale(metric, cssScale) {
        const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const maxPixels = 10_000_000;
        const cssPixels = Math.max(1, metric.width * cssScale * metric.height * cssScale);
        const pixelCap = Math.sqrt(maxPixels / cssPixels);
        return Math.max(0.35, Math.min(dpr, pixelCap));
    }

    async function renderPageNumber(pageNumber, { priority = false } = {}) {
        if (!state.pdf || state.fallback) return false;
        const number = clamp(Number(pageNumber) || 1, 1, state.numPages || 1);
        const shell = pageShell(number);
        if (!shell) return false;

        const key = renderKey();
        const existing = state.renderedPages.get(number);
        if (existing?.key === key && existing.canvas?.isConnected) return true;
        if (existing?.task) {
            try { existing.task.cancel(); } catch {}
        }

        const epoch = state.renderEpoch;
        try {
            const page = await state.pdf.getPage(number);
            if (epoch !== state.renderEpoch) return false;

            const baseViewport = page.getViewport({ scale: 1 });
            const oldMetric = metricFor(number);
            const metric = { width: baseViewport.width, height: baseViewport.height };
            state.pageMetrics.set(number, metric);
            if (Math.abs(oldMetric.width - metric.width) > 0.5 || Math.abs(oldMetric.height - metric.height) > 0.5) {
                updateShellSize(shell, number);
            }

            let canvas = existing?.canvas;
            if (!canvas || !canvas.isConnected) {
                canvas = document.createElement('canvas');
                canvas.className = 'site-pdf-reader-page-canvas';
                canvas.setAttribute('aria-label', `Page ${number} du document PDF`);
                shell.querySelector('.site-pdf-reader-page-surface')?.replaceChildren(canvas);
            }

            const cssScale = state.currentCssScale;
            const outputScale = maxOutputScale(metric, cssScale);
            const viewport = page.getViewport({ scale: cssScale * outputScale });
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            canvas.style.width = '100%';
            canvas.style.height = '100%';

            const context = canvas.getContext('2d', { alpha: false });
            context.save();
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.restore();

            const task = page.render({ canvasContext: context, viewport });
            state.renderedPages.set(number, { canvas, task, key });
            await task.promise;
            if (epoch !== state.renderEpoch) return false;
            const item = state.renderedPages.get(number);
            if (item) item.task = null;
            shell.classList.add('is-rendered');
            shell.setAttribute('aria-busy', 'false');
            if (priority) setLoading(false);
            return true;
        } catch (error) {
            if (error?.name === 'RenderingCancelledException') return false;
            console.error(`Rendu PDF page ${number} :`, error);
            shell.setAttribute('aria-busy', 'false');
            return false;
        }
    }

    function renderVisiblePages() {
        if (!state.pdf || state.fallback) return;
        const candidates = new Set(state.visiblePages);
        candidates.add(state.page);
        candidates.add(state.page - 1);
        candidates.add(state.page + 1);
        candidates.add(state.page - 2);
        candidates.add(state.page + 2);
        [...candidates]
            .filter(number => number >= 1 && number <= state.numPages)
            .sort((a, b) => Math.abs(a - state.page) - Math.abs(b - state.page))
            .forEach(number => renderPageNumber(number).catch(() => {}));
        pruneRenderedPages();
    }

    function pruneRenderedPages() {
        for (const [number, item] of [...state.renderedPages.entries()]) {
            if (state.visiblePages.has(number) || Math.abs(number - state.page) <= 3) continue;
            if (item?.task) {
                try { item.task.cancel(); } catch {}
            }
            try { item?.canvas?.remove(); } catch {}
            state.renderedPages.delete(number);
            const shell = pageShell(number);
            shell?.classList.remove('is-rendered');
        }
    }

    function updateCurrentPageFromScroll() {
        if (state.scrollRaf) return;
        state.scrollRaf = requestAnimationFrame(() => {
            state.scrollRaf = 0;
            const stage = getStage();
            if (!stage || !state.numPages) return;
            const stageRect = stage.getBoundingClientRect();
            const y = stageRect.top + Math.min(stageRect.height * 0.38, 260);
            let best = state.page;
            let bestDistance = Infinity;
            const candidates = state.visiblePages.size ? [...state.visiblePages] : [state.page];
            for (const number of candidates) {
                const shell = pageShell(number);
                if (!shell) continue;
                const rect = shell.getBoundingClientRect();
                const center = clamp(y, rect.top, rect.bottom);
                const distance = Math.abs(y - center);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = number;
                }
            }
            best = clamp(best, 1, state.numPages);
            if (best !== state.page) {
                state.page = best;
                updateToolbar();
            }
            renderVisiblePages();
        });
    }

    function installPageObserver() {
        disconnectObserver();
        const stage = getStage();
        if (!stage || typeof IntersectionObserver !== 'function') {
            state.visiblePages.add(state.page);
            return;
        }
        state.pageObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const number = Number(entry.target?.dataset?.page || 0);
                if (!number) continue;
                if (entry.isIntersecting) state.visiblePages.add(number);
                else state.visiblePages.delete(number);
                if (entry.isIntersecting) renderPageNumber(number).catch(() => {});
            }
            updateCurrentPageFromScroll();
        }, {
            root: stage,
            rootMargin: '1200px 0px 1200px 0px',
            threshold: 0.01
        });
        getPagesWrap()?.querySelectorAll('.site-pdf-reader-page-shell').forEach(shell => state.pageObserver.observe(shell));
    }

    function buildContinuousPages() {
        const wrap = getPagesWrap();
        if (!wrap) return;
        wrap.hidden = false;
        wrap.replaceChildren();
        const fragment = document.createDocumentFragment();
        for (let pageNumber = 1; pageNumber <= state.numPages; pageNumber += 1) {
            const shell = document.createElement('section');
            shell.className = 'site-pdf-reader-page-shell';
            shell.dataset.page = String(pageNumber);
            shell.setAttribute('aria-label', `Page ${pageNumber}`);
            shell.setAttribute('aria-busy', 'true');
            updateShellSize(shell, pageNumber);

            const surface = document.createElement('div');
            surface.className = 'site-pdf-reader-page-surface';
            const badge = document.createElement('span');
            badge.className = 'site-pdf-reader-page-badge';
            badge.textContent = String(pageNumber);
            badge.setAttribute('aria-hidden', 'true');
            shell.append(surface, badge);
            fragment.append(shell);
        }
        wrap.append(fragment);
        installPageObserver();
    }

    async function loadPdf() {
        destroyDocument();
        state.fallback = false;
        state.numPages = 0;
        updateToolbar();
        setLoading(true);

        const lib = window.pdfjsLib;
        if (!lib?.getDocument) {
            showFallback();
            return;
        }

        try {
            lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            state.loadingTask = lib.getDocument({
                url: state.url,
                withCredentials: false,
                disableAutoFetch: false,
                disableStream: false,
                disableRange: false
            });
            state.pdf = await state.loadingTask.promise;
            state.loadingTask = null;
            state.numPages = state.pdf.numPages || 1;
            state.page = clamp(state.page, 1, state.numPages);

            const firstPage = await state.pdf.getPage(1);
            const firstViewport = firstPage.getViewport({ scale: 1 });
            state.pageBaseWidth = firstViewport.width;
            state.pageBaseHeight = firstViewport.height;
            state.pageMetrics.set(1, { width: firstViewport.width, height: firstViewport.height });
            state.currentCssScale = fitScale();
            state.manualZoomPercent = null;
            state.zoomIndex = -1;

            const frame = byId('site-pdf-reader-frame');
            if (frame) {
                frame.hidden = true;
                frame.src = 'about:blank';
            }
            buildContinuousPages();
            updateToolbar();
            const stage = getStage();
            if (stage) {
                stage.scrollLeft = 0;
                stage.scrollTop = 0;
            }
            await renderPageNumber(1, { priority: true });
            renderVisiblePages();
        } catch (error) {
            console.error('Chargement PDF.js :', error);
            state.pdf = null;
            state.loadingTask = null;
            showFallback();
        }
    }

    function open({ title = 'Document PDF', url = '', documentId = '', fileName = '' } = {}) {
        const safe = safePdfUrl(url);
        if (!safe) return false;

        state.url = safe;
        state.title = String(title || 'Document PDF');
        state.page = 1;
        state.numPages = 0;
        state.zoomIndex = -1;
        state.manualZoomPercent = null;
        state.currentCssScale = 1;
        state.pageBaseWidth = 0;
        state.pageBaseHeight = 0;
        state.pinch = null;
        state.pan = null;
        activePointers.clear();
        state.documentId = String(documentId || '');
        state.fileName = String(fileName || '').trim();

        const modal = byId('site-pdf-reader');
        const label = byId('site-pdf-reader-title');
        const download = byId('site-pdf-reader-download');
        if (!modal) return false;

        if (label) label.textContent = state.title;
        if (!state.historyToken) {
            state.historyToken = `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            try {
                history.pushState({ ...(history.state || {}), planilimPdfReader: state.historyToken }, '', location.href);
            } catch {}
        }
        if (download) {
            download.href = safe;
            const clean = (state.fileName || state.title).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'document';
            download.download = /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`;
            download.dataset.documentId = state.documentId;
        }

        modal.hidden = false;
        document.body.classList.add('site-pdf-reader-open');
        updateToolbar();
        loadPdf();
        return true;
    }

    function exitPseudoFullscreen() {
        state.pseudoFullscreen = false;
        byId('site-pdf-reader')?.classList.remove('site-pdf-reader-pseudo-fullscreen');
        updateFullscreenButton();
    }

    function finalizeClose() {
        const modal = byId('site-pdf-reader');
        const frame = byId('site-pdf-reader-frame');
        if (modal) modal.hidden = true;
        if (frame) frame.src = 'about:blank';
        try {
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                (document.exitFullscreen?.() || document.webkitExitFullscreen?.())?.catch?.(() => {});
            }
        } catch {}
        exitPseudoFullscreen();
        destroyDocument();
        document.body.classList.remove('site-pdf-reader-open');
        state.url = '';
        state.documentId = '';
        state.fileName = '';
        state.numPages = 0;
        state.fallback = false;
        state.manualZoomPercent = null;
        state.currentCssScale = 1;
        state.pageBaseWidth = 0;
        state.pageBaseHeight = 0;
        state.pinch = null;
        state.pan = null;
        activePointers.clear();
        state.historyToken = '';
        state.closingFromHistory = false;
    }

    function close() {
        const modal = byId('site-pdf-reader');
        if (!modal || modal.hidden) return;
        const token = state.historyToken;
        if (token && history.state?.planilimPdfReader === token && !state.closingFromHistory) {
            state.closingFromHistory = true;
            history.back();
            return;
        }
        finalizeClose();
    }

    function setPage(value, { smooth = true } = {}) {
        const parsed = Number.parseInt(String(value || ''), 10) || 1;
        const next = clamp(parsed, 1, state.numPages || 1);
        state.page = next;
        updateToolbar();

        if (state.fallback) {
            const frame = byId('site-pdf-reader-frame');
            if (frame) frame.src = nativeViewerUrl();
            return;
        }

        const stage = getStage();
        const shell = pageShell(next);
        if (stage && shell) {
            const stageRect = stage.getBoundingClientRect();
            const shellRect = shell.getBoundingClientRect();
            const top = Math.max(0, stage.scrollTop + shellRect.top - stageRect.top - 10);
            try { stage.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' }); }
            catch { stage.scrollTop = top; }
        }
        renderPageNumber(next).catch(() => {});
        renderPageNumber(next - 1).catch(() => {});
        renderPageNumber(next + 1).catch(() => {});
    }

    function clampStageScroll(stage) {
        if (!stage) return;
        const maxX = Math.max(0, stage.scrollWidth - stage.clientWidth);
        const maxY = Math.max(0, stage.scrollHeight - stage.clientHeight);
        stage.scrollLeft = clamp(stage.scrollLeft, 0, maxX);
        stage.scrollTop = clamp(stage.scrollTop, 0, maxY);
    }

    function rerenderVisibleAfterZoom(delay = 100) {
        clearTimeout(gestureRenderTimer);
        gestureRenderTimer = window.setTimeout(() => {
            if (!state.pdf || state.fallback) return;
            cancelAllPageRenders();
            renderVisiblePages();
        }, delay);
    }

    function commitManualZoom(percent, anchor = null, renderDelay = 80) {
        const nextPercent = clamp(Number(percent) || 100, 25, 500);
        state.manualZoomPercent = nextPercent;
        state.zoomIndex = -1;
        previewZoom(nextPercent, anchor);
        updateToolbar();
        rerenderVisibleAfterZoom(renderDelay);
    }

    function zoom(delta) {
        const current = currentPercent();
        const baseIndex = nearestZoomIndex(current);
        const nextIndex = clamp(baseIndex + delta, 0, zoomSteps.length - 1);
        const nextPercent = zoomSteps[nextIndex];
        state.manualZoomPercent = nextPercent;
        state.zoomIndex = nextIndex;
        previewZoom(nextPercent, centerAnchor());
        updateToolbar();
        rerenderVisibleAfterZoom(60);
    }

    function fitWidth() {
        clearTimeout(gestureRenderTimer);
        state.manualZoomPercent = null;
        state.zoomIndex = -1;
        state.pinch = null;
        state.pan = null;
        const anchor = centerAnchor();
        const percent = fitScale() * 100;
        previewZoom(percent, anchor);
        updateToolbar();
        rerenderVisibleAfterZoom(40);
    }

    function applyZoomInput(value) {
        const normalized = String(value ?? '').trim().replace(',', '.').replace('%', '');
        const parsed = Number.parseFloat(normalized);
        if (!Number.isFinite(parsed)) {
            updateToolbar();
            return false;
        }
        commitManualZoom(clamp(parsed, 25, 500), centerAnchor(), 60);
        return true;
    }

    function pointFromTouch(touch) {
        return { x: touch.clientX, y: touch.clientY };
    }

    function distance(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function midpoint(a, b) {
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    function beginPan(point, sourceId = null) {
        const stage = getStage();
        if (!stage || !point || state.pinch) return;
        state.pan = {
            sourceId,
            startX: point.x,
            startY: point.y,
            startScrollLeft: stage.scrollLeft,
            startScrollTop: stage.scrollTop
        };
        stage.classList.add('panning');
    }

    function movePan(point, sourceId = null) {
        const stage = getStage();
        if (!stage || !state.pan || state.pinch || !point) return;
        if (state.pan.sourceId != null && sourceId != null && state.pan.sourceId !== sourceId) return;
        stage.scrollLeft = state.pan.startScrollLeft - (point.x - state.pan.startX);
        stage.scrollTop = state.pan.startScrollTop - (point.y - state.pan.startY);
        clampStageScroll(stage);
        updateCurrentPageFromScroll();
    }

    function endPan() {
        getStage()?.classList.remove('panning');
        state.pan = null;
    }

    function beginPinch(pointA, pointB) {
        if (!state.pdf || state.fallback) return;
        const stage = getStage();
        if (!stage) return;
        const mid = midpoint(pointA, pointB);
        const anchor = pageAnchorAt(mid.x, mid.y);
        if (!anchor) return;
        endPan();
        state.pinch = {
            startDistance: Math.max(1, distance(pointA, pointB)),
            startPercent: currentPercent(),
            anchor,
            lastPercent: currentPercent()
        };
        stage.classList.add('pinching');
    }

    function movePinch(pointA, pointB) {
        if (!state.pinch) beginPinch(pointA, pointB);
        if (!state.pinch) return;
        const mid = midpoint(pointA, pointB);
        const ratio = distance(pointA, pointB) / state.pinch.startDistance;
        const percent = clamp(state.pinch.startPercent * ratio, 25, 500);
        const liveAnchor = { ...state.pinch.anchor, clientX: mid.x, clientY: mid.y };
        previewZoom(percent, liveAnchor);
        state.pinch.lastPercent = percent;
    }

    function finishPinch() {
        if (!state.pinch) return;
        const percent = clamp(state.pinch.lastPercent, 25, 500);
        state.pinch = null;
        getStage()?.classList.remove('pinching');
        state.manualZoomPercent = percent;
        state.zoomIndex = -1;
        state.currentCssScale = percent / 100;
        updateToolbar();
        rerenderVisibleAfterZoom(100);
    }

    function handleTouchStart(event) {
        if (!state.pdf || state.fallback) return;
        if (event.touches.length >= 2) {
            event.preventDefault();
            beginPinch(pointFromTouch(event.touches[0]), pointFromTouch(event.touches[1]));
            return;
        }
        if (event.touches.length === 1) {
            event.preventDefault();
            beginPan(pointFromTouch(event.touches[0]), 'touch');
        }
    }

    function handleTouchMove(event) {
        if (!state.pdf || state.fallback) return;
        if (event.touches.length >= 2) {
            event.preventDefault();
            movePinch(pointFromTouch(event.touches[0]), pointFromTouch(event.touches[1]));
            return;
        }
        if (event.touches.length === 1) {
            event.preventDefault();
            movePan(pointFromTouch(event.touches[0]), 'touch');
        }
    }

    function handleTouchEnd(event) {
        if (!state.pdf || state.fallback) return;
        event.preventDefault();
        if (state.pinch && event.touches.length < 2) finishPinch();
        if (event.touches.length === 1 && !state.pinch) {
            beginPan(pointFromTouch(event.touches[0]), 'touch');
        } else if (event.touches.length === 0) {
            endPan();
        }
    }

    function handleMousePointerDown(event) {
        if (event.pointerType !== 'mouse' || event.button !== 0 || !state.pdf || state.fallback) return;
        const stage = getStage();
        if (!stage) return;
        event.preventDefault();
        try { stage.setPointerCapture(event.pointerId); } catch {}
        activePointers.set(event.pointerId, true);
        beginPan({ x: event.clientX, y: event.clientY }, event.pointerId);
    }

    function handleMousePointerMove(event) {
        if (event.pointerType !== 'mouse' || !activePointers.has(event.pointerId)) return;
        event.preventDefault();
        movePan({ x: event.clientX, y: event.clientY }, event.pointerId);
    }

    function handleMousePointerUp(event) {
        if (event.pointerType !== 'mouse' || !activePointers.has(event.pointerId)) return;
        event.preventDefault();
        activePointers.delete(event.pointerId);
        endPan();
    }

    function handleWheel(event) {
        const modal = byId('site-pdf-reader');
        if (!modal || modal.hidden || !state.pdf || state.fallback || !event.ctrlKey) return;
        event.preventDefault();
        event.stopPropagation();
        const anchor = pageAnchorAt(event.clientX, event.clientY) || centerAnchor();
        const factor = Math.exp(-event.deltaY * 0.0025);
        const next = clamp(currentPercent() * factor, 25, 500);
        state.manualZoomPercent = next;
        state.zoomIndex = -1;
        previewZoom(next, anchor);
        updateToolbar();
        rerenderVisibleAfterZoom(140);
    }

    function fullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function updateFullscreenButton() {
        const button = byId('site-pdf-reader-fullscreen');
        if (!button) return;
        const active = Boolean(fullscreenElement() || state.pseudoFullscreen);
        button.setAttribute('aria-label', active ? 'Quitter le plein écran' : 'Plein écran');
        button.dataset.tooltip = active ? 'Quitter le plein écran' : 'Plein écran';
        const icon = button.querySelector('i');
        if (icon) {
            icon.classList.toggle('fa-expand', !active);
            icon.classList.toggle('fa-compress', active);
        }
    }

    async function toggleFullscreen() {
        const reader = byId('site-pdf-reader');
        if (!reader) return;
        try {
            if (fullscreenElement()) {
                if (document.exitFullscreen) await document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
                return;
            }
            if (state.pseudoFullscreen) {
                exitPseudoFullscreen();
                return;
            }
            const request = reader.requestFullscreen || reader.webkitRequestFullscreen;
            if (typeof request === 'function') {
                try {
                    const result = request.call(reader, { navigationUI: 'hide' });
                    if (result?.then) await result;
                    return;
                } catch {
                    const retry = request.call(reader);
                    if (retry?.then) await retry;
                    return;
                }
            }
        } catch {}

        // Fallback : on occupe intégralement le viewport disponible. Sur les
        // navigateurs qui refusent l'API Fullscreen, la barre du navigateur peut
        // rester visible, mais la liseuse utilise tout l'espace de la page.
        state.pseudoFullscreen = !state.pseudoFullscreen;
        reader.classList.toggle('site-pdf-reader-pseudo-fullscreen', state.pseudoFullscreen);
        updateFullscreenButton();
        setTimeout(() => onResize(), 40);
    }

    function onResize() {
        if (!state.pdf || state.fallback) return;
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            if (state.manualZoomPercent == null) {
                const anchor = centerAnchor();
                previewZoom(fitScale() * 100, anchor);
                rerenderVisibleAfterZoom(60);
            }
        }, 100);
    }

    function bindReaderUi() {
        document.querySelectorAll('[data-pdf-reader-close]').forEach(el => el.addEventListener('click', close));
        byId('site-pdf-reader-prev')?.addEventListener('click', () => setPage(state.page - 1));
        byId('site-pdf-reader-next')?.addEventListener('click', () => setPage(state.page + 1));

        const pageInput = byId('site-pdf-reader-page');
        pageInput?.addEventListener('change', event => setPage(event.target.value));
        pageInput?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                setPage(event.target.value);
                event.target.blur();
            }
        });
        pageInput?.addEventListener('focus', event => event.target.select?.());

        const zoomInput = byId('site-pdf-reader-zoom-input');
        zoomInput?.addEventListener('change', event => applyZoomInput(event.target.value));
        zoomInput?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                applyZoomInput(event.target.value);
                event.target.blur();
            } else if (event.key === 'Escape') {
                updateToolbar();
                event.target.blur();
            }
        });
        zoomInput?.addEventListener('focus', event => event.target.select?.());

        byId('site-pdf-reader-zoom-out')?.addEventListener('click', () => zoom(-1));
        byId('site-pdf-reader-zoom-in')?.addEventListener('click', () => zoom(1));
        byId('site-pdf-reader-fit')?.addEventListener('click', fitWidth);
        byId('site-pdf-reader-fullscreen')?.addEventListener('click', toggleFullscreen);

        const stage = getStage();
        stage?.addEventListener('touchstart', handleTouchStart, { passive: false });
        stage?.addEventListener('touchmove', handleTouchMove, { passive: false });
        stage?.addEventListener('touchend', handleTouchEnd, { passive: false });
        stage?.addEventListener('touchcancel', handleTouchEnd, { passive: false });
        stage?.addEventListener('pointerdown', handleMousePointerDown, { passive: false });
        stage?.addEventListener('pointermove', handleMousePointerMove, { passive: false });
        stage?.addEventListener('pointerup', handleMousePointerUp, { passive: false });
        stage?.addEventListener('pointercancel', handleMousePointerUp, { passive: false });
        stage?.addEventListener('lostpointercapture', handleMousePointerUp, { passive: false });
        stage?.addEventListener('wheel', handleWheel, { passive: false, capture: true });
        stage?.addEventListener('scroll', updateCurrentPageFromScroll, { passive: true });

        byId('site-pdf-reader-download')?.addEventListener('click', async event => {
            event.preventDefault();
            const button = event.currentTarget;
            if (!state.url || typeof window.downloadSiteFile !== 'function') return;
            button.setAttribute('aria-busy', 'true');
            try {
                await window.downloadSiteFile(state.url, button.download || state.fileName || `${state.title || 'document'}.pdf`);
            } catch (error) {
                console.error('Téléchargement PDF :', error);
                window.showToast?.(error?.message || 'Téléchargement impossible.');
            } finally {
                button.removeAttribute('aria-busy');
            }
        });

        document.addEventListener('fullscreenchange', updateFullscreenButton);
        document.addEventListener('webkitfullscreenchange', updateFullscreenButton);

        document.addEventListener('keydown', event => {
            const modal = byId('site-pdf-reader');
            if (!modal || modal.hidden) return;
            const editing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
            if (event.key === 'Escape' && !fullscreenElement()) close();
            else if (event.key === 'ArrowLeft' && !editing) setPage(state.page - 1);
            else if (event.key === 'ArrowRight' && !editing) setPage(state.page + 1);
            else if ((event.key === '+' || event.key === '=') && !editing) zoom(1);
            else if (event.key === '-' && !editing) zoom(-1);
        });

        window.addEventListener('popstate', () => {
            const modal = byId('site-pdf-reader');
            if (!modal || modal.hidden) return;
            finalizeClose();
        });
        window.addEventListener('resize', onResize, { passive: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindReaderUi, { once: true });
    else bindReaderUi();

    window.sitePdfReader = { open, close };
})();
