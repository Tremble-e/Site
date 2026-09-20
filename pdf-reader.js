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
        closingFromHistory: false
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
        const zoom = byId('site-pdf-reader-zoom-label');
        const prev = byId('site-pdf-reader-prev');
        const next = byId('site-pdf-reader-next');

        if (page) {
            page.value = String(Math.max(1, state.page || 1));
            page.max = state.numPages ? String(state.numPages) : '';
        }
        if (total) total.textContent = state.numPages ? `/ ${state.numPages}` : '';
        if (zoom) zoom.textContent = zoomLabel();
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

    async function renderPage() {
        if (!state.pdf || state.fallback) return;

        const serial = ++state.renderSerial;
        cancelRender();
        state.page = Math.max(1, Math.min(state.numPages || 1, Number(state.page) || 1));
        updateToolbar();
        setLoading(true, `Affichage de la page ${state.page}…`);

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
            setLoading(false);
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

    function zoom(delta) {
        const currentPercent = explicitZoomPercent() ?? Math.max(50, Math.min(250, state.currentCssScale * 100));
        const baseIndex = nearestZoomIndex(currentPercent);
        state.manualZoomPercent = null;
        state.zoomIndex = Math.max(0, Math.min(zoomSteps.length - 1, baseIndex + delta));
        updateToolbar();
        if (!state.fallback) renderPage();
    }

    function fitWidth() {
        state.manualZoomPercent = null;
        state.zoomIndex = -1;
        updateToolbar();
        if (!state.fallback) renderPage();
    }

    // Android/Chrome/Brave : utiliser Pointer Events plutôt que les anciens
    // événements touch*. Le navigateur nous confie ainsi explicitement les
    // deux pointeurs du pinch quand touch-action:none est appliqué au stage.
    const activePointers = new Map();

    function pointerDistance(points) {
        const dx = points[0].x - points[1].x;
        const dy = points[0].y - points[1].y;
        return Math.hypot(dx, dy);
    }

    function pointerMidpoint(points) {
        return {
            x: (points[0].x + points[1].x) / 2,
            y: (points[0].y + points[1].y) / 2
        };
    }

    function currentPointerPoints() {
        return Array.from(activePointers.values()).slice(0, 2);
    }

    function clampStageScroll(stage) {
        const maxX = Math.max(0, stage.scrollWidth - stage.clientWidth);
        const maxY = Math.max(0, stage.scrollHeight - stage.clientHeight);
        stage.scrollLeft = Math.max(0, Math.min(maxX, stage.scrollLeft));
        stage.scrollTop = Math.max(0, Math.min(maxY, stage.scrollTop));
    }

    function beginPanAt(point, pointerId = null) {
        if (!point || !state.pdf || state.fallback || state.pinch) return;
        const stage = getStage();
        if (!stage) return;
        state.pan = {
            pointerId,
            startX: point.x,
            startY: point.y,
            startScrollLeft: stage.scrollLeft,
            startScrollTop: stage.scrollTop
        };
    }

    function movePanAt(point, pointerId = null) {
        if (!state.pan || state.pinch || !point) return;
        if (state.pan.pointerId != null && pointerId != null && state.pan.pointerId !== pointerId) return;
        const stage = getStage();
        if (!stage) return;
        stage.scrollLeft = state.pan.startScrollLeft - (point.x - state.pan.startX);
        stage.scrollTop = state.pan.startScrollTop - (point.y - state.pan.startY);
        clampStageScroll(stage);
    }

    function beginPinchAt(points) {
        if (points.length < 2 || !state.pdf || state.fallback) return;
        const stage = getStage();
        const canvas = byId('site-pdf-reader-canvas');
        if (!stage || !canvas || !canvas.clientWidth || !canvas.clientHeight) return;

        const mid = pointerMidpoint(points);
        const canvasRect = canvas.getBoundingClientRect();
        state.pan = null;
        state.pinch = {
            startDistance: Math.max(1, pointerDistance(points)),
            startPercent: Math.max(25, state.currentCssScale * 100),
            anchorX: Math.max(0, Math.min(1, (mid.x - canvasRect.left) / Math.max(1, canvasRect.width))),
            anchorY: Math.max(0, Math.min(1, (mid.y - canvasRect.top) / Math.max(1, canvasRect.height))),
            lastPercent: Math.max(25, state.currentCssScale * 100)
        };
        stage.classList.add('pinching');
    }

    function movePinchAt(points) {
        if (!state.pinch || points.length < 2) return;
        const stage = getStage();
        const canvas = byId('site-pdf-reader-canvas');
        if (!stage || !canvas || !state.pageBaseWidth || !state.pageBaseHeight) return;

        const mid = pointerMidpoint(points);
        const ratio = pointerDistance(points) / state.pinch.startDistance;
        const percent = Math.max(40, Math.min(350, state.pinch.startPercent * ratio));
        const width = state.pageBaseWidth * percent / 100;
        const height = state.pageBaseHeight * percent / 100;

        // Redimensionnement visuel instantané pendant le geste. Le canvas n'est
        // rerendu en haute qualité qu'à la fin du pinch pour rester fluide.
        canvas.style.width = `${Math.max(1, width)}px`;
        canvas.style.height = `${Math.max(1, height)}px`;

        const resizedRect = canvas.getBoundingClientRect();
        stage.scrollLeft += (resizedRect.left + state.pinch.anchorX * width) - mid.x;
        stage.scrollTop += (resizedRect.top + state.pinch.anchorY * height) - mid.y;
        clampStageScroll(stage);

        state.pinch.lastPercent = percent;
        const zoom = byId('site-pdf-reader-zoom-label');
        if (zoom) zoom.textContent = `${Math.round(percent)} %`;
    }

    function finishPinch() {
        if (!state.pinch) return;
        const stage = getStage();
        const percent = state.pinch.lastPercent;
        state.pinch = null;
        stage?.classList.remove('pinching');
        state.manualZoomPercent = Math.max(40, Math.min(350, percent));
        state.zoomIndex = -1;
        state.currentCssScale = state.manualZoomPercent / 100;
        updateToolbar();

        const remaining = currentPointerPoints();
        if (remaining.length === 1) {
            const [pointerId, point] = Array.from(activePointers.entries())[0] || [];
            beginPanAt(point, pointerId);
        } else {
            state.pan = null;
        }

        if (!state.fallback) renderPage();
    }

    function handlePointerDown(event) {
        if (!state.pdf || state.fallback) return;
        // La souris conserve son comportement habituel. Les gestes personnalisés
        // sont réservés au tactile/stylet pour ne pas gêner le desktop.
        if (event.pointerType === 'mouse') return;
        const stage = getStage();
        if (!stage) return;

        event.preventDefault();
        try { stage.setPointerCapture(event.pointerId); } catch {}
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (activePointers.size >= 2) {
            if (!state.pinch) beginPinchAt(currentPointerPoints());
        } else {
            beginPanAt({ x: event.clientX, y: event.clientY }, event.pointerId);
        }
    }

    function handlePointerMove(event) {
        if (!activePointers.has(event.pointerId)) return;
        event.preventDefault();
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (activePointers.size >= 2) {
            const points = currentPointerPoints();
            if (!state.pinch) beginPinchAt(points);
            movePinchAt(points);
        } else if (activePointers.size === 1) {
            movePanAt({ x: event.clientX, y: event.clientY }, event.pointerId);
        }
    }

    function handlePointerUp(event) {
        if (!activePointers.has(event.pointerId)) return;
        event.preventDefault();
        activePointers.delete(event.pointerId);

        if (state.pinch && activePointers.size < 2) {
            finishPinch();
        } else if (activePointers.size === 0) {
            state.pan = null;
        } else if (activePointers.size === 1 && !state.pinch) {
            const [pointerId, point] = Array.from(activePointers.entries())[0];
            beginPanAt(point, pointerId);
        }
    }

    // Fallback pour de très vieux WebView ne prenant pas Pointer Events en charge.
    function handleTouchStartFallback(event) {
        if ('PointerEvent' in window) return;
        if (event.touches.length === 2) {
            event.preventDefault();
            beginPinchAt(Array.from(event.touches).map(t => ({ x: t.clientX, y: t.clientY })));
        } else if (event.touches.length === 1) {
            event.preventDefault();
            beginPanAt({ x: event.touches[0].clientX, y: event.touches[0].clientY });
        }
    }

    function handleTouchMoveFallback(event) {
        if ('PointerEvent' in window) return;
        if (event.touches.length === 2) {
            event.preventDefault();
            const points = Array.from(event.touches).map(t => ({ x: t.clientX, y: t.clientY }));
            if (!state.pinch) beginPinchAt(points);
            movePinchAt(points);
        } else if (event.touches.length === 1) {
            event.preventDefault();
            movePanAt({ x: event.touches[0].clientX, y: event.touches[0].clientY });
        }
    }

    function handleTouchEndFallback(event) {
        if ('PointerEvent' in window) return;
        if (state.pinch && event.touches.length < 2) finishPinch();
        if (event.touches.length === 0) state.pan = null;
    }

    let resizeTimer = 0;
    function onResize() {
        if (explicitZoomPercent() != null || !state.pdf || state.fallback) return;
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => renderPage(), 120);
    }

    document.addEventListener('DOMContentLoaded', () => {
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
        byId('site-pdf-reader-zoom-out')?.addEventListener('click', () => zoom(-1));
        byId('site-pdf-reader-zoom-in')?.addEventListener('click', () => zoom(1));
        byId('site-pdf-reader-fit')?.addEventListener('click', fitWidth);

        const stage = getStage();
        stage?.addEventListener('pointerdown', handlePointerDown, { passive: false });
        stage?.addEventListener('pointermove', handlePointerMove, { passive: false });
        stage?.addEventListener('pointerup', handlePointerUp, { passive: false });
        stage?.addEventListener('pointercancel', handlePointerUp, { passive: false });
        stage?.addEventListener('lostpointercapture', handlePointerUp, { passive: false });

        // Compatibilité ancien WebView uniquement : sur les navigateurs modernes,
        // Pointer Events est la seule voie utilisée afin d'éviter les doubles gestes.
        stage?.addEventListener('touchstart', handleTouchStartFallback, { passive: false });
        stage?.addEventListener('touchmove', handleTouchMoveFallback, { passive: false });
        stage?.addEventListener('touchend', handleTouchEndFallback, { passive: false });
        stage?.addEventListener('touchcancel', handleTouchEndFallback, { passive: false });

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

        byId('site-pdf-reader-fullscreen')?.addEventListener('click', async () => {
            const dialog = document.querySelector('.site-pdf-reader-dialog');
            try {
                if (document.fullscreenElement) await document.exitFullscreen();
                else await dialog?.requestFullscreen?.();
            } catch {}
        });

        document.addEventListener('keydown', event => {
            const modal = byId('site-pdf-reader');
            if (!modal || modal.hidden) return;
            if (event.key === 'Escape' && !document.fullscreenElement) close();
            else if (event.key === 'ArrowLeft' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) setPage(state.page - 1);
            else if (event.key === 'ArrowRight' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) setPage(state.page + 1);
            else if ((event.key === '+' || event.key === '=') && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) zoom(1);
            else if (event.key === '-' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) zoom(-1);
        });

        window.addEventListener('popstate', () => {
            const modal = byId('site-pdf-reader');
            if (!modal || modal.hidden) return;
            finalizeClose();
        });

        window.addEventListener('resize', onResize, { passive: true });
    });

    window.sitePdfReader = { open, close };
})();
