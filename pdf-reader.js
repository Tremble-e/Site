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
        const stage = byId('site-pdf-reader-stage');
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

    function touchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.hypot(dx, dy);
    }

    function touchMidpoint(touches, stageRect) {
        return {
            x: ((touches[0].clientX + touches[1].clientX) / 2) - stageRect.left,
            y: ((touches[0].clientY + touches[1].clientY) / 2) - stageRect.top
        };
    }

    function beginPinch(event) {
        if (event.touches.length !== 2 || !state.pdf || state.fallback) return;
        const stage = byId('site-pdf-reader-stage');
        const canvas = byId('site-pdf-reader-canvas');
        if (!stage || !canvas || !canvas.clientWidth || !canvas.clientHeight) return;

        const stageRect = stage.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const mid = touchMidpoint(event.touches, stageRect);
        const canvasContentLeft = canvasRect.left - stageRect.left + stage.scrollLeft;
        const canvasContentTop = canvasRect.top - stageRect.top + stage.scrollTop;

        state.pinch = {
            startDistance: Math.max(1, touchDistance(event.touches)),
            startPercent: Math.max(25, state.currentCssScale * 100),
            anchorX: Math.max(0, Math.min(1, (stage.scrollLeft + mid.x - canvasContentLeft) / canvas.clientWidth)),
            anchorY: Math.max(0, Math.min(1, (stage.scrollTop + mid.y - canvasContentTop) / canvas.clientHeight)),
            lastPercent: Math.max(25, state.currentCssScale * 100)
        };
        stage.classList.add('pinching');
    }

    function movePinch(event) {
        if (!state.pinch || event.touches.length !== 2) return;
        const stage = byId('site-pdf-reader-stage');
        const canvas = byId('site-pdf-reader-canvas');
        if (!stage || !canvas || !state.pageBaseWidth || !state.pageBaseHeight) return;

        event.preventDefault();
        const stageRect = stage.getBoundingClientRect();
        const mid = touchMidpoint(event.touches, stageRect);
        const ratio = touchDistance(event.touches) / state.pinch.startDistance;
        const percent = Math.max(40, Math.min(300, state.pinch.startPercent * ratio));
        const width = state.pageBaseWidth * percent / 100;
        const height = state.pageBaseHeight * percent / 100;

        canvas.style.width = `${Math.max(1, width)}px`;
        canvas.style.height = `${Math.max(1, height)}px`;

        // Conserve sous les doigts la zone du PDF autour de laquelle le pincement a commencé.
        const resizedRect = canvas.getBoundingClientRect();
        const contentLeft = resizedRect.left - stageRect.left + stage.scrollLeft;
        const contentTop = resizedRect.top - stageRect.top + stage.scrollTop;
        stage.scrollLeft = contentLeft + state.pinch.anchorX * width - mid.x;
        stage.scrollTop = contentTop + state.pinch.anchorY * height - mid.y;

        state.pinch.lastPercent = percent;
        const zoom = byId('site-pdf-reader-zoom-label');
        if (zoom) zoom.textContent = `${Math.round(percent)} %`;
    }

    function endPinch(event) {
        if (!state.pinch || event.touches.length >= 2) return;
        const stage = byId('site-pdf-reader-stage');
        const percent = state.pinch.lastPercent;
        state.pinch = null;
        stage?.classList.remove('pinching');
        state.manualZoomPercent = Math.max(40, Math.min(300, percent));
        state.zoomIndex = -1;
        state.currentCssScale = state.manualZoomPercent / 100;
        updateToolbar();
        if (!state.fallback) renderPage();
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

        const stage = byId('site-pdf-reader-stage');
        stage?.addEventListener('touchstart', beginPinch, { passive: true });
        stage?.addEventListener('touchmove', movePinch, { passive: false });
        stage?.addEventListener('touchend', endPinch, { passive: true });
        stage?.addEventListener('touchcancel', endPinch, { passive: true });

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
