'use strict';

/* One reader for information images, forum attachments and study documents. */
(() => {
    const dialog = document.getElementById('imageLightbox');
    if (!dialog) return;
    const byId = suffix => document.getElementById('image-lightbox-' + suffix);
    const stage = byId('stage');
    const image = byId('img');
    const title = byId('title');
    const position = byId('position');
    const status = byId('status');
    const message = byId('message');
    const retry = byId('retry');
    const level = byId('zoom-level');
    const help = byId('help');
    const closeButton = byId('close');
    const previousButton = byId('previous');
    const nextButton = byId('next');
    const zoomIn = byId('zoom-in');
    const zoomOut = byId('zoom-out');
    const actualButton = byId('actual');
    const fitButton = byId('reset');
    const original = byId('original');
    const selector = '.info-block-img, .image-viewer, .info-document-image, .project-modal-media img, .forum-external-attachment.image img, .modal-pic';
    const state = {
        items: [], index: 0, scale: 1, x: 0, y: 0, fitRatio: 1,
        width: 0, height: 0, stageWidth: 0, stageHeight: 0,
        ready: false, frame: 0, pointers: new Map(), gesture: null,
        swipe: null, moved: false, lastTap: null, focus: null,
        scrollX: 0, scrollY: 0, inert: []
    };
    const MAX_SCALE = 16;
    const isOpen = () => !dialog.hidden;

    function entry(source) {
        const contextTitle = source instanceof Element
            ? source.closest('.modal-content, .info-block')?.querySelector('h2, h3')?.textContent.trim()
            : '';
        return { src: source.currentSrc || source.src, alt: source.alt || contextTitle || 'Image' };
    }

    function prepareSources(root) {
        const sources = [...(root.querySelectorAll?.(selector) || [])];
        if (root instanceof Element && root.matches(selector)) sources.unshift(root);
        sources.forEach(source => {
            if (source.closest('a, button, .admin-info-live-preview')) return;
            source.tabIndex = 0;
            source.setAttribute('role', 'button');
            source.setAttribute('aria-label', 'Agrandir : ' + entry(source).alt);
        });
    }
    prepareSources(document);
    new MutationObserver(records => records.forEach(record =>
        record.addedNodes.forEach(node => prepareSources(node))
    )).observe(document.body, { childList: true, subtree: true });

    function clampPan() {
        const maxX = Math.max(0, (state.width * state.scale - state.stageWidth) / 2);
        const maxY = Math.max(0, (state.height * state.scale - state.stageHeight) / 2);
        state.x = Math.max(-maxX, Math.min(maxX, state.x));
        state.y = Math.max(-maxY, Math.min(maxY, state.y));
    }

    function render() {
        state.frame = 0;
        clampPan();
        image.style.transform = 'translate3d(' + state.x + 'px,' + state.y + 'px,0) scale(' + state.scale + ')';
        stage.classList.toggle('zoomed', state.scale > 1.001);
        const zoomLabel = state.ready ? Math.round(state.fitRatio * state.scale * 100) + '%' : '—';
        if (level.value !== zoomLabel) level.value = zoomLabel;
        const touch = window.matchMedia('(pointer: coarse), (max-width: 880px)').matches;
        const hint = touch
            ? state.scale > 1.001 ? 'Pincer pour zoomer · Glisser pour déplacer'
                : state.items.length > 1 ? 'Glisser pour changer d’image · Pincer pour zoomer'
                    : 'Pincer ou toucher deux fois pour zoomer'
            : 'Molette ou double-clic pour zoomer · Glisser pour déplacer · Échap pour fermer';
        if (help.textContent !== hint) help.textContent = hint;
        zoomOut.disabled = !state.ready || state.scale <= 1.001;
        zoomIn.disabled = !state.ready || state.scale >= Math.max(MAX_SCALE, 1 / state.fitRatio) - .001;
        actualButton.disabled = !state.ready || Math.abs(state.fitRatio * state.scale - 1) < .01;
        fitButton.disabled = !state.ready;
        fitButton.setAttribute('aria-pressed', String(state.scale <= 1.001));
    }

    function scheduleRender() {
        if (!state.frame) state.frame = requestAnimationFrame(render);
    }

    function clearGesture() {
        state.pointers.forEach((point, id) => {
            try { stage.releasePointerCapture(id); } catch {}
        });
        state.pointers.clear();
        state.gesture = null;
        state.swipe = null;
        stage.classList.remove('dragging');
    }

    function fit(reset = true) {
        if (!isOpen() || !state.ready) return;
        const rect = stage.getBoundingClientRect();
        state.stageWidth = rect.width;
        state.stageHeight = rect.height;
        state.fitRatio = Math.min(1, Math.max(1, rect.width - 32) / image.naturalWidth,
            Math.max(1, rect.height - 24) / image.naturalHeight);
        state.width = image.naturalWidth * state.fitRatio;
        state.height = image.naturalHeight * state.fitRatio;
        image.style.width = state.width + 'px';
        image.style.height = state.height + 'px';
        if (reset) {
            state.scale = 1;
            state.x = state.y = 0;
            clearGesture();
        }
        render();
    }

    function zoom(scale, clientX, clientY) {
        if (!state.ready) return;
        const next = Math.max(1, Math.min(Math.max(MAX_SCALE, 1 / state.fitRatio), scale));
        const rect = stage.getBoundingClientRect();
        const anchorX = Number.isFinite(clientX) ? clientX - rect.left - rect.width / 2 : 0;
        const anchorY = Number.isFinite(clientY) ? clientY - rect.top - rect.height / 2 : 0;
        const ratio = next / state.scale;
        state.x = anchorX - (anchorX - state.x) * ratio;
        state.y = anchorY - (anchorY - state.y) * ratio;
        state.scale = next;
        scheduleRender();
    }

    function show(index) {
        if (index < 0 || index >= state.items.length) return;
        clearGesture();
        state.index = index;
        state.ready = false;
        state.scale = 1;
        state.x = state.y = 0;
        state.lastTap = null;
        const item = state.items[index];
        title.textContent = item.alt;
        position.textContent = state.items.length > 1 ? (index + 1) + ' / ' + state.items.length : '';
        const focusedControl = document.activeElement;
        previousButton.hidden = nextButton.hidden = state.items.length < 2;
        previousButton.disabled = index === 0;
        nextButton.disabled = index === state.items.length - 1;
        if (focusedControl === nextButton && nextButton.disabled) previousButton.focus({ preventScroll: true });
        if (focusedControl === previousButton && previousButton.disabled) nextButton.focus({ preventScroll: true });
        message.textContent = 'Chargement de l’image…';
        retry.hidden = true;
        status.hidden = false;
        stage.setAttribute('aria-busy', 'true');
        image.hidden = true;
        image.removeAttribute('src');
        image.alt = item.alt;
        const sourceUrl = new URL(item.src, window.location.href);
        if (['https:', 'http:', 'blob:'].includes(sourceUrl.protocol)) {
            original.href = sourceUrl.href;
            original.hidden = false;
        } else {
            original.removeAttribute('href');
            original.hidden = true;
        }
        render();
        image.src = item.src;
    }

    function open(source) {
        if (!source?.src) return;
        const infoBlock = source instanceof Element ? source.closest('.info-block[data-info-id]') : null;
        if (infoBlock) {
            const info = findInfoById(infoBlock.dataset.infoId);
            if (info?.section === 'studies' && !siteUniversityAccess.granted) {
                showToast('Vérifiez votre compte étudiant pour ouvrir cette image.');
                return;
            }
        }
        let candidates = [source];
        if (source instanceof HTMLImageElement && source.matches(selector)) {
            const scope = source.closest('.forum-post-body, .project-modal-media, .modal-body, .page-section');
            if (scope) candidates = [...scope.querySelectorAll(selector)].filter(candidate =>
                candidate.currentSrc && candidate.getClientRects().length && !candidate.closest('[inert], [hidden]'));
        }
        if (!candidates.includes(source)) candidates = [source];
        const items = candidates.map(entry).filter(item => item.src);
        if (!items.length) return;
        if (!isOpen()) {
            state.focus = source instanceof HTMLElement
                ? source.closest('a, button') || source
                : document.activeElement;
            state.scrollX = window.scrollX;
            state.scrollY = window.scrollY;
            state.inert = [...document.body.children].filter(element =>
                element !== dialog && !element.matches('script, link, style') && !element.inert);
            state.inert.forEach(element => { element.inert = true; });
        }
        state.items = items;
        dialog.hidden = false;
        document.body.classList.add('image-lightbox-open');
        if (typeof stopParticles === 'function') stopParticles();
        show(Math.max(0, candidates.indexOf(source)));
        requestAnimationFrame(() => {
            dialog.classList.add('active');
            closeButton.focus({ preventScroll: true });
        });
    }

    function close() {
        if (!isOpen()) return;
        clearGesture();
        if (state.frame) cancelAnimationFrame(state.frame);
        state.frame = 0;
        dialog.classList.remove('active');
        // Hide synchronously so rapid reopen and nested dialogs cannot steal focus.
        dialog.hidden = true;
        image.removeAttribute('src');
        state.ready = false;
        document.body.classList.remove('image-lightbox-open');
        if (typeof startParticles === 'function') startParticles();
        state.inert.forEach(element => { element.inert = false; });
        state.inert = [];
        if (state.focus?.isConnected) state.focus.focus({ preventScroll: true });
        window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: 'instant' });
    }

    image.addEventListener('load', () => {
        if (!isOpen() || !image.naturalWidth) return;
        state.ready = true;
        status.hidden = true;
        image.hidden = false;
        stage.setAttribute('aria-busy', 'false');
        fit();
    });
    image.addEventListener('error', () => {
        if (!isOpen() || !image.hasAttribute('src')) return;
        state.ready = false;
        image.hidden = true;
        stage.setAttribute('aria-busy', 'false');
        message.textContent = 'Impossible de charger cette image. Vous pouvez ouvrir l’original ou réessayer.';
        retry.hidden = false;
        status.hidden = false;
        render();
    });
    retry.addEventListener('click', () => show(state.index));
    fitButton.addEventListener('click', () => fit());
    zoomIn.addEventListener('click', () => zoom(state.scale * 1.4));
    zoomOut.addEventListener('click', () => zoom(state.scale / 1.4));
    actualButton.addEventListener('click', () => zoom(1 / state.fitRatio));
    closeButton.addEventListener('click', close);
    previousButton.addEventListener('click', () => show(state.index - 1));
    nextButton.addEventListener('click', () => show(state.index + 1));

    stage.addEventListener('wheel', event => {
        event.preventDefault();
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
        zoom(state.scale * Math.exp(Math.max(-.7, Math.min(.7, -delta * .002))), event.clientX, event.clientY);
    }, { passive: false });
    stage.addEventListener('dblclick', event => {
        if (!state.ready) return;
        event.preventDefault();
        zoom(state.scale > 1.01 ? 1 : 2.5, event.clientX, event.clientY);
    });

    function beginPinch() {
        const [a, b] = [...state.pointers.values()];
        if (!b) return;
        const rect = stage.getBoundingClientRect();
        const x = (a.x + b.x) / 2 - rect.left - rect.width / 2;
        const y = (a.y + b.y) / 2 - rect.top - rect.height / 2;
        state.gesture = {
            distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: state.scale,
            x: (x - state.x) / state.scale, y: (y - state.y) / state.scale
        };
        state.moved = true;
        state.swipe = null;
    }

    stage.addEventListener('pointerdown', event => {
        if (!state.ready || (event.pointerType === 'mouse' && event.button !== 0)) return;
        if (!state.pointers.size) {
            state.moved = false;
            state.swipe = { x: event.clientX, y: event.clientY, time: performance.now(), target: event.target };
        }
        state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        stage.setPointerCapture(event.pointerId);
        if (state.pointers.size === 2) beginPinch();
    });
    stage.addEventListener('pointermove', event => {
        const previous = state.pointers.get(event.pointerId);
        if (!previous) return;
        const point = { x: event.clientX, y: event.clientY };
        state.pointers.set(event.pointerId, point);
        const start = state.swipe;
        if (start && Math.hypot(point.x - start.x, point.y - start.y) > 7) state.moved = true;
        if (state.pointers.size >= 2 && state.gesture) {
            const [a, b] = [...state.pointers.values()];
            const rect = stage.getBoundingClientRect();
            const gesture = state.gesture;
            state.scale = Math.max(1, Math.min(Math.max(MAX_SCALE, 1 / state.fitRatio), gesture.scale * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance));
            state.x = (a.x + b.x) / 2 - rect.left - rect.width / 2 - gesture.x * state.scale;
            state.y = (a.y + b.y) / 2 - rect.top - rect.height / 2 - gesture.y * state.scale;
            stage.classList.add('dragging');
        } else if (state.scale > 1.001) {
            state.x += point.x - previous.x;
            state.y += point.y - previous.y;
            stage.classList.add('dragging');
        }
        scheduleRender();
    });

    function endPointer(event) {
        if (!state.pointers.has(event.pointerId)) return;
        state.pointers.delete(event.pointerId);
        try { stage.releasePointerCapture(event.pointerId); } catch {}
        if (state.pointers.size >= 2) { beginPinch(); return; }
        state.gesture = null;
        if (state.pointers.size) return;
        stage.classList.remove('dragging');
        const start = state.swipe;
        state.swipe = null;
        if (event.type !== 'pointerup') return;
        if (start && state.scale <= 1.001 && performance.now() - start.time < 700) {
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                show(state.index + (dx < 0 ? 1 : -1));
                return;
            }
        }
        // A tap on empty space never closes the viewer during pan or pinch.
        if (!state.moved && start?.target === stage) { close(); return; }
        if (!state.moved && event.pointerType === 'touch') {
            const now = performance.now();
            const last = state.lastTap;
            if (last && now - last.time < 320 && Math.hypot(last.x - event.clientX, last.y - event.clientY) < 28) {
                zoom(state.scale > 1.01 ? 1 : 2.5, event.clientX, event.clientY);
                state.lastTap = null;
            } else state.lastTap = { time: now, x: event.clientX, y: event.clientY };
        }
    }
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('lostpointercapture', event => {
        if (state.pointers.has(event.pointerId)) clearGesture();
    });
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(type =>
        stage.addEventListener(type, event => event.preventDefault(), { passive: false }));

    document.addEventListener('keydown', event => {
        if (!isOpen()) return;
        // Keep the current image dialog above the underlying project/account modal.
        event.stopImmediatePropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        if (event.key === 'Tab') {
            const controls = [...dialog.querySelectorAll('button:not(:disabled), a[href]')].filter(control =>
                !control.hidden && control.getClientRects().length);
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
                event.preventDefault(); last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault(); first?.focus();
            }
            return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (['+', '=', '-', '0', '1', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.preventDefault();
        if (event.key === '+' || event.key === '=') zoom(state.scale * 1.4);
        if (event.key === '-') zoom(state.scale / 1.4);
        if (event.key === '0') fit();
        if (event.key === '1') zoom(1 / state.fitRatio);
        if (event.key === 'Home') show(0);
        if (event.key === 'End') show(state.items.length - 1);
        if (event.key.startsWith('Arrow')) {
            if (state.scale <= 1.001) {
                if (event.key === 'ArrowLeft') show(state.index - 1);
                if (event.key === 'ArrowRight') show(state.index + 1);
            } else {
                state.x += event.key === 'ArrowLeft' ? 60 : event.key === 'ArrowRight' ? -60 : 0;
                state.y += event.key === 'ArrowUp' ? 60 : event.key === 'ArrowDown' ? -60 : 0;
                scheduleRender();
            }
        }
    }, true);
    document.addEventListener('click', event => {
        if (!(event.target instanceof Element) || !isPlainPrimaryActivation(event)) return;
        const source = event.target.closest(selector)
            || event.target.closest('.info-block-image-link, .forum-external-attachment.image')?.querySelector('img');
        if (!source || source.closest('.admin-info-live-preview')) return;
        event.preventDefault();
        event.stopPropagation();
        open(source);
    }, true);
    document.addEventListener('keydown', event => {
        if (isOpen() || !['Enter', ' '].includes(event.key) || !(event.target instanceof Element)) return;
        const source = event.target.closest(selector);
        if (!source || source.closest('a, button, .admin-info-live-preview')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        open(source);
    }, true);
    let resizeFrame = 0;
    new ResizeObserver(() => {
        if (!isOpen() || !state.ready || resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
            resizeFrame = 0;
            fit(false);
        });
    }).observe(stage);
    window.openImageLightbox = open;
    window.closeImageLightbox = close;
})();
