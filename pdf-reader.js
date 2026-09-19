(() => {
    'use strict';

    const state = { url: '', title: '', page: 1, zoomIndex: -1, documentId: '', fileName: '' };
    const zoomSteps = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250];
    const byId = id => document.getElementById(id);

    function safePdfUrl(value) {
        try {
            const url = new URL(String(value || ''), window.location.href);
            return ['http:', 'https:', 'blob:'].includes(url.protocol) ? url.href : '';
        } catch { return ''; }
    }

    function zoomValue() {
        return state.zoomIndex < 0 ? 'page-width' : String(zoomSteps[state.zoomIndex]);
    }

    function zoomLabel() {
        return state.zoomIndex < 0 ? 'Largeur' : `${zoomSteps[state.zoomIndex]} %`;
    }

    function viewerUrl() {
        if (!state.url) return 'about:blank';
        const base = state.url.split('#')[0];
        const fragment = new URLSearchParams({
            page: String(Math.max(1, state.page || 1)),
            zoom: zoomValue(),
            toolbar: '0',
            navpanes: '0',
            scrollbar: '1',
            view: 'FitH'
        });
        return `${base}#${fragment.toString()}`;
    }

    function render() {
        const frame = byId('site-pdf-reader-frame');
        const page = byId('site-pdf-reader-page');
        const zoom = byId('site-pdf-reader-zoom-label');
        const loading = byId('site-pdf-reader-loading');
        if (page) page.value = String(Math.max(1, state.page || 1));
        if (zoom) zoom.textContent = zoomLabel();
        if (loading) loading.hidden = false;
        if (frame) frame.src = viewerUrl();
    }

    function open({ title = 'Document PDF', url = '', documentId = '', fileName = '' } = {}) {
        const safe = safePdfUrl(url);
        if (!safe) return false;
        state.url = safe;
        state.title = String(title || 'Document PDF');
        state.page = 1;
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
        render();
        requestAnimationFrame(() => byId('site-pdf-reader-page')?.focus({ preventScroll: true }));
        return true;
    }

    function close() {
        const modal = byId('site-pdf-reader');
        const frame = byId('site-pdf-reader-frame');
        if (modal) modal.hidden = true;
        if (frame) frame.src = 'about:blank';
        document.body.classList.remove('site-pdf-reader-open');
        state.url = '';
        state.documentId = '';
        state.fileName = '';
    }

    function setPage(value) {
        const next = Math.max(1, Number.parseInt(value, 10) || 1);
        if (next === state.page) return;
        state.page = next;
        render();
    }

    function zoom(delta) {
        if (state.zoomIndex < 0) state.zoomIndex = zoomSteps.indexOf(100);
        state.zoomIndex = Math.max(0, Math.min(zoomSteps.length - 1, state.zoomIndex + delta));
        render();
    }

    document.addEventListener('DOMContentLoaded', () => {
        byId('site-pdf-reader-frame')?.addEventListener('load', () => {
            const loading = byId('site-pdf-reader-loading');
            if (loading) loading.hidden = true;
        });
        document.querySelectorAll('[data-pdf-reader-close]').forEach(el => el.addEventListener('click', close));
        byId('site-pdf-reader-prev')?.addEventListener('click', () => setPage(state.page - 1));
        byId('site-pdf-reader-next')?.addEventListener('click', () => setPage(state.page + 1));
        byId('site-pdf-reader-page')?.addEventListener('change', event => setPage(event.target.value));
        byId('site-pdf-reader-page')?.addEventListener('keydown', event => { if (event.key === 'Enter') setPage(event.target.value); });
        byId('site-pdf-reader-zoom-out')?.addEventListener('click', () => zoom(-1));
        byId('site-pdf-reader-zoom-in')?.addEventListener('click', () => zoom(1));
        byId('site-pdf-reader-fit')?.addEventListener('click', () => { state.zoomIndex = -1; render(); });
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
        });
    });

    window.sitePdfReader = { open, close };
})();
