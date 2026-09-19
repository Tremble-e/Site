(() => {
    'use strict';

    const state = {
        url: '',
        title: '',
        page: 1,
        numPages: 0,
        zoomIndex: -1,
        documentId: '',
        fileName: '',
        pdf: null,
        loadingTask: null,
        renderTask: null,
        renderSerial: 0,
        fallback: false
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
        return state.zoomIndex < 0 ? 'Largeur' : `${zoomSteps[state.zoomIndex]} %`;
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
            const cssScale = state.zoomIndex < 0
                ? Math.max(0.1, stageAvailableWidth(baseViewport) / baseViewport.width)
                : zoomSteps[state.zoomIndex] / 100;
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
        state.documentId = String(documentId || '');
        state.fileName = String(fileName || '').trim();

        const modal = byId('site-pdf-reader');
        const label = byId('site-pdf-reader-title');
        const download = byId('site-pdf-reader-download');
        if (!modal) return false;

        if (label) label.textContent = state.title;
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

    function close() {
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

    function zoom(delta) {
        if (state.zoomIndex < 0) state.zoomIndex = zoomSteps.indexOf(100);
        state.zoomIndex = Math.max(0, Math.min(zoomSteps.length - 1, state.zoomIndex + delta));
        updateToolbar();
        if (!state.fallback) renderPage();
    }

    function fitWidth() {
        state.zoomIndex = -1;
        updateToolbar();
        if (!state.fallback) renderPage();
    }

    let resizeTimer = 0;
    function onResize() {
        if (state.zoomIndex >= 0 || !state.pdf || state.fallback) return;
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

        window.addEventListener('resize', onResize, { passive: true });
    });

    window.sitePdfReader = { open, close };
})();
