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
        pinch: null,
        pan: null,
        documentId: '',
        fileName: '',
        pdf: null,
        loadingTask: null,
        renderTask: null,
        renderSerial: 0,
        fallback: false,
        historyToken: '',
        closingFromHistory: false,
        pseudoFullscreen: false,
        returnScrollX: 0,
        returnScrollY: 0,
        previousScrollRestoration: null
    };

    const zoomSteps = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250];
    const byId = id => document.getElementById(id);

    function getStage() {
        return document.getElementById('site-pdf-reader-stage') || document.querySelector('.site-pdf-reader-stage');
    }

    function safePdfUrl(value) {
        try {
            const url = new URL(String(value || ''), window.location.href);
            return ['http:', 'https:', 'blob:'].includes(url.protocol) ? url.href : '';
        } catch { return ''; }
    }

    function rememberPageScroll() {
        state.returnScrollX = window.scrollX || document.documentElement.scrollLeft || 0;
        state.returnScrollY = window.scrollY || document.documentElement.scrollTop || 0;
        try {
            state.previousScrollRestoration = history.scrollRestoration;
            history.scrollRestoration = 'manual';
        } catch {
            state.previousScrollRestoration = null;
        }
    }

    function restorePageScroll() {
        const x = Number.isFinite(state.returnScrollX) ? state.returnScrollX : 0;
        const y = Number.isFinite(state.returnScrollY) ? state.returnScrollY : 0;
        const restore = () => window.scrollTo({ left: x, top: y, behavior: 'auto' });
        // Le retour d'historique peut appliquer son propre scroll juste après popstate.
        // On restaure donc après le rendu courant, puis une seconde fois très brièvement après.
        requestAnimationFrame(() => requestAnimationFrame(restore));
        window.setTimeout(restore, 80);
        const previousScrollRestoration = state.previousScrollRestoration;
        window.setTimeout(() => {
            try {
                if (previousScrollRestoration) history.scrollRestoration = previousScrollRestoration;
            } catch {}
        }, 120);
        state.previousScrollRestoration = null;
    }

    function zoomLabel() {
        if (Number.isFinite(state.manualZoomPercent)) return `${Math.round(state.manualZoomPercent)} %`;
        return state.zoomIndex < 0 ? 'Largeur' : `${zoomSteps[state.zoomIndex]} %`;
    }

    function explicitZoomPercent() {
        if (Number.isFinite(state.manualZoomPercent)) return state.manualZoomPercent;
        return state.zoomIndex >= 0 ? zoomSteps[state.zoomIndex] : null;
    }

    function setLoading(visible, label = 'Chargement du document…') {
        const loading = byId('site-pdf-reader-loading');
        if (!loading) return;
        const text = loading.querySelector('span');
        if (text) text.textContent = label;
        loading.hidden = !visible;
    }

    function updateToolbar() {
        const page = byId('site-pdf-reader-page');
        const total = byId('site-pdf-reader-page-total');
        const zoomInput = byId('site-pdf-reader-zoom-input');
        const prev = byId('site-pdf-reader-prev');
        const next = byId('site-pdf-reader-next');

        if (page) {
            if (document.activeElement !== page) page.value = String(Math.max(1, state.page || 1));
            page.max = state.numPages ? String(state.numPages) : '';
        }
        if (total) total.textContent = state.numPages ? `/ ${state.numPages}` : '';
        if (zoomInput && document.activeElement !== zoomInput) {
            zoomInput.value = String(Math.round(clamp((state.currentCssScale || 1) * 100, 25, 500)));
        }
        if (prev) prev.disabled = state.page <= 1;
        if (next) next.disabled = Boolean(state.numPages) && state.page >= state.numPages;
    }

    function cancelRender() {
        if (state.renderTask) {
            try { state.renderTask.cancel(); } catch {}
            state.renderTask = null;
        }
    }

    function destroyDocument() {
        cancelRender();
        state.renderSerial += 1;
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
        const canvasWrap = byId('site-pdf-reader-canvas-wrap');
        const frame = byId('site-pdf-reader-frame');
        if (canvasWrap) canvasWrap.hidden = true;
        if (frame) {
            frame.hidden = false;
            frame.src = nativeViewerUrl();
        }
        setLoading(false);
        updateToolbar();
    }

    function stageAvailableWidth(pageViewport) {
        const stage = getStage();
        if (!stage) return pageViewport.width;
        const style = getComputedStyle(stage);
        const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        return Math.max(160, stage.clientWidth - horizontalPadding - 6);
    }

    async function renderPage({ quiet = false } = {}) {
        if (!state.pdf || state.fallback) return;

        const serial = ++state.renderSerial;
        cancelRender();
        state.page = Math.max(1, Math.min(state.numPages || 1, Number(state.page) || 1));
        updateToolbar();
        if (!quiet) setLoading(true, `Affichage de la page ${state.page}…`);

        try {
            const page = await state.pdf.getPage(state.page);
            if (serial !== state.renderSerial) return;

            const baseViewport = page.getViewport({ scale: 1 });
            state.pageBaseWidth = baseViewport.width;
            state.pageBaseHeight = baseViewport.height;
            const manualPercent = explicitZoomPercent();
            const cssScale = manualPercent == null
                ? Math.max(0.1, stageAvailableWidth(baseViewport) / baseViewport.width)
                : manualPercent / 100;
            state.currentCssScale = cssScale;
            updateToolbar();
            const cssViewport = page.getViewport({ scale: cssScale });

            // Un DPR plafonné à 2 garde un texte net sans multiplier inutilement
            // le nombre de pixels à rendre sur les écrans très haute densité.
            const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
            const renderViewport = page.getViewport({ scale: cssScale * outputScale });
            const canvas = byId('site-pdf-reader-canvas');
            const canvasWrap = byId('site-pdf-reader-canvas-wrap');
            const frame = byId('site-pdf-reader-frame');
            if (!canvas || !canvasWrap) return;

            if (frame) {
                frame.hidden = true;
                frame.src = 'about:blank';
            }
            canvasWrap.hidden = false;
            canvas.width = Math.max(1, Math.floor(renderViewport.width));
            canvas.height = Math.max(1, Math.floor(renderViewport.height));
            canvas.style.width = `${Math.max(1, cssViewport.width)}px`;
            canvas.style.height = `${Math.max(1, cssViewport.height)}px`;

            // En mode Ajuster, la page doit toujours repartir parfaitement dans le viewport.
            // Cela évite de conserver un ancien décalage horizontal après un zoom tactile.
            if (manualPercent == null) {
                const stage = getStage();
                if (stage) stage.scrollLeft = 0;
            }

            const context = canvas.getContext('2d', { alpha: false });
            context.save();
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.restore();

            state.renderTask = page.render({ canvasContext: context, viewport: renderViewport });
            await state.renderTask.promise;
            if (serial !== state.renderSerial) return;
            state.renderTask = null;
            if (!quiet) setLoading(false);
        } catch (error) {
            if (error?.name === 'RenderingCancelledException') return;
            console.error('Rendu PDF :', error);
            if (!state.pdf) showFallback();
            else setLoading(false);
        }
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
            state.page = Math.max(1, Math.min(state.page, state.numPages));
            await renderPage();
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
        rememberPageScroll();
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

        state.pseudoFullscreen = false;
        modal.classList.remove('site-pdf-reader-pseudo-fullscreen', 'site-pdf-reader-mobile-fullscreen', 'site-pdf-reader-tools-collapsed');
        modal.hidden = false;
        document.body.classList.add('site-pdf-reader-open');
        updateFullscreenButton();
        updateToolbar();
        loadPdf();
        return true;
    }

    function finalizeClose() {
        const modal = byId('site-pdf-reader');
        const frame = byId('site-pdf-reader-frame');
        const canvas = byId('site-pdf-reader-canvas');
        if (modal) modal.hidden = true;
        if (frame) frame.src = 'about:blank';
        if (canvas) {
            canvas.width = 1;
            canvas.height = 1;
        }
        try {
            if (fullscreenElement()) {
                const result = document.exitFullscreen?.() || document.webkitExitFullscreen?.();
                result?.catch?.(() => {});
            }
        } catch {}
        exitPseudoFullscreen();
        destroyDocument();
        document.body.classList.remove('site-pdf-reader-open');
        restorePageScroll();
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

    function setPage(value) {
        const parsed = Number.parseInt(value, 10) || 1;
        const next = Math.max(1, Math.min(state.numPages || Number.MAX_SAFE_INTEGER, parsed));
        if (next === state.page) {
            updateToolbar();
            return;
        }
        state.page = next;
        if (state.fallback) {
            const frame = byId('site-pdf-reader-frame');
            if (frame) frame.src = nativeViewerUrl();
            updateToolbar();
            return;
        }
        renderPage();
    }

    function nearestZoomIndex(percent) {
        let best = 0;
        let distance = Infinity;
        zoomSteps.forEach((value, index) => {
            const current = Math.abs(value - percent);
            if (current < distance) { distance = current; best = index; }
        });
        return best;
    }

    const activePointers = new Map();
    let gestureRenderTimer = 0;

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function clampStageScroll(stage) {
        if (!stage) return;
        const maxX = Math.max(0, stage.scrollWidth - stage.clientWidth);
        const maxY = Math.max(0, stage.scrollHeight - stage.clientHeight);
        stage.scrollLeft = clamp(stage.scrollLeft, 0, maxX);
        stage.scrollTop = clamp(stage.scrollTop, 0, maxY);
    }

    function currentPercent() {
        return clamp((state.currentCssScale || 1) * 100, 25, 500);
    }

    function canvasAnchorAt(clientX, clientY) {
        const canvas = byId('site-pdf-reader-canvas');
        if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return null;
        const rect = canvas.getBoundingClientRect();
        return {
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
        return canvasAnchorAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    // Redimensionne immédiatement le canvas en CSS sans recalculer les pixels.
    // Cela rend le pinch / Ctrl+molette fluide. Le rendu PDF haute qualité est
    // relancé juste après la fin du geste.
    function previewZoom(percent, anchor = null) {
        const stage = getStage();
        const canvas = byId('site-pdf-reader-canvas');
        if (!stage || !canvas || !state.pageBaseWidth || !state.pageBaseHeight) return;

        const nextPercent = clamp(percent, 25, 500);
        const savedAnchor = anchor || centerAnchor();
        const width = Math.max(1, state.pageBaseWidth * nextPercent / 100);
        const height = Math.max(1, state.pageBaseHeight * nextPercent / 100);

        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        state.currentCssScale = nextPercent / 100;

        // Laisse le navigateur recalculer la largeur du wrapper puis replace
        // exactement le même point du PDF sous le doigt / curseur.
        if (savedAnchor) {
            const rect = canvas.getBoundingClientRect();
            stage.scrollLeft += (rect.left + savedAnchor.fx * width) - savedAnchor.clientX;
            stage.scrollTop += (rect.top + savedAnchor.fy * height) - savedAnchor.clientY;
            clampStageScroll(stage);
        }

        const zoomInput = byId('site-pdf-reader-zoom-input');
        if (zoomInput && document.activeElement !== zoomInput) zoomInput.value = String(Math.round(nextPercent));
    }

    function scheduleCrispRender(delay = 90) {
        clearTimeout(gestureRenderTimer);
        gestureRenderTimer = window.setTimeout(() => {
            if (!state.pdf || state.fallback) return;
            renderPage({ quiet: true });
        }, delay);
    }

    function commitManualZoom(percent, anchor = null, renderDelay = 60) {
        const nextPercent = clamp(percent, 25, 500);
        state.manualZoomPercent = nextPercent;
        state.zoomIndex = -1;
        previewZoom(nextPercent, anchor);
        updateToolbar();
        scheduleCrispRender(renderDelay);
    }

    function applyZoomInput(value) {
        const input = byId('site-pdf-reader-zoom-input');
        const normalized = String(value ?? '').trim().replace(',', '.').replace('%', '');
        const parsed = Number.parseFloat(normalized);
        if (!Number.isFinite(parsed)) {
            if (input) input.value = String(Math.round(currentPercent()));
            return false;
        }
        const next = clamp(parsed, 25, 500);
        commitManualZoom(next, centerAnchor(), 60);
        if (input) input.value = String(Math.round(next));
        return true;
    }

    function zoom(delta) {
        const current = explicitZoomPercent() ?? currentPercent();
        const baseIndex = nearestZoomIndex(current);
        const nextIndex = clamp(baseIndex + delta, 0, zoomSteps.length - 1);
        const nextPercent = zoomSteps[nextIndex];
        state.manualZoomPercent = nextPercent;
        state.zoomIndex = nextIndex;
        previewZoom(nextPercent, centerAnchor());
        updateToolbar();
        scheduleCrispRender(40);
    }

    function fitWidth() {
        clearTimeout(gestureRenderTimer);
        state.manualZoomPercent = null;
        state.zoomIndex = -1;
        state.pinch = null;
        state.pan = null;
        updateToolbar();
        if (!state.fallback) renderPage({ quiet: true });
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
        const anchor = canvasAnchorAt(mid.x, mid.y);
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
        const liveAnchor = {
            ...state.pinch.anchor,
            clientX: mid.x,
            clientY: mid.y
        };
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
        scheduleCrispRender(80);
    }

    // MOBILE : utiliser volontairement Touch Events même lorsque PointerEvent
    // existe. Certains navigateurs Android annoncent PointerEvent mais ne nous
    // livrent pas correctement les deux pointeurs du pinch dans cette modale.
    function handleTouchStart(event) {
        if (!state.pdf || state.fallback) return;
        if (event.touches.length >= 2) {
            event.preventDefault();
            const a = pointFromTouch(event.touches[0]);
            const b = pointFromTouch(event.touches[1]);
            beginPinch(a, b);
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
            const a = pointFromTouch(event.touches[0]);
            const b = pointFromTouch(event.touches[1]);
            movePinch(a, b);
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

    // DESKTOP : clic gauche + glisser pour recadrer le document zoomé.
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

    // PC / trackpad : Ctrl + molette (et le pinch du trackpad, que Chrome
    // expose comme wheel+ctrlKey) zoome UNIQUEMENT le PDF.
    function handleWheel(event) {
        const modal = byId('site-pdf-reader');
        if (!modal || modal.hidden || !state.pdf || state.fallback || !event.ctrlKey) return;
        event.preventDefault();
        event.stopPropagation();

        const anchor = canvasAnchorAt(event.clientX, event.clientY) || centerAnchor();
        const factor = Math.exp(-event.deltaY * 0.0025);
        const next = clamp(currentPercent() * factor, 25, 500);
        state.manualZoomPercent = next;
        state.zoomIndex = -1;
        previewZoom(next, anchor);
        updateToolbar();
        scheduleCrispRender(120);
    }

    function fullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function fullscreenActive() {
        return Boolean(fullscreenElement() || state.pseudoFullscreen);
    }

    function isMobileViewport() {
        return window.matchMedia?.('(max-width: 760px)').matches ?? window.innerWidth <= 760;
    }

    function setFullscreenToolsCollapsed(collapsed) {
        const reader = byId('site-pdf-reader');
        const button = byId('site-pdf-reader-fs-tools-toggle');
        if (!reader) return;
        const value = Boolean(collapsed);
        reader.classList.toggle('site-pdf-reader-tools-collapsed', value);
        if (button) {
            button.setAttribute('aria-expanded', String(!value));
            button.setAttribute('aria-label', value ? 'Afficher les outils' : 'Masquer les outils');
            button.dataset.tooltip = value ? 'Afficher les outils' : 'Masquer les outils';
            const icon = button.querySelector('i');
            if (icon) {
                icon.classList.toggle('fa-chevron-down', value);
                icon.classList.toggle('fa-chevron-up', !value);
            }
        }
    }

    function updateFullscreenButton() {
        const button = byId('site-pdf-reader-fullscreen');
        if (!button) return;
        const active = fullscreenActive();
        button.setAttribute('aria-label', active ? 'Quitter le plein écran' : 'Plein écran');
        button.dataset.tooltip = active ? 'Quitter le plein écran' : 'Plein écran';
        const icon = button.querySelector('i');
        if (icon) {
            icon.classList.toggle('fa-expand', !active);
            icon.classList.toggle('fa-compress', active);
        }
    }

    function syncFullscreenLayout() {
        const reader = byId('site-pdf-reader');
        if (!reader) return;
        const mobileActive = fullscreenActive() && isMobileViewport();
        const wasMobileActive = reader.classList.contains('site-pdf-reader-mobile-fullscreen');
        reader.classList.toggle('site-pdf-reader-mobile-fullscreen', mobileActive);

        // En entrant en plein écran mobile, les outils secondaires sont repliés
        // par défaut : seule la navigation de pages reste visible.
        if (mobileActive && !wasMobileActive) setFullscreenToolsCollapsed(true);
        if (!mobileActive) setFullscreenToolsCollapsed(false);

        updateFullscreenButton();
        window.setTimeout(() => onResize(), 40);
    }

    function exitPseudoFullscreen() {
        state.pseudoFullscreen = false;
        byId('site-pdf-reader')?.classList.remove('site-pdf-reader-pseudo-fullscreen');
        syncFullscreenLayout();
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

        state.pseudoFullscreen = !state.pseudoFullscreen;
        reader.classList.toggle('site-pdf-reader-pseudo-fullscreen', state.pseudoFullscreen);
        syncFullscreenLayout();
    }

    let resizeTimer = 0;
    function onResize() {
        if (explicitZoomPercent() != null || !state.pdf || state.fallback) return;
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => renderPage(), 120);
    }

    function bindReaderUi() {
        document.querySelectorAll('[data-pdf-reader-close]').forEach(el => el.addEventListener('click', close));
        byId('site-pdf-reader-prev')?.addEventListener('click', () => setPage(state.page - 1));
        byId('site-pdf-reader-next')?.addEventListener('click', () => setPage(state.page + 1));
        byId('site-pdf-reader-page')?.addEventListener('change', event => setPage(event.target.value));
        byId('site-pdf-reader-page')?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                setPage(event.target.value);
                event.target.blur();
            }
        });
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

        const stage = getStage();
        // Doigts : Touch Events, sans dépendre de PointerEvent.
        stage?.addEventListener('touchstart', handleTouchStart, { passive: false });
        stage?.addEventListener('touchmove', handleTouchMove, { passive: false });
        stage?.addEventListener('touchend', handleTouchEnd, { passive: false });
        stage?.addEventListener('touchcancel', handleTouchEnd, { passive: false });

        // Souris : glisser pour déplacer le document.
        stage?.addEventListener('pointerdown', handleMousePointerDown, { passive: false });
        stage?.addEventListener('pointermove', handleMousePointerMove, { passive: false });
        stage?.addEventListener('pointerup', handleMousePointerUp, { passive: false });
        stage?.addEventListener('pointercancel', handleMousePointerUp, { passive: false });
        stage?.addEventListener('lostpointercapture', handleMousePointerUp, { passive: false });

        // Ctrl+molette / pinch trackpad : empêcher le zoom de la page et zoomer le PDF.
        stage?.addEventListener('wheel', handleWheel, { passive: false, capture: true });

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

        byId('site-pdf-reader-fullscreen')?.addEventListener('click', toggleFullscreen);
        byId('site-pdf-reader-fs-exit')?.addEventListener('click', toggleFullscreen);
        byId('site-pdf-reader-fs-tools-toggle')?.addEventListener('click', () => {
            const reader = byId('site-pdf-reader');
            if (!reader?.classList.contains('site-pdf-reader-mobile-fullscreen')) return;
            setFullscreenToolsCollapsed(!reader.classList.contains('site-pdf-reader-tools-collapsed'));
        });
        document.addEventListener('fullscreenchange', syncFullscreenLayout);
        document.addEventListener('webkitfullscreenchange', syncFullscreenLayout);

        document.addEventListener('keydown', event => {
            const modal = byId('site-pdf-reader');
            if (!modal || modal.hidden) return;
            if (event.key === 'Escape' && !document.fullscreenElement) close();
            else if (event.key === 'ArrowLeft' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) {
                event.preventDefault();
                setPage(state.page - 1);
            } else if (event.key === 'ArrowRight' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) {
                event.preventDefault();
                setPage(state.page + 1);
            } else if ((event.key === '+' || event.key === '=') && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) zoom(1);
            else if (event.key === '-' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) zoom(-1);
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
