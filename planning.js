(() => {
    'use strict';

    const SITE_SOURCE = 'planilim-site';
    const EXT_SOURCE = 'planilim-extension';
    const CACHE_KEY = 'planilim-ade-annual-payload-v1';
    const BRIDGE_TIMEOUT = 2500;
    const SYNC_TIMEOUT = 120000;

    const state = {
        extensionDetected: false,
        extensionVersion: null,
        status: null,
        payload: loadLocalPayload(),
        currentWeekStart: null,
        pending: new Map(),
        initialized: false
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function randomId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        return `planilim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function loadLocalPayload() {
        try {
            const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            return parsed?.events && Array.isArray(parsed.events) ? parsed : null;
        } catch {
            return null;
        }
    }

    function saveLocalPayload(payload) {
        if (!payload?.events || !Array.isArray(payload.events)) return;
        state.payload = payload;
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
        } catch (error) {
            console.warn('Cache local du planning indisponible :', error);
        }
    }

    function parseIsoDate(iso) {
        const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        const date = new Date(`${iso}T12:00:00`);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function toIsoDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function addDays(iso, days) {
        const date = parseIsoDate(iso);
        if (!date) return null;
        date.setDate(date.getDate() + days);
        return toIsoDate(date);
    }

    function mondayOf(isoOrDate = new Date()) {
        const date = isoOrDate instanceof Date
            ? new Date(isoOrDate.getFullYear(), isoOrDate.getMonth(), isoOrDate.getDate(), 12)
            : parseIsoDate(isoOrDate);

        if (!date) return null;

        const day = date.getDay();
        const diff = (day + 6) % 7;
        date.setDate(date.getDate() - diff);
        return toIsoDate(date);
    }

    function formatDate(iso, options) {
        const date = parseIsoDate(iso);
        if (!date) return '—';
        return new Intl.DateTimeFormat('fr-FR', options).format(date);
    }

    function formatWeekRange(firstDate) {
        const lastDate = addDays(firstDate, 6);
        if (!lastDate) return '—';
        const start = formatDate(firstDate, { day: 'numeric', month: 'short' });
        const end = formatDate(lastDate, { day: 'numeric', month: 'short', year: 'numeric' });
        return `${start} – ${end}`;
    }

    function requestExtension(type, { timeout = BRIDGE_TIMEOUT } = {}) {
        return new Promise((resolve, reject) => {
            const requestId = randomId();
            const timer = window.setTimeout(() => {
                state.pending.delete(requestId);
                reject(new Error('EXTENSION_TIMEOUT'));
            }, timeout);

            state.pending.set(requestId, {
                resolve,
                reject,
                timer
            });

            window.postMessage({
                source: SITE_SOURCE,
                type,
                requestId
            }, window.location.origin);
        });
    }

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== window.location.origin) return;

        const data = event.data || {};
        if (data.source !== EXT_SOURCE) return;

        if (data.type === 'PLANILIM_ADE_BRIDGE_READY') {
            state.extensionDetected = true;
            state.extensionVersion = data.payload?.version || null;
            updateStatusCards();
            requestStatusAndPayload().catch(console.warn);
            return;
        }

        const requestId = String(data.requestId || '');
        const pending = state.pending.get(requestId);
        if (!pending) return;

        clearTimeout(pending.timer);
        state.pending.delete(requestId);

        if (data.type === 'PLANILIM_ADE_ERROR') {
            pending.reject(new Error(data.payload?.message || 'Erreur extension.'));
            return;
        }

        state.extensionDetected = true;
        pending.resolve(data.payload);
    });

    function setLoading(active, title = 'Synchronisation en cours…', detail = 'ADE est interrogé directement par l’extension.') {
        const box = byId('planning-loading');
        if (!box) return;
        box.hidden = !active;
        if (active) {
            const titleEl = byId('planning-loading-title');
            const detailEl = byId('planning-loading-detail');
            if (titleEl) titleEl.textContent = title;
            if (detailEl) detailEl.textContent = detail;
        }

        ['planning-refresh', 'planning-full-sync'].forEach(id => {
            const button = byId(id);
            if (button) button.disabled = active;
        });
    }

    function updateStatusCards() {
        const extStatus = byId('planning-extension-status');
        const extDetail = byId('planning-extension-detail');
        const syncStatus = byId('planning-sync-status');
        const syncDetail = byId('planning-sync-detail');
        const cacheStatus = byId('planning-cache-status');
        const cacheDetail = byId('planning-cache-detail');
        const extWarning = byId('planning-extension-warning');
        const authWarning = byId('planning-auth-warning');

        if (extStatus) {
            extStatus.textContent = state.extensionDetected
                ? `Connectée${state.extensionVersion ? ` · v${state.extensionVersion}` : ''}`
                : 'Non détectée';
        }

        if (extDetail) {
            extDetail.textContent = state.extensionDetected
                ? `Ressource ADE ${state.status?.profile?.resourceId ?? 'configurée'}`
                : 'Le planning local peut rester consultable sans actualisation.';
        }

        if (extWarning) extWarning.hidden = state.extensionDetected;

        const sync = state.status?.academicSyncStatus;
        const cache = state.status?.academicSyncCacheSummary;

        if (syncStatus) {
            if (sync?.state === 'auth_required') {
                syncStatus.textContent = 'Reconnexion requise';
            } else if (sync?.state === 'running') {
                syncStatus.textContent = `En cours · ${sync.completedWeeks || 0}/${sync.requestedWeeks || '?'}`;
            } else if (cache?.updatedAt) {
                syncStatus.textContent = 'À jour';
            } else {
                syncStatus.textContent = 'En attente';
            }
        }

        if (syncDetail) {
            if (cache?.updatedAt) {
                syncDetail.textContent = `Dernière mise à jour : ${new Date(cache.updatedAt).toLocaleString('fr-FR')}`;
            } else {
                syncDetail.textContent = 'Aucune synchronisation annuelle disponible.';
            }
        }

        if (authWarning) {
            authWarning.hidden = sync?.state !== 'auth_required' && !cache?.authRequired;
        }

        const payload = state.payload;
        if (cacheStatus) {
            cacheStatus.textContent = payload
                ? `${payload.eventCount ?? payload.events?.length ?? 0} cours`
                : 'Aucun cache';
        }

        if (cacheDetail) {
            if (payload?.academicYear) {
                cacheDetail.textContent = `Année ${payload.academicYear} · ${payload.weekCount || 0} semaines`;
            } else if (payload) {
                cacheDetail.textContent = 'Données ADE disponibles localement.';
            } else {
                cacheDetail.textContent = 'Le cache sera créé à la première synchronisation.';
            }
        }
    }

    function payloadFromBridgeResult(result) {
        if (!result) return null;
        if (result.payload?.events) return result.payload;
        if (result.events) return result;
        return null;
    }

    async function requestStatusAndPayload() {
        try {
            const status = await requestExtension('PLANILIM_ADE_STATUS');
            state.status = status;
            state.extensionVersion = status?.extensionVersion || state.extensionVersion;
        } catch {
            state.extensionDetected = false;
        }

        if (state.extensionDetected) {
            try {
                const result = await requestExtension('PLANILIM_ADE_GET_PAYLOAD');
                const payload = payloadFromBridgeResult(result);
                if (payload) saveLocalPayload(payload);
            } catch (error) {
                console.warn('Payload ADE indisponible :', error);
            }
        }

        updateStatusCards();
        ensureCurrentWeek();
        renderWeek();
    }

    function ensureCurrentWeek() {
        if (state.currentWeekStart) return;
        const todayWeek = mondayOf(new Date());
        const payload = state.payload;

        if (!payload?.syncRange?.firstDate || !payload?.syncRange?.lastDate) {
            state.currentWeekStart = todayWeek;
            return;
        }

        if (todayWeek < payload.syncRange.firstDate) {
            state.currentWeekStart = mondayOf(payload.syncRange.firstDate);
        } else if (todayWeek > payload.syncRange.lastDate) {
            state.currentWeekStart = mondayOf(payload.syncRange.lastDate);
        } else {
            state.currentWeekStart = todayWeek;
        }
    }

    function eventsForDate(date) {
        return (state.payload?.events || [])
            .filter(event => event.date === date)
            .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
    }

    function eventMarkup(event) {
        const roomParts = [event.room, event.building].filter(Boolean);
        const group = event.group || '';
        const teacher = event.teacher || '';
        const type = event.type ? `<span class="planning-event-type">${escapePlanning(event.type)}</span>` : '';

        return `
            <article class="planning-event">
                <span class="planning-event-time">${escapePlanning(event.start || '—')} – ${escapePlanning(event.end || '—')}</span>
                <strong class="planning-event-title">${escapePlanning(event.title || 'Cours')}${type}</strong>
                <div class="planning-event-meta">
                    ${group ? `<span><i class="fa-solid fa-users"></i> ${escapePlanning(group)}</span>` : ''}
                    ${teacher ? `<span><i class="fa-solid fa-chalkboard-user"></i> ${escapePlanning(teacher)}</span>` : ''}
                    ${roomParts.length ? `<span><i class="fa-solid fa-location-dot"></i> ${escapePlanning(roomParts.join(' · '))}</span>` : ''}
                </div>
            </article>
        `;
    }

    function escapePlanning(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function renderWeek() {
        const grid = byId('planning-week-grid');
        const empty = byId('planning-empty');
        const label = byId('planning-week-label');
        const range = byId('planning-week-range');

        if (!grid) return;

        ensureCurrentWeek();
        const firstDate = state.currentWeekStart;
        if (!firstDate) return;

        const today = toIsoDate(new Date());
        const weekEvents = [];

        if (label) {
            const weekNumber = isoWeekNumber(firstDate);
            label.textContent = weekNumber ? `Semaine ${weekNumber}` : 'Semaine';
        }
        if (range) range.textContent = formatWeekRange(firstDate);

        const dayNames = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

        grid.innerHTML = dayNames.map((dayName, index) => {
            const date = addDays(firstDate, index);
            const events = eventsForDate(date);
            weekEvents.push(...events);

            return `
                <section class="planning-day ${date === today ? 'is-today' : ''}">
                    <header class="planning-day-header">
                        <strong>${dayName}</strong>
                        <span>${formatDate(date, { day: '2-digit', month: '2-digit' })}</span>
                    </header>
                    <div class="planning-day-events">
                        ${events.length
                            ? events.map(eventMarkup).join('')
                            : '<div class="planning-no-event"><span>Aucun cours</span></div>'}
                    </div>
                </section>
            `;
        }).join('');

        if (empty) empty.hidden = weekEvents.length !== 0;
    }

    function isoWeekNumber(iso) {
        const date = parseIsoDate(iso);
        if (!date) return null;

        const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = utc.getUTCDay() || 7;
        utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
        return Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
    }

    function moveWeek(delta) {
        state.currentWeekStart = addDays(state.currentWeekStart || mondayOf(new Date()), 7 * delta);
        renderWeek();
    }

    async function refreshSmart() {
        if (!state.extensionDetected) {
            updateStatusCards();
            return;
        }

        setLoading(true, 'Actualisation du planning…', 'L’extension met à jour la période utile depuis ADE.');

        try {
            const result = await requestExtension('PLANILIM_ADE_REFRESH', { timeout: SYNC_TIMEOUT });
            if (result?.code === 'AUTH_REQUIRED') {
                state.status = {
                    ...(state.status || {}),
                    academicSyncStatus: { state: 'auth_required' }
                };
            }

            const payload = payloadFromBridgeResult(result?.payload || result);
            if (payload) saveLocalPayload(payload);

            try {
                state.status = await requestExtension('PLANILIM_ADE_STATUS');
            } catch {}

            updateStatusCards();
            renderWeek();
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    }

    async function fullSync() {
        if (!state.extensionDetected) {
            updateStatusCards();
            return;
        }

        setLoading(true, 'Synchronisation annuelle…', 'Toutes les semaines de l’année universitaire sont vérifiées dans ADE.');

        try {
            const result = await requestExtension('PLANILIM_ADE_FULL_SYNC', { timeout: SYNC_TIMEOUT });
            if (result?.code === 'AUTH_REQUIRED') {
                state.status = {
                    ...(state.status || {}),
                    academicSyncStatus: { state: 'auth_required' }
                };
            }

            const payload = payloadFromBridgeResult(result?.payload || result);
            if (payload) saveLocalPayload(payload);

            try {
                const directPayload = await requestExtension('PLANILIM_ADE_GET_PAYLOAD', { timeout: 10000 });
                const normalized = payloadFromBridgeResult(directPayload);
                if (normalized) saveLocalPayload(normalized);
                state.status = await requestExtension('PLANILIM_ADE_STATUS');
            } catch {}

            updateStatusCards();
            renderWeek();
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    }

    function bindControls() {
        byId('planning-prev-week')?.addEventListener('click', () => moveWeek(-1));
        byId('planning-next-week')?.addEventListener('click', () => moveWeek(1));
        byId('planning-today')?.addEventListener('click', () => {
            state.currentWeekStart = mondayOf(new Date());
            renderWeek();
        });
        byId('planning-refresh')?.addEventListener('click', refreshSmart);
        byId('planning-full-sync')?.addEventListener('click', fullSync);
    }

    function init() {
        if (state.initialized) return;
        state.initialized = true;
        bindControls();
        ensureCurrentWeek();
        renderWeek();
        updateStatusCards();

        // The content script may have announced itself before planning.js loaded,
        // so actively probe the bridge as soon as the page is ready.
        requestStatusAndPayload().catch(console.warn);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

    window.planilimPlanning = {
        refresh: requestStatusAndPayload,
        render: renderWeek
    };
})();
