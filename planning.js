(() => {
    'use strict';

    const SITE_SOURCE = 'planilim-site';
    const EXT_SOURCE = 'planilim-extension';
    const LEGACY_CACHE_KEY = 'planilim-ade-annual-payload-v1';
    const CACHE_KEY_PREFIX = 'planilim-ade-annual-payload-v2:';
    const SUPABASE_TABLE = 'user_planning_cache';
    const EXTENSION_STORE_URL = '';
    const EXTENSION_PACKAGE_URL = './downloads/mon-emploi-du-temps-extension-v3.5.0.zip';
    const BRIDGE_TIMEOUT = 2500;
    const SYNC_TIMEOUT = 180000;
    const SLOT_MINUTES = 15;
    const DEFAULT_DAY_START = 8 * 60;
    const DEFAULT_DAY_END = 19 * 60;
    const STATUS_POLL_MS = 12000;
    const INSTALL_PROBE_MS = 1500;
    const INSTALL_PROBE_DURATION_MS = 120000;
    const FILTER_KEY_PREFIX = 'planilim-planning-filters-v1:';

    const state = {
        extensionDetected: false,
        extensionVersion: null,
        status: null,
        payload: null,
        currentWeekStart: null,
        mobileSelectedDate: null,
        viewMode: 'week',
        pending: new Map(),
        initialized: false,
        user: null,
        cloudAvailable: true,
        cloudLoaded: false,
        busy: false,
        bridgeProbePromise: null,
        installProbeTimer: null,
        installProbeDeadline: 0,
        waitingForInstall: false,
        filters: {
            kinds: { cm: true, td: true, tp: true, exam: true, other: true },
            selectedCourses: new Set(),
            courseMode: 'hide',
            excludedEvents: new Set(),
            showExcludedEvents: false
        },
        filterCatalogSignature: ''
    };

    const byId = id => document.getElementById(id);

    function randomId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        return `planilim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function getSupabase() {
        return window.getSiteSupabase?.() || null;
    }

    function isPlanningActive() {
        return byId('planning')?.classList.contains('active') || false;
    }

    function isStandaloneApp() {
        return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true;
    }

    function syncBodyModalState() {
        document.body.classList.toggle('modal-open', Boolean(document.querySelector('.modal-overlay.active')));
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

    function weekDates(firstDate) {
        return Array.from({ length: 7 }, (_, index) => addDays(firstDate, index));
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

    function extensionInstallUrl() {
        return EXTENSION_STORE_URL || new URL(EXTENSION_PACKAGE_URL, window.location.href).href;
    }

    function launchExtensionInstall() {
        const url = extensionInstallUrl();
        if (EXTENSION_STORE_URL) {
            window.open(url, '_blank', 'noopener,noreferrer');
            return;
        }

        const link = document.createElement('a');
        link.href = url;
        link.download = 'mon-emploi-du-temps-extension-v3.5.0.zip';
        link.rel = 'noopener';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
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

    function stopInstallProbe(found = false) {
        if (state.installProbeTimer) {
            window.clearInterval(state.installProbeTimer);
            state.installProbeTimer = null;
        }
        state.installProbeDeadline = 0;
        state.waitingForInstall = false;
        if (found) updateConnectionUi();
    }

    function startInstallProbe() {
        stopInstallProbe();
        state.waitingForInstall = true;
        state.installProbeDeadline = Date.now() + INSTALL_PROBE_DURATION_MS;
        updateConnectionUi();

        const probe = () => {
            if (!state.user) {
                stopInstallProbe();
                return;
            }
            if (Date.now() > state.installProbeDeadline || state.extensionDetected) {
                stopInstallProbe(state.extensionDetected);
                return;
            }
            requestStatusAndPayload({ persistIfCloudEmpty: true }).catch(() => {});
        };

        state.installProbeTimer = window.setInterval(probe, INSTALL_PROBE_MS);
        probe();
    }

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const data = event.data || {};
        if (data.source !== EXT_SOURCE) return;

        if (data.type === 'PLANILIM_ADE_BRIDGE_READY') {
            state.extensionDetected = true;
            state.extensionVersion = data.payload?.version || null;
            stopInstallProbe(true);
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
        stopInstallProbe(true);
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

    async function clearCloudPayload() {
        if (!state.user?.id) return true;
        const client = getSupabase();
        if (!client) return false;

        try {
            const { error } = await client
                .from(SUPABASE_TABLE)
                .delete()
                .eq('user_id', state.user.id);
            if (error) throw error;
            state.cloudAvailable = true;
            state.cloudLoaded = false;
            return true;
        } catch (error) {
            state.cloudAvailable = false;
            console.warn('Suppression du planning dans Supabase impossible :', error);
            return false;
        }
    }

    function clearLocalPlanningData() {
        if (state.user?.id) {
            try {
                localStorage.removeItem(userCacheKey(state.user.id));
                const filterKey = planningFilterStorageKey();
                if (filterKey) localStorage.removeItem(filterKey);
            } catch (error) {
                console.warn('Suppression du cache local impossible :', error);
            }
        }
        try { localStorage.removeItem(LEGACY_CACHE_KEY); } catch {}

        state.payload = null;
        state.cloudLoaded = false;
        state.currentWeekStart = mondayOf(new Date());
        state.mobileSelectedDate = toIsoDate(new Date());
        state.filterCatalogSignature = '';
        state.filters = {
            kinds: { cm: true, td: true, tp: true, exam: true, other: true },
            selectedCourses: new Set(),
            courseMode: 'hide',
            excludedEvents: new Set(),
            showExcludedEvents: false
        };
    }

    async function clearPlanningCompletely() {
        if (!state.user) return;

        const confirmed = window.siteConfirm
            ? await window.siteConfirm({
                title: 'Vider mon emploi du temps ?',
                message: 'Toutes les données de votre emploi du temps seront supprimées.',
                detail: 'Les données de votre emploi du temps, le cache local et la configuration de synchronisation seront remis à zéro. Vous pourrez ensuite choisir un nouvel emploi du temps.',
                confirmLabel: 'Vider et recommencer',
                danger: true
            })
            : window.confirm('Vider complètement votre emploi du temps et recommencer à zéro ?');

        if (!confirmed) return;

        setLoading(true, 'Remise à zéro…', 'Suppression de votre emploi du temps et de la configuration de synchronisation.');

        let extensionReset = !state.extensionDetected;
        let cloudReset = false;

        try {
            if (state.extensionDetected) {
                try {
                    const result = await requestExtension('PLANILIM_ADE_CLEAR', { timeout: 10000 });
                    extensionReset = Boolean(result?.ok);
                } catch (error) {
                    console.warn('Réinitialisation de l’extension impossible :', error);
                    extensionReset = false;
                }
            }

            cloudReset = await clearCloudPayload();
            clearLocalPlanningData();

            state.status = null;
            if (state.extensionDetected) {
                try {
                    state.status = await requestExtension('PLANILIM_ADE_STATUS', { timeout: 5000 });
                } catch {
                    state.status = null;
                }
            }

            renderPlanningFilters(true);
            renderWeek();
            updateConnectionUi();

            const message = extensionReset && cloudReset
                ? 'Emploi du temps vidé. Vous pouvez repartir de zéro.'
                : 'Emploi du temps local vidé. Certaines données distantes n’ont pas pu être réinitialisées.';
            if (typeof window.showToast === 'function') window.showToast(message);
        } finally {
            setLoading(false);
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
        const clearButton = byId('planning-clear-data');
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
        if (clearButton) {
            const hasSomethingToClear = Boolean(
                state.payload ||
                state.cloudLoaded ||
                configured ||
                cache?.updatedAt ||
                setupState
            );
            clearButton.hidden = !hasSomethingToClear;
            clearButton.disabled = running || state.busy;
        }

        if (!state.extensionDetected) {
            if (state.waitingForInstall) {
                title.textContent = 'Détection de l’extension en cours';
                detail.textContent = 'Installez l’extension dans votre navigateur puis revenez ici : la détection se fera automatiquement.';
                button.innerHTML = '<i class="fa-solid fa-rotate"></i> Revérifier maintenant';
                button.dataset.action = 'probe';
                button.disabled = false;
            } else {
                title.textContent = 'Extension de synchronisation requise';
                detail.textContent = state.payload
                    ? 'Votre emploi du temps reste disponible. Installez l’extension pour le mettre à jour.'
                    : 'Installez l’extension pour connecter votre emploi du temps.';
                if (isStandaloneApp()) detail.textContent += ' La détection reprend automatiquement après installation.';
                button.innerHTML = '<i class="fa-solid fa-puzzle-piece"></i> Télécharger l’extension';
                button.dataset.action = 'install';
                button.disabled = false;
            }
        } else if (running) {
            title.textContent = 'Synchronisation en cours';
            detail.textContent = 'Récupération de l’année universitaire en cours. Gardez ADE ouvert jusqu’à la fin.';
            button.innerHTML = '<i class="fa-solid fa-arrows-rotate fa-spin"></i> Synchronisation…';
            button.dataset.action = 'busy';
            button.disabled = true;
        } else if (authRequired) {
            title.textContent = 'Reconnexion nécessaire';
            detail.textContent = 'Votre session universitaire a expiré. Reconnectez-vous puis affichez le planning souhaité.';
            button.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Se reconnecter';
            button.dataset.action = 'connect';
            button.disabled = false;
        } else if (setupState === 'ade_closed' || (['waiting_for_ade', 'waiting_for_login', 'detected'].includes(setupState) && state.status?.selectedAdeOpen === false)) {
            title.textContent = 'ADE fermé';
            detail.textContent = 'ADE a été fermé avant la validation. La sélection a été annulée.';
            button.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Recommencer';
            button.dataset.action = 'connect';
            button.disabled = false;
        } else if (['waiting_for_ade', 'waiting_for_login'].includes(setupState)) {
            title.textContent = 'En attente de votre emploi du temps';
            detail.textContent = 'Connectez-vous si nécessaire puis affichez l’emploi du temps que vous souhaitez synchroniser. Rien ne changera avant votre validation.';
            button.innerHTML = '<i class="fa-regular fa-hourglass-half"></i> En attente de l’emploi du temps…';
            button.dataset.action = 'busy';
            button.disabled = true;
        } else if (setupState === 'detected') {
            const setup = state.status?.v3?.setupState || {};
            const planningInfo = setup.planningLabel || (setup.resourceId != null ? `Emploi du temps #${setup.resourceId}` : 'Emploi du temps détecté');
            title.textContent = 'Emploi du temps détecté';
            detail.textContent = `${planningInfo} est affiché. Vérifiez qu’il s’agit du bon emploi du temps avant de continuer.`;
            button.innerHTML = '<i class="fa-solid fa-check"></i> Valider et synchroniser';
            button.dataset.action = 'sync';
            button.disabled = false;
        } else if (!configured) {
            title.textContent = 'Choisir mon emploi du temps';
            detail.textContent = 'Ouvrez ADE, connectez-vous si nécessaire puis affichez l’emploi du temps que vous souhaitez utiliser.';
            button.innerHTML = '<i class="fa-solid fa-calendar-check"></i> Choisir mon emploi du temps';
            button.dataset.action = 'connect';
            button.disabled = false;
        } else if (cache?.updatedAt) {
            title.textContent = 'Emploi du temps synchronisé';
            detail.textContent = `${cache?.eventCount ?? state.payload?.events?.length ?? 0} cours sont disponibles. Vous pouvez fermer ADE.`;
            button.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Synchroniser à nouveau';
            button.dataset.action = 'sync';
            button.disabled = false;
        } else {
            const planningInfo = state.status?.profile?.planningLabel || (state.status?.profile?.resourceId != null ? `Emploi du temps #${state.status.profile.resourceId}` : 'Emploi du temps détecté');
            title.textContent = 'Emploi du temps détecté';
            detail.textContent = `${planningInfo} est prêt. Vérifiez-le puis lancez la synchronisation.`;
            button.innerHTML = '<i class="fa-solid fa-check"></i> Valider et synchroniser';
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
            cloud.hidden = true;
            cloud.textContent = '';
        }
    }

    function setLoading(active, title = 'Synchronisation en cours…', detail = 'La synchronisation est gérée directement par l’extension.') {
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
        if (!state.user) return null;
        if (state.bridgeProbePromise) return state.bridgeProbePromise;

        state.bridgeProbePromise = (async () => {
            try {
                state.status = await requestExtension('PLANILIM_ADE_STATUS');
                state.extensionDetected = true;
                state.extensionVersion = state.status?.extensionVersion || state.extensionVersion;
            } catch {
                state.extensionDetected = false;
                state.status = null;
                updateConnectionUi();
                renderWeek();
                return null;
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
            return state.status;
        })();

        try {
            return await state.bridgeProbePromise;
        } finally {
            state.bridgeProbePromise = null;
        }
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

    function ensureMobileSelectedDate(firstDate) {
        const dates = weekDates(firstDate);
        if (!dates.includes(state.mobileSelectedDate)) {
            const today = toIsoDate(new Date());
            state.mobileSelectedDate = dates.includes(today) ? today : firstDate;
        }
    }

    function planningFilterStorageKey() {
        return state.user?.id ? `${FILTER_KEY_PREFIX}${state.user.id}` : null;
    }

    function normalizeCourseKey(value) {
        return String(value || 'Cours')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLocaleLowerCase('fr');
    }

    function eventOccurrenceKey(event) {
        return [
            event.date || '', event.start || '', event.end || '', event.title || '', event.type || '',
            event.group || '', event.teacher || '', event.room || '', event.building || ''
        ].map(value => String(value).trim()).join('¦');
    }

    function resetPlanningFilters({ persist = true } = {}) {
        state.filters = {
            kinds: { cm: true, td: true, tp: true, exam: true, other: true },
            selectedCourses: new Set(),
            courseMode: 'hide',
            excludedEvents: new Set(),
            showExcludedEvents: false
        };
        if (persist) savePlanningFilters();
        renderPlanningFilters(true);
        renderWeek();
    }

    function resetIndividualCourseFilters() {
        state.filters.excludedEvents.clear();
        savePlanningFilters();
        renderPlanningFilters();
        renderWeek();
    }

    function loadPlanningFilters() {
        state.filters = {
            kinds: { cm: true, td: true, tp: true, exam: true, other: true },
            selectedCourses: new Set(),
            courseMode: 'hide',
            excludedEvents: new Set(),
            showExcludedEvents: false
        };
        state.filterCatalogSignature = '';
        const key = planningFilterStorageKey();
        if (!key) return;
        try {
            const saved = JSON.parse(localStorage.getItem(key) || 'null');
            if (!saved) return;
            state.filters = {
                kinds: {
                    cm: saved.kinds?.cm !== false,
                    td: saved.kinds?.td !== false,
                    tp: saved.kinds?.tp !== false,
                    exam: saved.kinds?.exam !== false,
                    other: saved.kinds?.other !== false
                },
                selectedCourses: new Set(Array.isArray(saved.selectedCourses) ? saved.selectedCourses : []),
                courseMode: saved.courseMode === 'only' ? 'only' : 'hide',
                excludedEvents: new Set(Array.isArray(saved.excludedEvents) ? saved.excludedEvents : []),
                showExcludedEvents: saved.showExcludedEvents === true
            };
        } catch {}
    }

    function savePlanningFilters() {
        const key = planningFilterStorageKey();
        if (!key) return;
        try {
            localStorage.setItem(key, JSON.stringify({
                kinds: state.filters.kinds,
                selectedCourses: [...state.filters.selectedCourses],
                courseMode: state.filters.courseMode,
                excludedEvents: [...state.filters.excludedEvents],
                showExcludedEvents: state.filters.showExcludedEvents
            }));
        } catch {}
    }

    function eventPassesBaseFilters(event) {
        const kind = courseKind(event);
        if (state.filters.kinds[kind] === false) return false;
        const selected = state.filters.selectedCourses.has(normalizeCourseKey(event.title));
        if (!state.filters.selectedCourses.size) return true;
        return state.filters.courseMode === 'only' ? selected : !selected;
    }

    function eventIsIndividuallyExcluded(event) {
        return state.filters.excludedEvents.has(eventOccurrenceKey(event));
    }

    function eventPassesFilters(event) {
        if (!eventPassesBaseFilters(event)) return false;
        if (!eventIsIndividuallyExcluded(event)) return true;
        return state.filters.showExcludedEvents;
    }

    function allCourseCatalog() {
        const map = new Map();
        for (const event of state.payload?.events || []) {
            const title = String(event.title || 'Cours').trim() || 'Cours';
            const key = normalizeCourseKey(title);
            if (!map.has(key)) map.set(key, title);
        }
        return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'fr', { sensitivity: 'base' }));
    }

    function renderPlanningFilters(force = false) {
        const list = byId('planning-course-filter-list');
        const badge = byId('planning-filter-badge');
        const summary = byId('planning-filter-summary');
        const showExcludedInput = byId('planning-show-excluded');
        const individualReset = byId('planning-individual-reset');
        if (!list) return;

        const catalog = allCourseCatalog();
        const signature = catalog.map(([key]) => key).join('|');
        if (force || signature !== state.filterCatalogSignature) {
            state.filterCatalogSignature = signature;
            list.innerHTML = catalog.length
                ? catalog.map(([key, title]) => `
                    <label class="planning-course-filter-item">
                        <input type="checkbox" data-planning-course="${escapePlanning(key)}" ${state.filters.selectedCourses.has(key) ? 'checked' : ''}>
                        <span class="planning-checkbox-ui" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
                        <span class="planning-course-filter-label">${escapePlanning(title)}</span>
                    </label>`).join('')
                : '<span class="planning-filter-empty">Aucune matière disponible.</span>';
        } else {
            list.querySelectorAll('input[data-planning-course]').forEach(input => {
                input.checked = state.filters.selectedCourses.has(input.dataset.planningCourse || '');
            });
        }

        document.querySelectorAll('input[data-planning-kind]').forEach(input => {
            input.checked = state.filters.kinds[input.dataset.planningKind] !== false;
        });
        document.querySelectorAll('[data-planning-course-mode]').forEach(button => {
            const active = button.dataset.planningCourseMode === state.filters.courseMode;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        if (showExcludedInput) showExcludedInput.checked = state.filters.showExcludedEvents;
        if (individualReset) individualReset.disabled = state.filters.excludedEvents.size === 0;

        const disabledKinds = Object.values(state.filters.kinds).filter(value => value === false).length;
        const selectedCourses = state.filters.selectedCourses.size;
        const excludedEvents = state.filters.excludedEvents.size;
        const activeCount = disabledKinds + selectedCourses + excludedEvents;
        if (badge) {
            badge.textContent = String(activeCount);
            badge.hidden = activeCount === 0;
        }
        if (summary) {
            const parts = [];
            if (disabledKinds) parts.push(`${disabledKinds} type${disabledKinds > 1 ? 's' : ''} masqué${disabledKinds > 1 ? 's' : ''}`);
            if (selectedCourses) parts.push(`${selectedCourses} matière${selectedCourses > 1 ? 's' : ''} ${state.filters.courseMode === 'only' ? 'affichée(s) uniquement' : 'masquée(s)'}`);
            if (excludedEvents) parts.push(`${excludedEvents} créneau${excludedEvents > 1 ? 'x' : ''} décoché${excludedEvents > 1 ? 's' : ''}${state.filters.showExcludedEvents ? ' (visible(s) barré(s))' : ''}`);
            summary.textContent = parts.length ? parts.join(' · ') : 'Tous les cours sont affichés.';
        }
    }

    function eventsForDate(date) {
        return (state.payload?.events || [])
            .filter(event => event.date === date && eventPassesFilters(event))
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
        // Garde une petite marge avant la première heure pleine : le premier
        // repère horaire est alors rendu exactement comme les suivants.
        if (start > 0 && start % 60 === 0) start = Math.max(0, start - SLOT_MINUTES);
        if (end <= start) end = Math.min(24 * 60, start + 60);
        return { start, end };
    }

    function isCompactPlanning() {
        return window.matchMedia?.('(max-width: 900px)')?.matches || false;
    }

    function effectiveViewMode() {
        return isCompactPlanning() ? 'day' : state.viewMode;
    }

    function updatePlanningNavigationHints(mode) {
        const isDay = mode === 'day';
        const previousLabel = isDay ? 'Jour précédent' : 'Semaine précédente';
        const nextLabel = isDay ? 'Jour suivant' : 'Semaine suivante';

        const previousButton = byId('planning-prev-week');
        const nextButton = byId('planning-next-week');
        if (previousButton) {
            previousButton.setAttribute('aria-label', previousLabel);
            previousButton.dataset.tooltip = previousLabel;
        }
        if (nextButton) {
            nextButton.setAttribute('aria-label', nextLabel);
            nextButton.dataset.tooltip = nextLabel;
        }
    }

    function applyViewMode() {
        const section = byId('planning');
        if (!section) return;
        const mode = effectiveViewMode();
        section.classList.toggle('planning-view-day', mode === 'day');
        section.classList.toggle('planning-view-week', mode === 'week');
        updatePlanningNavigationHints(mode);

        const weekButton = byId('planning-view-week');
        const dayButton = byId('planning-view-day');
        if (weekButton) {
            weekButton.classList.toggle('is-active', state.viewMode === 'week');
            weekButton.setAttribute('aria-pressed', String(state.viewMode === 'week'));
        }
        if (dayButton) {
            dayButton.classList.toggle('is-active', state.viewMode === 'day');
            dayButton.setAttribute('aria-pressed', String(state.viewMode === 'day'));
        }
    }

    function computeWeekSlotHeight(slotCount) {
        const viewport = Math.max(560, window.innerHeight || 760);
        const budget = Math.max(430, Math.min(590, viewport - 230));
        return Math.max(10.5, Math.min(14, budget / Math.max(1, slotCount)));
    }

    function currentMinuteOfDay() {
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    }

    function nowLineMarkup(bounds, className = '') {
        const minute = currentMinuteOfDay();
        if (minute < bounds.start || minute > bounds.end) return '';
        const slot = (minute - bounds.start) / SLOT_MINUTES;
        const now = new Date();
        const label = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        return `<div class="planning-now-line ${className}" style="--planning-now-slot:${slot}"><span>${label}</span></div>`;
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

    function eventSelectionMarkup(event, compact = false) {
        const key = eventOccurrenceKey(event);
        const checked = !eventIsIndividuallyExcluded(event);
        const label = checked ? 'Décocher ce créneau' : 'Réafficher ce créneau';
        return `
            <label class="planning-event-selection ${compact ? 'is-compact' : ''}" title="${label}" aria-label="${label}">
                <input type="checkbox" data-planning-event-key="${escapePlanning(key)}" ${checked ? 'checked' : ''}>
                <span class="planning-checkbox-ui" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
            </label>`;
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
        const roomLine = [event.room, event.building].filter(Boolean).join(' · ');
        const lane = overlap?.lane ?? 0;
        const laneCount = overlap?.laneCount ?? 1;
        const laneWidth = 100 / laneCount;
        const laneLeft = lane * laneWidth;
        const excluded = eventIsIndividuallyExcluded(event);
        const tooltip = [
            `${event.start || '—'} – ${event.end || '—'}`,
            event.title || 'Cours',
            event.type || '',
            event.group || '',
            event.teacher || '',
            roomLine
        ].filter(Boolean).join(' · ');

        return `
            <article class="planning-event planning-event-${kind} ${excluded ? 'is-individually-excluded' : ''}"
                style="grid-column:${dayIndex + 2};grid-row:${startRow}/${endRow};--lane-width:${laneWidth}%;--lane-left:${laneLeft}%;"
                title="${escapePlanning(tooltip)}">
                <div class="planning-event-topline">
                    <span class="planning-event-time">${escapePlanning(event.start || '—')}–${escapePlanning(event.end || '—')}</span>
                    <span class="planning-event-actions">
                        <span class="planning-event-type">${escapePlanning(typeLabel(event))}</span>
                        ${eventSelectionMarkup(event, true)}
                    </span>
                </div>
                <strong class="planning-event-title">${escapePlanning(event.title || 'Cours')}</strong>
                <div class="planning-event-meta">
                    ${event.teacher ? `<span>${escapePlanning(event.teacher)}</span>` : ''}
                    ${roomLine ? `<span>${escapePlanning(roomLine)}</span>` : ''}
                </div>
            </article>
        `;
    }

    function dayEventMarkup(event, bounds, overlap) {
        const start = parseTime(event.start);
        const end = parseTime(event.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
        const startSlot = Math.max(0, Math.floor((start - bounds.start) / SLOT_MINUTES));
        const endSlot = Math.max(startSlot + 1, Math.ceil((end - bounds.start) / SLOT_MINUTES));
        const kind = courseKind(event);
        const roomLine = [event.room, event.building].filter(Boolean).join(' · ');
        const lane = overlap?.lane ?? 0;
        const laneCount = overlap?.laneCount ?? 1;
        const laneWidth = 100 / laneCount;
        const laneLeft = lane * laneWidth;
        const duration = end - start;
        const sizeClass = duration < 75 ? 'is-short' : duration < 105 ? 'is-medium' : 'is-long';
        const excluded = eventIsIndividuallyExcluded(event);
        return `
            <article class="planning-day-event planning-event-${kind} ${sizeClass} ${excluded ? 'is-individually-excluded' : ''}"
                style="grid-column:2;grid-row:${startSlot + 1}/${endSlot + 1};--lane-width:${laneWidth}%;--lane-left:${laneLeft}%;">
                <div class="planning-day-event-topline">
                    <span class="planning-day-event-time">${escapePlanning(event.start || '—')}–${escapePlanning(event.end || '—')}</span>
                    <span class="planning-event-actions">
                        <span class="planning-day-event-type">${escapePlanning(typeLabel(event))}</span>
                        ${eventSelectionMarkup(event)}
                    </span>
                </div>
                <strong class="planning-day-event-title">${escapePlanning(event.title || 'Cours')}</strong>
                <div class="planning-day-event-meta">
                    ${event.teacher ? `<span><i class="fa-solid fa-user"></i>${escapePlanning(event.teacher)}</span>` : ''}
                    ${roomLine ? `<span><i class="fa-solid fa-location-dot"></i>${escapePlanning(roomLine)}</span>` : ''}
                </div>
            </article>`;
    }

    function renderDayTimeline(firstDate) {
        const tabs = byId('planning-mobile-day-tabs');
        const agenda = byId('planning-mobile-agenda');
        const label = byId('planning-mobile-selected-label');
        if (!tabs || !agenda) return;

        ensureMobileSelectedDate(firstDate);
        const today = toIsoDate(new Date());
        const dates = weekDates(firstDate);
        const shortDayNames = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

        tabs.innerHTML = dates.map((date, index) => {
            const courseCount = (state.payload?.events || []).filter(event => event.date === date && eventPassesBaseFilters(event) && !eventIsIndividuallyExcluded(event)).length;
            return `
                <button type="button" class="planning-mobile-day ${date === state.mobileSelectedDate ? 'is-selected' : ''} ${date === today ? 'is-today' : ''} ${index >= 5 ? 'is-weekend' : ''}" data-date="${date}">
                    <span class="planning-mobile-day-name">${shortDayNames[index]}</span>
                    <strong>${formatDate(date, { day: '2-digit' })}</strong>
                    <small>${formatDate(date, { month: '2-digit' })}</small>
                    <span class="planning-mobile-day-count ${courseCount ? 'has-courses' : ''}">${courseCount ? `${courseCount} cours` : 'Libre'}</span>
                </button>`;
        }).join('');

        const selectedDate = state.mobileSelectedDate;
        const events = eventsForDate(selectedDate);
        if (label) label.textContent = `${formatDate(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })}`;

        const bounds = computeDayBounds(events);
        const slotCount = Math.ceil((bounds.end - bounds.start) / SLOT_MINUTES);
        const lanes = assignOverlapLanes(events);
        let background = '';
        let labels = '';
        for (let slot = 0; slot < slotCount; slot += 1) {
            const minute = bounds.start + slot * SLOT_MINUTES;
            const major = minute % 60 === 0;
            const half = minute % 60 === 30;
            const lunch = minute >= 12 * 60 && minute < 13 * 60;
            labels += `<div class="planning-day-time ${major ? 'is-hour' : half ? 'is-half' : ''} ${slot === 0 ? 'is-first' : ''}" style="grid-column:1;grid-row:${slot + 1}">${major ? `<span>${formatMinutes(minute)}</span>` : ''}</div>`;
            background += `<div class="planning-day-slot ${major ? 'is-hour' : half ? 'is-half' : ''} ${lunch ? 'is-lunch' : ''}" style="grid-column:2;grid-row:${slot + 1}"></div>`;
        }

        const eventsMarkup = events.map(event => dayEventMarkup(event, bounds, lanes.get(event))).join('');
        const nowMarkup = selectedDate === today ? nowLineMarkup(bounds, 'planning-now-line-day') : '';
        const daySlotHeight = isCompactPlanning() ? 15 : 14;

        agenda.innerHTML = `
            <div class="planning-day-timeline ${events.length ? '' : 'is-empty'}" style="--planning-day-slot-height:${daySlotHeight}px;grid-template-rows:repeat(${slotCount}, var(--planning-day-slot-height));">
                ${background}
                ${labels}
                ${eventsMarkup}
                ${nowMarkup}
                <div class="planning-day-end-label"><span>${formatMinutes(bounds.end)}</span></div>
            </div>`;
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

        applyViewMode();
        renderPlanningFilters();
        const weekNumber = isoWeekNumber(firstDate);
        if (label) label.textContent = weekNumber ? `Semaine ${weekNumber}` : 'Semaine';
        if (range) range.textContent = formatWeekRange(firstDate);

        const today = toIsoDate(new Date());
        const dayNames = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
        const dates = weekDates(firstDate);
        const dayEvents = dates.map(date => eventsForDate(date));
        const allEvents = dayEvents.flat();
        const bounds = computeDayBounds(allEvents);
        const slotCount = Math.ceil((bounds.end - bounds.start) / SLOT_MINUTES);
        const weekSlotHeight = computeWeekSlotHeight(slotCount);
        const rowTemplate = `var(--planning-header-height) repeat(${slotCount}, var(--planning-slot-height))`;

        const headers = dayNames.map((name, index) => {
            const date = dates[index];
            return `<div class="planning-day-head ${date === today ? 'is-today' : ''} ${index >= 5 ? 'is-weekend' : ''}" style="grid-column:${index + 2};grid-row:1">
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
            const lunch = minute >= 12 * 60 && minute < 13 * 60;
            timeLabels += `<div class="planning-time-cell ${major ? 'is-hour' : half ? 'is-half' : ''} ${lunch ? 'is-lunch' : ''} ${slot === 0 ? 'is-first' : ''}" style="grid-column:1;grid-row:${row}">${major ? `<span>${formatMinutes(minute)}</span>` : ''}</div>`;
            for (let day = 0; day < 7; day += 1) {
                const date = dates[day];
                backgrounds += `<div class="planning-slot ${major ? 'is-hour' : half ? 'is-half' : ''} ${lunch ? 'is-lunch' : ''} ${date === today ? 'is-today' : ''} ${day >= 5 ? 'is-weekend' : ''}" style="grid-column:${day + 2};grid-row:${row}"></div>`;
            }
        }

        const eventsMarkup = dayEvents.map((events, dayIndex) => {
            const lanes = assignOverlapLanes(events);
            return events.map(event => eventMarkup(event, dayIndex, bounds, lanes.get(event))).join('');
        }).join('');

        const nowMarkup = dates.includes(today) ? nowLineMarkup(bounds, 'planning-now-line-week') : '';
        grid.style.setProperty('--planning-slot-height', `${weekSlotHeight.toFixed(2)}px`);
        grid.style.gridTemplateRows = rowTemplate;
        grid.innerHTML = `
            <div class="planning-corner" style="grid-column:1;grid-row:1"><span>Heure</span></div>
            ${headers}
            ${backgrounds}
            ${timeLabels}
            ${eventsMarkup}
            ${nowMarkup}
            <div class="planning-time-end-label"><span>${formatMinutes(bounds.end)}</span></div>
        `;

        renderDayTimeline(firstDate);

        if (empty) {
            const rawWeekCount = (state.payload?.events || []).filter(event => dates.includes(event.date)).length;
            const emptyTitle = empty.querySelector('h2');
            const emptyText = empty.querySelector('p');
            empty.hidden = allEvents.length !== 0;
            if (!empty.hidden && rawWeekCount > 0) {
                if (emptyTitle) emptyTitle.textContent = 'Aucun cours avec ces filtres';
                if (emptyText) emptyText.textContent = 'Modifiez ou réinitialisez les filtres pour réafficher les cours de cette semaine.';
            } else {
                if (emptyTitle) emptyTitle.textContent = 'Aucun cours cette semaine';
                if (emptyText) emptyText.textContent = 'Cette semaine est vide dans l’emploi du temps actuellement synchronisé.';
            }
        }
    }

    function moveWeek(delta) {
        if (effectiveViewMode() === 'day') {
            const current = state.mobileSelectedDate || toIsoDate(new Date());
            const next = addDays(current, delta);
            state.mobileSelectedDate = next;
            state.currentWeekStart = mondayOf(next);
        } else {
            state.currentWeekStart = addDays(state.currentWeekStart || mondayOf(new Date()), 7 * delta);
            state.mobileSelectedDate = null;
        }
        renderWeek();
    }

    async function connectAde() {
        setLoading(true, 'Ouverture d’ADE…', 'Connectez-vous si nécessaire puis affichez l’emploi du temps à synchroniser.');
        try {
            await requestExtension('PLANILIM_ADE_CONNECT', { timeout: 20000 });
            await requestStatusAndPayload({ persistIfCloudEmpty: true });
        } catch (error) {
            console.warn('Connexion universitaire en attente :', error);
        } finally {
            setLoading(false);
        }
    }

    async function syncNow() {
        setLoading(true, 'Synchronisation de l’emploi du temps…', 'L’année universitaire est récupérée automatiquement.');
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
            console.error('Synchronisation impossible :', error);
        } finally {
            setLoading(false);
        }
    }

    async function primaryAction() {
        const action = byId('planning-primary-action')?.dataset.action;
        if (action === 'busy') return;
        if (action === 'probe') {
            await requestStatusAndPayload({ persistIfCloudEmpty: true });
            return;
        }
        if (action === 'install' || !state.extensionDetected) {
            startInstallProbe();
            launchExtensionInstall();
            return;
        }
        if (action === 'sync') await syncNow();
        else await connectAde();
    }

    function openTutorial() {
        const modal = byId('planning-tutorial-modal');
        if (!modal) return;
        modal.classList.add('active');
        syncBodyModalState();
        byId('planning-tutorial-close')?.focus();
    }

    function closeTutorial() {
        byId('planning-tutorial-modal')?.classList.remove('active');
        syncBodyModalState();
    }

    function setPlanningAccess(user) {
        state.user = user || null;
        const navButton = document.querySelector('.nav-btn[data-target="planning"]');
        const navItem = navButton?.closest('li');
        if (navItem) navItem.hidden = !state.user;

        if (!state.user) {
            state.payload = null;
            state.cloudLoaded = false;
            state.currentWeekStart = null;
            state.mobileSelectedDate = null;
            state.filters = { kinds: { cm: true, td: true, tp: true, exam: true, other: true }, selectedCourses: new Set(), courseMode: 'hide', excludedEvents: new Set(), showExcludedEvents: false };
            state.filterCatalogSignature = '';
            stopInstallProbe();
            if (byId('planning')?.classList.contains('active')) {
                document.querySelector('.nav-btn[data-target="about"]')?.click();
            }
            return;
        }

        state.payload = loadLocalPayload(state.user.id);
        loadPlanningFilters();
        renderPlanningFilters(true);
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
            state.mobileSelectedDate = toIsoDate(new Date());
            renderWeek();
        });
        byId('planning-primary-action')?.addEventListener('click', primaryAction);
        byId('planning-open-tutorial')?.addEventListener('click', openTutorial);
        byId('planning-clear-data')?.addEventListener('click', clearPlanningCompletely);
        byId('planning-tutorial-close')?.addEventListener('click', closeTutorial);
        byId('planning-tutorial-modal')?.addEventListener('click', event => {
            if (event.target === event.currentTarget) closeTutorial();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && byId('planning-tutorial-modal')?.classList.contains('active')) closeTutorial();
        });
        byId('planning-mobile-day-tabs')?.addEventListener('click', event => {
            const button = event.target.closest('.planning-mobile-day');
            if (!button) return;
            state.mobileSelectedDate = button.dataset.date || null;
            if (state.currentWeekStart) renderDayTimeline(state.currentWeekStart);
        });

        byId('planning-view-week')?.addEventListener('click', () => {
            state.viewMode = 'week';
            renderWeek();
        });
        byId('planning-view-day')?.addEventListener('click', () => {
            state.viewMode = 'day';
            ensureMobileSelectedDate(state.currentWeekStart || mondayOf(new Date()));
            renderWeek();
        });

        byId('planning-filter-toggle')?.addEventListener('click', () => {
            const panel = byId('planning-filter-panel');
            const button = byId('planning-filter-toggle');
            if (!panel) return;
            panel.hidden = !panel.hidden;
            button?.setAttribute('aria-expanded', String(!panel.hidden));
            if (!panel.hidden) renderPlanningFilters(true);
        });

        byId('planning')?.addEventListener('change', event => {
            const eventInput = event.target.closest('input[data-planning-event-key]');
            if (!eventInput) return;
            const key = eventInput.dataset.planningEventKey || '';
            if (!key) return;
            if (eventInput.checked) state.filters.excludedEvents.delete(key);
            else state.filters.excludedEvents.add(key);
            savePlanningFilters();
            renderPlanningFilters();
            renderWeek();
        });

        byId('planning-filter-panel')?.addEventListener('change', event => {
            const showExcludedInput = event.target.closest('#planning-show-excluded');
            if (showExcludedInput) {
                state.filters.showExcludedEvents = showExcludedInput.checked;
                savePlanningFilters();
                renderPlanningFilters();
                renderWeek();
                return;
            }
            const kindInput = event.target.closest('input[data-planning-kind]');
            if (kindInput) {
                state.filters.kinds[kindInput.dataset.planningKind] = kindInput.checked;
                savePlanningFilters();
                renderPlanningFilters();
                renderWeek();
                return;
            }
            const courseInput = event.target.closest('input[data-planning-course]');
            if (courseInput) {
                const key = courseInput.dataset.planningCourse || '';
                if (courseInput.checked) state.filters.selectedCourses.add(key);
                else state.filters.selectedCourses.delete(key);
                savePlanningFilters();
                renderPlanningFilters();
                renderWeek();
            }
        });

        byId('planning-filter-panel')?.addEventListener('click', event => {
            const modeButton = event.target.closest('[data-planning-course-mode]');
            if (modeButton) {
                state.filters.courseMode = modeButton.dataset.planningCourseMode === 'only' ? 'only' : 'hide';
                savePlanningFilters();
                renderPlanningFilters();
                renderWeek();
                return;
            }
            if (event.target.closest('#planning-individual-reset')) {
                resetIndividualCourseFilters();
                return;
            }
            if (event.target.closest('#planning-filter-reset')) resetPlanningFilters();
        });

        let resizeTimer = null;
        window.addEventListener('resize', () => {
            window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => {
                if (state.user && isPlanningActive()) renderWeek();
            }, 140);
        });

        document.querySelectorAll('[data-copy-extension-url]').forEach(button => {
            button.addEventListener('click', async () => {
                const value = button.dataset.copyExtensionUrl || '';
                if (!value) return;
                const original = button.innerHTML;
                try {
                    await navigator.clipboard.writeText(value);
                    button.innerHTML = '<i class="fa-solid fa-check"></i> Copié';
                } catch {
                    window.prompt('Copiez cette adresse :', value);
                }
                window.setTimeout(() => { button.innerHTML = original; }, 1600);
            });
        });

        const refreshFromFocus = () => {
            if (!state.user) return;
            if (document.visibilityState === 'hidden') return;
            if (!isPlanningActive() && !state.waitingForInstall) return;
            requestStatusAndPayload({ persistIfCloudEmpty: true }).catch(() => {});
        };

        window.addEventListener('focus', refreshFromFocus);
        window.addEventListener('pageshow', refreshFromFocus);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refreshFromFocus();
        });
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
            if (!state.user || !isPlanningActive() || document.visibilityState === 'hidden') return;
            renderWeek();
        }, 60000);

        window.setInterval(() => {
            if (!state.user || !isPlanningActive() || state.busy || document.visibilityState === 'hidden') return;
            requestStatusAndPayload({ persistIfCloudEmpty: true }).catch(() => {});
        }, STATUS_POLL_MS);
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
        onAccountChanged,
        openTutorial
    };
})();
