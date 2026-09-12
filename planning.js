(() => {
    'use strict';

    const SITE_SOURCE = 'planilim-site';
    const EXT_SOURCE = 'planilim-extension';
    const LEGACY_CACHE_KEY = 'planilim-ade-annual-payload-v1';
    const CACHE_KEY_PREFIX = 'planilim-ade-annual-payload-v2:';
    const SUPABASE_TABLE = 'user_planning_cache';
    const EXTENSION_STORE_URL = '';
    const EXTENSION_PACKAGE_URL = './downloads/planilim-ade-bridge-v3.1.0.zip';
    const BRIDGE_TIMEOUT = 2500;
    const SYNC_TIMEOUT = 180000;
    const SLOT_MINUTES = 15;
    const DEFAULT_DAY_START = 8 * 60;
    const DEFAULT_DAY_END = 18 * 60;

    const state = {
        extensionDetected: false,
        extensionVersion: null,
        status: null,
        payload: null,
        currentWeekStart: null,
        pending: new Map(),
        initialized: false,
        user: null,
        cloudAvailable: true,
        cloudLoaded: false,
        busy: false
    };

    const byId = id => document.getElementById(id);

    function randomId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        return `planilim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function getSupabase() {
        return window.getSiteSupabase?.() || null;
    }

    function userCacheKey(userId) {
        return `${CACHE_KEY_PREFIX}${userId}`;
    }

    function loadLocalPayload(userId) {
        if (!userId) return null;
        try {
            const scoped = JSON.parse(localStorage.getItem(userCacheKey(userId)) || 'null');
            if (scoped?.events && Array.isArray(scoped.events)) return scoped;

            const legacy = JSON.parse(localStorage.getItem(LEGACY_CACHE_KEY) || 'null');
            if (legacy?.events && Array.isArray(legacy.events)) {
                localStorage.setItem(userCacheKey(userId), JSON.stringify(legacy));
                localStorage.removeItem(LEGACY_CACHE_KEY);
                return legacy;
            }
        } catch (error) {
            console.warn('Cache local du planning indisponible :', error);
        }
        return null;
    }

    function saveLocalPayload(payload) {
        if (!state.user?.id || !payload?.events || !Array.isArray(payload.events)) return false;
        state.payload = payload;
        try {
            localStorage.setItem(userCacheKey(state.user.id), JSON.stringify(payload));
        } catch (error) {
            console.warn('Cache local du planning indisponible :', error);
        }
        return true;
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
        date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
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

    function isoWeekNumber(iso) {
        const date = parseIsoDate(iso);
        if (!date) return null;
        const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = utc.getUTCDay() || 7;
        utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
        return Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
    }

    function parseTime(value) {
        const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return null;
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
        return hour * 60 + minute;
    }

    function formatMinutes(total) {
        const safe = Math.max(0, Math.min(24 * 60, total));
        const hour = Math.floor(safe / 60);
        const minute = safe % 60;
        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }

    function escapePlanning(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function requestExtension(type, { timeout = BRIDGE_TIMEOUT } = {}) {
        return new Promise((resolve, reject) => {
            const requestId = randomId();
            const timer = window.setTimeout(() => {
                state.pending.delete(requestId);
                reject(new Error('EXTENSION_TIMEOUT'));
            }, timeout);

            state.pending.set(requestId, { resolve, reject, timer });
            window.postMessage({ source: SITE_SOURCE, type, requestId }, window.location.origin);
        });
    }

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const data = event.data || {};
        if (data.source !== EXT_SOURCE) return;

        if (data.type === 'PLANILIM_ADE_BRIDGE_READY') {
            state.extensionDetected = true;
            state.extensionVersion = data.payload?.version || null;
            updateConnectionUi();
            requestStatusAndPayload({ persistIfCloudEmpty: true }).catch(console.warn);
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

    function payloadFromBridgeResult(result) {
        if (!result) return null;
        if (result.payload?.events) return result.payload;
        if (result.events) return result;
        return null;
    }

    async function loadCloudPayload() {
        if (!state.user?.id) return null;
        const client = getSupabase();
        if (!client) return null;

        try {
            const { data, error } = await client
                .from(SUPABASE_TABLE)
                .select('academic_year,resource_id,event_count,week_count,payload,source_updated_at,updated_at')
                .eq('user_id', state.user.id)
                .order('updated_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error) throw error;
            state.cloudAvailable = true;
            state.cloudLoaded = Boolean(data);
            if (data?.payload?.events && Array.isArray(data.payload.events)) {
                const remoteTime = Date.parse(data.updated_at || data.payload.generatedAt || '') || 0;
                const localTime = Date.parse(state.payload?.generatedAt || '') || 0;
                if (!state.payload || remoteTime >= localTime) saveLocalPayload(data.payload);
                return data.payload;
            }
        } catch (error) {
            state.cloudAvailable = false;
            console.warn('Planning Supabase indisponible :', error);
        }
        return null;
    }

    async function persistPayloadToCloud(payload) {
        if (!state.user?.id || !payload?.events || !Array.isArray(payload.events)) return false;
        const client = getSupabase();
        if (!client) return false;

        try {
            const academicYear = payload.academicYear || 'courante';
            const resourceId = payload.resource?.id ?? null;
            const now = new Date().toISOString();
            const { error } = await client.from(SUPABASE_TABLE).upsert({
                user_id: state.user.id,
                academic_year: academicYear,
                resource_id: resourceId === null ? null : String(resourceId),
                event_count: payload.eventCount ?? payload.events.length,
                week_count: payload.weekCount ?? 0,
                payload,
                source_updated_at: payload.generatedAt || now,
                updated_at: now
            }, { onConflict: 'user_id,academic_year' });
            if (error) throw error;
            state.cloudAvailable = true;
            state.cloudLoaded = true;
            updateConnectionUi();
            return true;
        } catch (error) {
            state.cloudAvailable = false;
            console.warn('Enregistrement du planning dans Supabase impossible :', error);
            updateConnectionUi();
            return false;
        }
    }

    function syncState() {
        return state.status?.v3?.syncState || state.status?.academicSyncStatus || null;
    }

    function isConfigured() {
        return Boolean(state.status?.v3?.configured || state.status?.profile?.requestCaptured);
    }

    function updateConnectionUi() {
        const title = byId('planning-connection-title');
        const detail = byId('planning-connection-detail');
        const button = byId('planning-primary-action');
        const cloud = byId('planning-cloud-status');
        const lastSync = byId('planning-last-sync');
        const count = byId('planning-course-count');
        const authWarning = byId('planning-auth-warning');
        if (!title || !button) return;

        const cache = state.status?.academicSyncCacheSummary || null;
        const sync = syncState();
        const setupState = state.status?.v3?.setupState?.state || '';
        const syncStateName = sync?.state || '';
        const configured = isConfigured();
        const authRequired = syncStateName === 'auth_required' || cache?.authRequired;
        const running = state.busy || ['bootstrapping', 'syncing_initial_year'].includes(setupState) ||
            ['syncing', 'preparing_fresh_base', 'running'].includes(syncStateName);

        if (authWarning) authWarning.hidden = !authRequired;

        if (!state.extensionDetected) {
            title.textContent = 'Extension Planilim requise';
            detail.textContent = state.payload
                ? 'Votre planning sauvegardé reste disponible. Installez l’extension pour le mettre à jour depuis ADE.'
                : 'Installez l’extension pour connecter votre emploi du temps ADE.';
            button.innerHTML = '<i class="fa-solid fa-puzzle-piece"></i> Télécharger l’extension';
            button.dataset.action = 'install';
            button.disabled = false;
        } else if (running) {
            title.textContent = 'Synchronisation en cours';
            detail.textContent = 'ADE est interrogé automatiquement. Le planning sera actualisé dès que la synchronisation est terminée.';
            button.innerHTML = '<i class="fa-solid fa-arrows-rotate fa-spin"></i> Synchronisation…';
            button.dataset.action = 'busy';
            button.disabled = true;
        } else if (authRequired) {
            title.textContent = 'Reconnexion universitaire nécessaire';
            detail.textContent = 'Votre session UNILIM a expiré. Une reconnexion suffit pour reprendre la synchronisation.';
            button.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Se reconnecter à ADE';
            button.dataset.action = 'connect';
            button.disabled = false;
        } else if (!configured || ['waiting_for_ade', 'waiting_for_login'].includes(setupState)) {
            title.textContent = setupState ? 'Connexion à ADE en attente' : 'Connecter votre planning ADE';
            detail.textContent = setupState
                ? 'Terminez la connexion UNILIM dans l’onglet ADE. La détection reprend automatiquement.'
                : 'Une seule connexion est nécessaire. Planilim récupérera ensuite automatiquement l’année universitaire.';
            button.innerHTML = '<i class="fa-solid fa-link"></i> Connecter ADE';
            button.dataset.action = 'connect';
            button.disabled = false;
        } else {
            title.textContent = 'Planning ADE connecté';
            detail.textContent = cache?.eventCount
                ? `${cache.eventCount} cours sont disponibles. Vous pouvez lancer une mise à jour à tout moment.`
                : 'ADE est connecté. Lancez la première synchronisation.';
            button.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Synchroniser mon emploi du temps';
            button.dataset.action = 'sync';
            button.disabled = false;
        }

        if (count) count.textContent = `${state.payload?.eventCount ?? state.payload?.events?.length ?? 0} cours`;
        if (lastSync) {
            const value = cache?.updatedAt || state.payload?.generatedAt || null;
            lastSync.textContent = value
                ? `Mis à jour ${new Date(value).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                : 'Jamais synchronisé';
        }
        if (cloud) {
            cloud.innerHTML = state.cloudAvailable
                ? `<i class="fa-solid fa-cloud-check"></i> ${state.cloudLoaded ? 'Sauvegardé sur votre compte' : 'Sauvegarde cloud prête'}`
                : '<i class="fa-solid fa-cloud-exclamation"></i> Stockage cloud à configurer';
        }
    }

    function setLoading(active, title = 'Synchronisation en cours…', detail = 'ADE est interrogé directement par l’extension.') {
        state.busy = active;
        const box = byId('planning-loading');
        if (box) {
            box.hidden = !active;
            if (active) {
                if (byId('planning-loading-title')) byId('planning-loading-title').textContent = title;
                if (byId('planning-loading-detail')) byId('planning-loading-detail').textContent = detail;
            }
        }
        updateConnectionUi();
    }

    async function requestStatusAndPayload({ persistIfCloudEmpty = false } = {}) {
        if (!state.user) return;
        try {
            state.status = await requestExtension('PLANILIM_ADE_STATUS');
            state.extensionDetected = true;
            state.extensionVersion = state.status?.extensionVersion || state.extensionVersion;
        } catch {
            state.extensionDetected = false;
            state.status = null;
            updateConnectionUi();
            renderWeek();
            return;
        }

        try {
            const result = await requestExtension('PLANILIM_ADE_GET_PAYLOAD', { timeout: 10000 });
            const payload = payloadFromBridgeResult(result);
            if (payload) {
                saveLocalPayload(payload);
                if (persistIfCloudEmpty && !state.cloudLoaded) await persistPayloadToCloud(payload);
            }
        } catch (error) {
            if (error?.message !== 'EXTENSION_TIMEOUT') console.warn('Payload ADE indisponible :', error);
        }

        ensureCurrentWeek();
        updateConnectionUi();
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
        if (todayWeek < payload.syncRange.firstDate) state.currentWeekStart = mondayOf(payload.syncRange.firstDate);
        else if (todayWeek > payload.syncRange.lastDate) state.currentWeekStart = mondayOf(payload.syncRange.lastDate);
        else state.currentWeekStart = todayWeek;
    }

    function eventsForDate(date) {
        return (state.payload?.events || [])
            .filter(event => event.date === date)
            .sort((a, b) => (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0));
    }

    function courseKind(event) {
        const value = `${event.type || ''} ${event.group || ''} ${event.title || ''}`.toUpperCase();
        if (/(^|\W)TP(\W|$)/.test(value)) return 'tp';
        if (/(^|\W)TD(\W|$)/.test(value)) return 'td';
        if (/(^|\W)CM(\W|$)/.test(value)) return 'cm';
        if (/EXAM|PARTIEL|CONTR[ÔO]LE|\bDS\b|ÉPREUVE|EPREUVE/.test(value)) return 'exam';
        return 'other';
    }

    function typeLabel(event) {
        const raw = String(event.type || '').trim();
        if (raw) return raw.toUpperCase();
        const kind = courseKind(event);
        return kind === 'other' ? 'Cours' : kind.toUpperCase();
    }

    function computeDayBounds(events) {
        const starts = events.map(event => parseTime(event.start)).filter(Number.isFinite);
        const ends = events.map(event => parseTime(event.end)).filter(Number.isFinite);
        let start = starts.length ? Math.min(DEFAULT_DAY_START, Math.floor(Math.min(...starts) / 60) * 60) : DEFAULT_DAY_START;
        let end = ends.length ? Math.max(DEFAULT_DAY_END, Math.ceil(Math.max(...ends) / 60) * 60) : DEFAULT_DAY_END;
        start = Math.max(0, start);
        end = Math.min(24 * 60, end);
        if (end <= start) end = Math.min(24 * 60, start + 60);
        return { start, end };
    }

    function assignOverlapLanes(events) {
        const sorted = [...events]
            .map(event => ({ event, start: parseTime(event.start) ?? 0, end: parseTime(event.end) ?? 0 }))
            .sort((a, b) => a.start - b.start || a.end - b.end);
        const groups = [];
        let group = [];
        let groupEnd = -1;

        for (const item of sorted) {
            if (!group.length || item.start < groupEnd) {
                group.push(item);
                groupEnd = Math.max(groupEnd, item.end);
            } else {
                groups.push(group);
                group = [item];
                groupEnd = item.end;
            }
        }
        if (group.length) groups.push(group);

        const output = new Map();
        groups.forEach(items => {
            const lanes = [];
            items.forEach(item => {
                let lane = lanes.findIndex(end => end <= item.start);
                if (lane === -1) lane = lanes.length;
                lanes[lane] = item.end;
                output.set(item.event, { lane, laneCount: 0 });
            });
            const laneCount = Math.max(1, lanes.length);
            items.forEach(item => output.set(item.event, { ...output.get(item.event), laneCount }));
        });
        return output;
    }

    function eventMarkup(event, dayIndex, bounds, overlap) {
        const start = parseTime(event.start);
        const end = parseTime(event.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
        const startSlot = Math.max(0, Math.floor((start - bounds.start) / SLOT_MINUTES));
        const endSlot = Math.max(startSlot + 1, Math.ceil((end - bounds.start) / SLOT_MINUTES));
        const startRow = startSlot + 2;
        const endRow = endSlot + 2;
        const kind = courseKind(event);
        const roomParts = [event.room, event.building].filter(Boolean);
        const meta = [event.teacher, roomParts.join(' · ')].filter(Boolean);
        const lane = overlap?.lane ?? 0;
        const laneCount = overlap?.laneCount ?? 1;
        const laneWidth = 100 / laneCount;
        const laneLeft = lane * laneWidth;
        const tooltip = [
            `${event.start || '—'} – ${event.end || '—'}`,
            event.title || 'Cours',
            event.type || '',
            event.group || '',
            event.teacher || '',
            roomParts.join(' · ')
        ].filter(Boolean).join(' · ');

        return `
            <article class="planning-event planning-event-${kind}"
                style="grid-column:${dayIndex + 2};grid-row:${startRow}/${endRow};--lane-width:${laneWidth}%;--lane-left:${laneLeft}%;"
                title="${escapePlanning(tooltip)}">
                <div class="planning-event-topline">
                    <span class="planning-event-time">${escapePlanning(event.start || '—')}–${escapePlanning(event.end || '—')}</span>
                    <span class="planning-event-type">${escapePlanning(typeLabel(event))}</span>
                </div>
                <strong class="planning-event-title">${escapePlanning(event.title || 'Cours')}</strong>
                ${meta.length ? `<div class="planning-event-meta">${meta.map(item => `<span>${escapePlanning(item)}</span>`).join('')}</div>` : ''}
            </article>
        `;
    }

    function renderWeek() {
        const grid = byId('planning-week-grid');
        const empty = byId('planning-empty');
        const label = byId('planning-week-label');
        const range = byId('planning-week-range');
        if (!grid || !state.user) return;

        ensureCurrentWeek();
        const firstDate = state.currentWeekStart;
        if (!firstDate) return;

        const weekNumber = isoWeekNumber(firstDate);
        if (label) label.textContent = weekNumber ? `Semaine ${weekNumber}` : 'Semaine';
        if (range) range.textContent = formatWeekRange(firstDate);

        const today = toIsoDate(new Date());
        const dayNames = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
        const dayEvents = Array.from({ length: 7 }, (_, index) => eventsForDate(addDays(firstDate, index)));
        const allEvents = dayEvents.flat();
        const bounds = computeDayBounds(allEvents);
        const slotCount = Math.ceil((bounds.end - bounds.start) / SLOT_MINUTES);
        const rowTemplate = `58px repeat(${slotCount}, var(--planning-slot-height))`;

        const headers = dayNames.map((name, index) => {
            const date = addDays(firstDate, index);
            return `<div class="planning-day-head ${date === today ? 'is-today' : ''}" style="grid-column:${index + 2};grid-row:1">
                <strong>${name}</strong><span>${formatDate(date, { day: '2-digit', month: '2-digit' })}</span>
            </div>`;
        }).join('');

        let backgrounds = '';
        let timeLabels = '';
        for (let slot = 0; slot < slotCount; slot += 1) {
            const minute = bounds.start + slot * SLOT_MINUTES;
            const row = slot + 2;
            const major = minute % 60 === 0;
            const half = minute % 60 === 30;
            timeLabels += `<div class="planning-time-cell ${major ? 'is-hour' : half ? 'is-half' : ''}" style="grid-column:1;grid-row:${row}">${major ? `<span>${formatMinutes(minute)}</span>` : ''}</div>`;
            for (let day = 0; day < 7; day += 1) {
                backgrounds += `<div class="planning-slot ${major ? 'is-hour' : half ? 'is-half' : ''}" style="grid-column:${day + 2};grid-row:${row}"></div>`;
            }
        }

        const eventsMarkup = dayEvents.map((events, dayIndex) => {
            const lanes = assignOverlapLanes(events);
            return events.map(event => eventMarkup(event, dayIndex, bounds, lanes.get(event))).join('');
        }).join('');

        grid.style.gridTemplateRows = rowTemplate;
        grid.innerHTML = `
            <div class="planning-corner" style="grid-column:1;grid-row:1"><span>Heure</span></div>
            ${headers}
            ${backgrounds}
            ${timeLabels}
            ${eventsMarkup}
        `;

        if (empty) empty.hidden = allEvents.length !== 0;
    }

    function moveWeek(delta) {
        state.currentWeekStart = addDays(state.currentWeekStart || mondayOf(new Date()), 7 * delta);
        renderWeek();
    }

    function extensionInstallUrl() {
        return EXTENSION_STORE_URL || new URL(EXTENSION_PACKAGE_URL, window.location.href).href;
    }

    async function connectAde() {
        setLoading(true, 'Connexion à ADE…', 'Une fenêtre ADE va s’ouvrir. Connectez-vous à UNILIM si nécessaire.');
        try {
            await requestExtension('PLANILIM_ADE_CONNECT', { timeout: 20000 });
            await requestStatusAndPayload({ persistIfCloudEmpty: true });
        } catch (error) {
            console.warn('Connexion ADE en attente :', error);
        } finally {
            setLoading(false);
        }
    }

    async function syncNow() {
        setLoading(true, 'Synchronisation de l’emploi du temps…', 'Planilim vérifie automatiquement l’année universitaire dans ADE.');
        try {
            const result = await requestExtension('PLANILIM_ADE_FULL_SYNC', { timeout: SYNC_TIMEOUT });
            let payload = payloadFromBridgeResult(result?.payload || result);
            if (!payload) {
                const direct = await requestExtension('PLANILIM_ADE_GET_PAYLOAD', { timeout: 10000 });
                payload = payloadFromBridgeResult(direct);
            }
            if (payload) {
                saveLocalPayload(payload);
                await persistPayloadToCloud(payload);
            }
            try { state.status = await requestExtension('PLANILIM_ADE_STATUS'); } catch {}
            updateConnectionUi();
            renderWeek();
        } catch (error) {
            console.error('Synchronisation ADE impossible :', error);
        } finally {
            setLoading(false);
        }
    }

    async function primaryAction() {
        const action = byId('planning-primary-action')?.dataset.action;
        if (action === 'busy') return;
        if (action === 'install' || !state.extensionDetected) {
            window.location.href = extensionInstallUrl();
            return;
        }
        if (action === 'sync') await syncNow();
        else await connectAde();
    }

    function setPlanningAccess(user) {
        state.user = user || null;
        const navButton = document.querySelector('.nav-btn[data-target="planning"]');
        const navItem = navButton?.closest('li');
        if (navItem) navItem.hidden = !state.user;

        if (!state.user) {
            state.payload = null;
            state.cloudLoaded = false;
            if (byId('planning')?.classList.contains('active')) {
                document.querySelector('.nav-btn[data-target="about"]')?.click();
            }
            return;
        }

        state.payload = loadLocalPayload(state.user.id);
        if (window.location.hash === '#planning' && !byId('planning')?.classList.contains('active')) {
            navButton?.click();
        }
    }

    async function onAccountChanged(user) {
        setPlanningAccess(user);
        if (!state.user) return;
        await loadCloudPayload();
        ensureCurrentWeek();
        renderWeek();
        updateConnectionUi();
        await requestStatusAndPayload({ persistIfCloudEmpty: true });
    }

    function bindControls() {
        byId('planning-prev-week')?.addEventListener('click', () => moveWeek(-1));
        byId('planning-next-week')?.addEventListener('click', () => moveWeek(1));
        byId('planning-today')?.addEventListener('click', () => {
            state.currentWeekStart = mondayOf(new Date());
            renderWeek();
        });
        byId('planning-primary-action')?.addEventListener('click', primaryAction);
    }

    async function init() {
        if (state.initialized) return;
        state.initialized = true;
        bindControls();

        const client = getSupabase();
        let user = null;
        if (client) {
            try {
                const { data } = await client.auth.getSession();
                user = data?.session?.user || null;
            } catch {}
        }
        setPlanningAccess(user);

        if (state.user) {
            await loadCloudPayload();
            ensureCurrentWeek();
            renderWeek();
            updateConnectionUi();
            await requestStatusAndPayload({ persistIfCloudEmpty: true });
        }

        window.setInterval(() => {
            if (!state.user || !document.getElementById('planning')?.classList.contains('active')) return;
            if (state.extensionDetected) requestStatusAndPayload().catch(() => {});
        }, 6000);
    }

    const previousAccountChanged = window.onSiteAccountChanged;
    window.onSiteAccountChanged = async user => {
        await previousAccountChanged?.(user);
        await onAccountChanged(user);
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();

    window.planilimPlanning = {
        refresh: requestStatusAndPayload,
        render: renderWeek,
        onAccountChanged
    };
})();
