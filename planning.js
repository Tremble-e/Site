(() => {
    'use strict';

    const SITE_SOURCE = 'planilim-site';
    const EXT_SOURCE = 'planilim-extension';
    const LEGACY_CACHE_KEY = 'planilim-ade-annual-payload-v1';
    const CACHE_KEY_PREFIX = 'planilim-ade-annual-payload-v2:';
    const SUPABASE_TABLE = 'user_planning_cache';
    const SHARED_RESOURCES_TABLE = 'planning_resources';
    const PREFERENCES_TABLE = 'user_planning_preferences';
    const SYNC_FAILURES_TABLE = 'planning_sync_failures';
    const EXTENSION_STORE_URL = '';
    const EXTENSION_PACKAGE_URL = './downloads/planilim-collector-v4.3.0.zip';
    const BRIDGE_TIMEOUT = 2500;
    const SYNC_TIMEOUT = 180000;
    const COLLECTOR_SYNC_TIMEOUT = 600000;
    const SLOT_MINUTES = 15;
    const DEFAULT_DAY_START = 8 * 60;
    const DEFAULT_DAY_END = 19 * 60;
    const STATUS_POLL_MS = 12000;
    const INSTALL_PROBE_MS = 1500;
    const INSTALL_PROBE_DURATION_MS = 120000;
    const FILTER_KEY_PREFIX = 'planilim-planning-filters-v1:';
    const COLLECTOR_SCOPE_PATH = 'Groupes Etudiants > Faculté des Sciences et Techniques';

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
        isAdmin: false,
        adeVerified: false,
        adeVerificationLoading: false,
        sharedResources: [],
        selectedResourceId: null,
        collectorRows: [],
        collectorFailures: [],
        collectorRunning: false,
        lastCollectorPublishSignature: '',
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

    function pathIsInCollectorScope(path) {
        const value = String(path || '').trim();
        return value === COLLECTOR_SCOPE_PATH || value.startsWith(`${COLLECTOR_SCOPE_PATH} > `);
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
        link.download = 'planilim-collector-v4.3.0.zip';
        link.rel = 'noopener';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    function requestExtension(type, { timeout = BRIDGE_TIMEOUT, payload = {} } = {}) {
        return new Promise((resolve, reject) => {
            const requestId = randomId();
            const timer = window.setTimeout(() => {
                state.pending.delete(requestId);
                reject(new Error('EXTENSION_TIMEOUT'));
            }, timeout);

            state.pending.set(requestId, { resolve, reject, timer });
            window.postMessage({ source: SITE_SOURCE, type, requestId, ...payload }, window.location.origin);
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

    function resourceDisplayLabel(resource) {
        const path = String(resource?.path || '')
            .split(' > ')
            .filter(part => part && part !== 'Groupes Etudiants')
            .join(' › ');
        return path || resource?.label || `Formation ${resource?.resource_id || ''}`;
    }

    function resourceHierarchy(resource) {
        const parts = String(resource?.path || '')
            .split('>')
            .map(part => part.trim())
            .filter(Boolean);
        const semesterIndex = parts.findLastIndex
            ? parts.findLastIndex(part => /^(?:AN|Semestre\s+\d+|S\d+)$/i.test(part))
            : (() => {
                for (let i = parts.length - 1; i >= 0; i -= 1) {
                    if (/^(?:AN|Semestre\s+\d+|S\d+)$/i.test(parts[i])) return i;
                }
                return -1;
            })();

        let formationIndex = -1;
        let year = '';
        let speciality = '';
        for (let i = semesterIndex >= 0 ? semesterIndex - 1 : parts.length - 1; i >= 0; i -= 1) {
            const match = parts[i].match(/^(L[123]|M[12]|BUT\s*[123])\b\s*[-–—:]?\s*(.*)$/i);
            if (!match) continue;
            formationIndex = i;
            year = match[1].toUpperCase().replace(/\s+/g, ' ');
            speciality = String(match[2] || '').trim() || parts[i];
            break;
        }

        if (!year) {
            const fallback = parts.filter(part =>
                !/^Groupes Etudiants$/i.test(part) &&
                !/^Faculté des Sciences et Techniques$/i.test(part) &&
                !/^(?:ANNEE CONSOLIDATION UNIVERSITE|MASTER \(LMD\)|LICENCE.*|FORMATIONS?)$/i.test(part) &&
                !/^(?:AN|Semestre\s+\d+|S\d+)$/i.test(part)
            );
            const candidate = fallback[0] || resource?.label || 'Autre';
            year = candidate;
            speciality = fallback[1] || candidate;
            formationIndex = parts.indexOf(candidate);
        }

        const semester = semesterIndex >= 0 ? parts[semesterIndex] : 'Année complète';
        const afterSemester = semesterIndex >= 0 ? parts.slice(semesterIndex + 1) : [];
        const group = afterSemester.join(' › ');

        return {
            year,
            speciality: speciality || resource?.label || 'Formation',
            semester,
            group,
            formationIndex,
            semesterIndex
        };
    }

    function hierarchySort(values) {
        const order = new Map([['L1', 1], ['L2', 2], ['L3', 3], ['M1', 4], ['M2', 5], ['BUT 1', 6], ['BUT 2', 7], ['BUT 3', 8]]);
        return [...new Set(values.filter(Boolean))].sort((a, b) => {
            const oa = order.get(a) ?? 999;
            const ob = order.get(b) ?? 999;
            return oa - ob || String(a).localeCompare(String(b), 'fr', { numeric: true });
        });
    }

    function setSelectOptions(select, placeholder, values, selectedValue = '') {
        if (!select) return;
        select.innerHTML = [
            `<option value="">${escapePlanning(placeholder)}</option>`,
            ...values.map(value => `<option value="${escapePlanning(value)}">${escapePlanning(value)}</option>`)
        ].join('');
        select.disabled = values.length === 0;
        if (selectedValue && values.includes(selectedValue)) select.value = selectedValue;
    }

    function hierarchyResources() {
        return state.sharedResources.map(resource => ({ resource, hierarchy: resourceHierarchy(resource) }));
    }

    function hierarchyCandidates({ year = '', speciality = '', semester = '' } = {}) {
        return hierarchyResources().filter(item =>
            (!year || item.hierarchy.year === year) &&
            (!speciality || item.hierarchy.speciality === speciality) &&
            (!semester || item.hierarchy.semester === semester)
        );
    }

    function selectedHierarchy() {
        const selected = state.sharedResources.find(resource =>
            String(resource.resource_id) === String(state.selectedResourceId)
        );
        return selected ? resourceHierarchy(selected) : null;
    }

    function renderResourceChooser() {
        const yearSelect = byId('planning-resource-year');
        const specialitySelect = byId('planning-resource-speciality');
        const semesterSelect = byId('planning-resource-semester');
        const groupSelect = byId('planning-resource-group');
        const groupField = byId('planning-resource-group-field');
        const status = byId('planning-resource-status');
        if (!yearSelect || !specialitySelect || !semesterSelect) return;

        const resources = hierarchyResources();
        const selected = selectedHierarchy();
        const requestedYear = yearSelect.dataset.touched === '1' ? yearSelect.value : (selected?.year || yearSelect.value);
        const years = hierarchySort(resources.map(item => item.hierarchy.year));
        const year = years.includes(requestedYear) ? requestedYear : '';
        setSelectOptions(yearSelect, 'Choisissez votre année…', years, year);

        const requestedSpeciality = specialitySelect.dataset.touched === '1' ? specialitySelect.value : (selected?.speciality || specialitySelect.value);
        const specialities = hierarchySort(hierarchyCandidates({ year }).map(item => item.hierarchy.speciality));
        const speciality = specialities.includes(requestedSpeciality) ? requestedSpeciality : '';
        setSelectOptions(specialitySelect, year ? 'Choisissez votre spécialité…' : 'Choisissez d’abord votre année…', specialities, speciality);

        const requestedSemester = semesterSelect.dataset.touched === '1' ? semesterSelect.value : (selected?.semester || semesterSelect.value);
        const semesters = hierarchySort(hierarchyCandidates({ year, speciality }).map(item => item.hierarchy.semester));
        const semester = semesters.includes(requestedSemester) ? requestedSemester : '';
        setSelectOptions(semesterSelect, speciality ? 'Choisissez votre semestre…' : 'Choisissez d’abord votre spécialité…', semesters, semester);

        const candidates = hierarchyCandidates({ year, speciality, semester });
        if (groupField && groupSelect) {
            const needsGroup = Boolean(year && speciality && semester && candidates.length > 1);
            groupField.hidden = !needsGroup;
            if (needsGroup) {
                const groupOptions = candidates.map(item => ({
                    value: String(item.resource.resource_id),
                    label: item.hierarchy.group || item.resource.label || `Groupe ${item.resource.resource_id}`
                }));
                groupSelect.innerHTML = [
                    '<option value="">Choisissez votre groupe…</option>',
                    ...groupOptions.map(item => `<option value="${escapePlanning(item.value)}">${escapePlanning(item.label)}</option>`)
                ].join('');
                groupSelect.disabled = false;
                if (state.selectedResourceId && groupOptions.some(item => item.value === String(state.selectedResourceId))) {
                    groupSelect.value = String(state.selectedResourceId);
                }
            } else {
                groupSelect.innerHTML = '<option value="">Aucun groupe supplémentaire</option>';
                groupSelect.disabled = true;
            }
        }

        if (status) {
            const selectedResource = state.sharedResources.find(resource => String(resource.resource_id) === String(state.selectedResourceId));
            status.textContent = selectedResource
                ? `${selectedResource.event_count || selectedResource.payload?.events?.length || 0} cours · mise à jour ${selectedResource.updated_at ? new Date(selectedResource.updated_at).toLocaleString('fr-FR') : 'inconnue'}`
                : resources.length
                    ? 'Choisissez votre année, votre spécialité puis votre semestre.'
                    : 'Aucune formation n’a encore été publiée par le collecteur.';
        }
    }

    function resetHierarchyAfter(select, ids) {
        for (const id of ids) {
            const el = byId(id);
            if (!el) continue;
            el.dataset.touched = '0';
            el.value = '';
        }
        select.dataset.touched = '1';
    }

    async function chooseHierarchyResource() {
        const year = byId('planning-resource-year')?.value || '';
        const speciality = byId('planning-resource-speciality')?.value || '';
        const semester = byId('planning-resource-semester')?.value || '';
        if (!year || !speciality || !semester) return false;
        const candidates = hierarchyCandidates({ year, speciality, semester });
        if (candidates.length !== 1) return false;
        await savePlanningPreference(candidates[0].resource.resource_id);
        return true;
    }

    function updatePlanningRoleUi() {
        const verification = byId('planning-verification-panel');
        const resourcePanel = byId('planning-resource-panel');
        const accountMeta = byId('planning-account-meta');
        const collector = byId('planning-collector-panel');
        const accessGranted = Boolean(state.user && (state.isAdmin || state.adeVerified));
        if (verification) verification.hidden = !state.user || state.isAdmin || state.adeVerified;
        if (resourcePanel) resourcePanel.hidden = !accessGranted;
        if (accountMeta) accountMeta.hidden = !accessGranted || !state.selectedResourceId;
        if (collector) collector.hidden = !state.isAdmin;
        document.querySelectorAll(
            '#planning > .planning-toolbar, #planning > .planning-filter-panel, #planning > .planning-mobile-panel, #planning > .planning-timetable-shell, #planning > .planning-empty'
        ).forEach(element => { element.hidden = !accessGranted; });
    }

    async function detectAdminRole() {
        const client = getSupabase();
        if (!client || !state.user) return false;
        try {
            const { data, error } = await client.rpc('is_site_admin');
            if (error) throw error;
            return data === true;
        } catch (error) {
            console.warn('Vérification du collecteur administrateur impossible :', error);
            return false;
        }
    }

    async function loadAdeVerification() {
        if (!state.user?.id) {
            state.adeVerified = false;
            updatePlanningRoleUi();
            return false;
        }
        if (state.isAdmin) {
            state.adeVerified = true;
            updatePlanningRoleUi();
            return true;
        }

        const client = getSupabase();
        if (!client) return false;
        try {
            const { data, error } = await client
                .from('ade_verifications')
                .select('verified_at')
                .eq('user_id', state.user.id)
                .maybeSingle();
            if (error) throw error;
            state.adeVerified = Boolean(data?.verified_at);
        } catch (error) {
            state.adeVerified = false;
            console.warn('Vérification ADE indisponible :', error);
        }
        updatePlanningRoleUi();
        return state.adeVerified;
    }

    function consumeAdeVerificationResult() {
        const url = new URL(window.location.href);
        const result = url.searchParams.get('ade');
        if (!result) return;
        const status = byId('planning-verification-status');
        if (status) {
            status.textContent = result === 'verified'
                ? 'Accès universitaire vérifié. Chargement de vos filières…'
                : 'La vérification n’a pas abouti. Vous pouvez réessayer sans modifier votre compte.';
            status.classList.toggle('error', result !== 'verified');
        }
        url.searchParams.delete('ade');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash || '#planning'}`);
    }

    async function beginAdeVerification() {
        if (!state.user || state.adeVerificationLoading) return;
        const button = byId('planning-verify-ade');
        const status = byId('planning-verification-status');
        state.adeVerificationLoading = true;
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Redirection…';
        }
        if (status) {
            status.textContent = 'Ouverture de la connexion sécurisée de l’Université de Limoges…';
            status.classList.remove('error');
        }

        try {
            const client = getSupabase();
            if (!client) throw new Error('SUPABASE_UNAVAILABLE');
            const returnUrl = `${window.location.origin}${window.location.pathname}#planning`;
            const { data, error } = await client.functions.invoke('verify-ade', {
                body: { action: 'start', returnUrl }
            });
            if (error) throw error;
            if (data?.code === 'ALREADY_VERIFIED') {
                state.adeVerified = true;
                updatePlanningRoleUi();
                await loadCloudPayload();
                renderWeek();
                return;
            }
            if (!data?.url) throw new Error(data?.code || 'CAS_REDIRECT_MISSING');
            window.location.assign(data.url);
        } catch (error) {
            console.error('Vérification ADE impossible :', error);
            if (status) {
                status.textContent = 'La vérification universitaire est momentanément indisponible. Réessayez dans quelques instants.';
                status.classList.add('error');
            }
        } finally {
            state.adeVerificationLoading = false;
            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"></i> Vérifier avec l’Université';
            }
        }
    }

    async function loadSharedResources() {
        const client = getSupabase();
        if (!client || !state.user || (!state.isAdmin && !state.adeVerified)) return [];
        try {
            const { data, error } = await client
                .from(SHARED_RESOURCES_TABLE)
                .select('resource_id,label,path,academic_year,event_count,week_count,payload,source_updated_at,updated_at')
                .eq('active', true)
                .order('label', { ascending: true });
            if (error) throw error;
            state.sharedResources = (Array.isArray(data) ? data : [])
                .filter(resource => pathIsInCollectorScope(resource.path));
        } catch (error) {
            state.sharedResources = [];
            console.warn('Catalogue partagé des formations indisponible :', error);
        }
        renderResourceChooser();
        return state.sharedResources;
    }

    async function loadPlanningPreference() {
        const client = getSupabase();
        if (!client || !state.user?.id || (!state.isAdmin && !state.adeVerified)) return null;
        try {
            const { data, error } = await client
                .from(PREFERENCES_TABLE)
                .select('resource_id')
                .eq('user_id', state.user.id)
                .maybeSingle();
            if (error) throw error;
            state.selectedResourceId = data?.resource_id || null;
        } catch (error) {
            console.warn('Préférence de formation indisponible :', error);
        }
        renderResourceChooser();
        return state.selectedResourceId;
    }

    function useSelectedSharedPayload() {
        const selected = state.sharedResources.find(resource =>
            String(resource.resource_id) === String(state.selectedResourceId)
        );
        if (!selected?.payload?.events || !Array.isArray(selected.payload.events)) return null;
        saveLocalPayload(selected.payload);
        state.cloudAvailable = true;
        state.cloudLoaded = true;
        ensureCurrentWeek();
        renderPlanningFilters(true);
        renderWeek();
        renderResourceChooser();
        return selected.payload;
    }

    async function savePlanningPreference(resourceId) {
        if (!state.user?.id || !resourceId || (!state.isAdmin && !state.adeVerified)) return false;
        const client = getSupabase();
        if (!client) return false;
        try {
            const { error } = await client.from(PREFERENCES_TABLE).upsert({
                user_id: state.user.id,
                resource_id: String(resourceId),
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });
            if (error) throw error;
            state.selectedResourceId = String(resourceId);
            useSelectedSharedPayload();
            return true;
        } catch (error) {
            console.warn('Enregistrement de la formation impossible :', error);
            return false;
        }
    }

    async function loadCloudPayload() {
        if (!state.user?.id || (!state.isAdmin && !state.adeVerified)) return null;
        const client = getSupabase();
        if (!client) return null;

        if (!state.sharedResources.length) await loadSharedResources();
        await loadPlanningPreference();
        const sharedPayload = useSelectedSharedPayload();
        if (sharedPayload) return sharedPayload;

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

    function collectorFailuresStorageKey() {
        return state.user?.id ? `planilim-collector-failures-v1:${state.user.id}` : null;
    }

    function collectorFailureKey(item) {
        if (item?.resourceId != null) return `resource:${item.resourceId}`;
        return `path:${item?.path || ''}`;
    }

    function loadCollectorFailuresLocal() {
        const key = collectorFailuresStorageKey();
        if (!key) return [];
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || '[]');
            state.collectorFailures = Array.isArray(parsed) ? parsed : [];
        } catch {
            state.collectorFailures = [];
        }
        updateCollectorActionButtons();
        return state.collectorFailures;
    }

    async function loadCollectorFailures() {
        loadCollectorFailuresLocal();
        if (!state.isAdmin) return state.collectorFailures;
        const client = getSupabase();
        if (!client) return state.collectorFailures;
        try {
            const { data, error } = await client
                .from(SYNC_FAILURES_TABLE)
                .select('resource_id,label,path,error_code,error_message,attempt_count,last_failed_at')
                .order('last_failed_at', { ascending: false });
            if (error) throw error;
            const merged = new Map(state.collectorFailures.map(item => [collectorFailureKey(item), item]));
            for (const row of Array.isArray(data) ? data : []) {
                const item = {
                    resourceId: row.resource_id == null ? null : Number(row.resource_id),
                    label: row.label || null,
                    path: row.path || null,
                    code: row.error_code || 'SYNC_FAILED',
                    message: row.error_message || null,
                    attemptCount: Number(row.attempt_count || 1),
                    lastFailedAt: row.last_failed_at || null
                };
                merged.set(collectorFailureKey(item), item);
            }
            state.collectorFailures = [...merged.values()];
            saveCollectorFailures(state.collectorFailures);
        } catch (error) {
            console.warn('Erreurs de synchronisation distantes indisponibles :', error);
        }
        updateCollectorActionButtons();
        return state.collectorFailures;
    }

    function saveCollectorFailures(failures = []) {
        state.collectorFailures = Array.isArray(failures) ? failures : [];
        const key = collectorFailuresStorageKey();
        if (key) {
            try { localStorage.setItem(key, JSON.stringify(state.collectorFailures)); } catch {}
        }
        updateCollectorActionButtons();
    }

    async function persistCollectorFailureRows(failures = [], successfulResourceIds = []) {
        if (!state.isAdmin) return;
        const client = getSupabase();
        if (!client) return;
        const now = new Date().toISOString();
        try {
            for (const resourceId of successfulResourceIds) {
                if (resourceId == null) continue;
                const { error } = await client.from(SYNC_FAILURES_TABLE)
                    .delete()
                    .eq('resource_id', String(resourceId));
                if (error) throw error;
            }
            if (failures.length) {
                const rows = failures
                    .filter(item => item.resourceId != null)
                    .map(item => ({
                        resource_id: String(item.resourceId),
                        label: item.label || null,
                        path: item.path || null,
                        error_code: item.code || 'SYNC_FAILED',
                        error_message: item.message || null,
                        last_failed_at: now,
                        updated_at: now
                    }));
                if (rows.length) {
                    const { error } = await client.from(SYNC_FAILURES_TABLE).upsert(rows, { onConflict: 'resource_id' });
                    if (error) throw error;
                }
            }
        } catch (error) {
            console.warn('Enregistrement des erreurs de synchronisation impossible :', error);
        }
    }

    function updateCollectorActionButtons() {
        const run = byId('planning-collector-run');
        const retry = byId('planning-collector-retry');
        if (run) {
            run.disabled = Boolean(state.busy || state.collectorRunning);
            run.innerHTML = state.collectorRunning
                ? '<i class="fa-solid fa-spinner fa-spin"></i> Synchronisation en cours…'
                : '<i class="fa-solid fa-cloud-arrow-up"></i> Récupérer et synchroniser les EDT';
        }
        if (retry) {
            const count = state.collectorFailures.length;
            retry.hidden = count === 0;
            retry.disabled = Boolean(state.busy || state.collectorRunning || count === 0);
            retry.innerHTML = `<i class="fa-solid fa-rotate-right"></i> Relancer les échecs${count ? ` (${count})` : ''}`;
        }
    }

    function collectorRowKey(row) {
        if (row?.resourceId != null) return `resource:${Number(row.resourceId)}`;
        if (row?.nodeId) return `node:${row.nodeId}`;
        if (row?.path) return `path:${row.path}`;
        return `label:${row?.label || ''}:${row?.level || ''}`;
    }

    function mergeCollectorRows(incomingRows) {
        const merged = new Map();
        for (const row of state.collectorRows || []) {
            merged.set(collectorRowKey(row), row);
        }
        for (const row of incomingRows || []) {
            const key = collectorRowKey(row);
            const previous = merged.get(key) || {};
            merged.set(key, {
                ...previous,
                ...row,
                // Conserver les informations de chemin/nom déjà découvertes
                // quand ExtJS virtualise momentanément une partie de l'arbre.
                label: row?.label || previous?.label || null,
                path: row?.path || previous?.path || null,
                pathParts: Array.isArray(row?.pathParts) && row.pathParts.length
                    ? row.pathParts
                    : (previous?.pathParts || [])
            });
        }
        state.collectorRows = [...merged.values()];
    }

    function renderCollectorRows() {
        const container = byId('planning-collector-resources');
        if (!container) return;

        const rows = state.collectorRows.filter(isCollectorTarget);
        container.innerHTML = rows.length ? rows.map(row => `
            <article class="planning-collector-resource">
                <i class="fa-solid fa-check" aria-hidden="true"></i>
                <span>
                    <strong>${escapePlanning(row.label || `Planning ${row.resourceId}`)}</strong>
                    <small>${escapePlanning(row.path || '')}</small>
                </span>
            </article>
        `).join('') : '';
    }

    function isCollectorTarget(row) {
        return row?.resourceId != null &&
            row.level >= 3 &&
            row.branchToggle !== true &&
            row.expanded !== true &&
            pathIsInCollectorScope(row.path);
    }

    async function refreshCollectorTree() {
        if (!state.isAdmin || state.busy) return { ok: false, code: 'BUSY' };
        const status = byId('planning-collector-status');
        let expanded = 0;
        let batch = 0;
        let complete = false;
        let stablePasses = 0;
        let previousCount = state.collectorRows.filter(isCollectorTarget).length;
        setLoading(true, 'Lecture du catalogue ADE…', 'Les filières sont ouvertes par petits lots pour rester fiables même lorsque ADE ralentit.');
        try {
            while (batch < 180) {
                batch += 1;
                if (status) status.textContent = `Lecture ADE : ${expanded} branches ouvertes · ${state.collectorRows.filter(isCollectorTarget).length} EDT trouvés…`;
                const result = await requestExtension('PLANILIM_COLLECTOR_EXPAND_AND_SCAN', {
                    timeout: 180000,
                    payload: {
                        maxBranches: 6,
                        maxDurationMs: 45000,
                        maxDepth: 16,
                        scopeRoot: 'Groupes Etudiants',
                        scopePath: COLLECTOR_SCOPE_PATH
                    }
                });
                if (!result?.ok) {
                    const failure = new Error(result?.message || result?.code || 'ADE indisponible');
                    failure.code = result?.code || 'ADE_UNAVAILABLE';
                    throw failure;
                }
                state.extensionDetected = true;
                expanded += Number(result.expandedCount || 0);
                const scannedRows = (Array.isArray(result.rows) ? result.rows : []).map(row =>
                    isCollectorTarget(row) ? { ...row, selected: true } : row
                );
                // Une lecture ExtJS est un instantané virtualisé : les lignes déjà
                // découvertes ne doivent jamais disparaître parce qu'un lot suivant
                // n'en rend plus qu'une partie. On fait donc l'union des découvertes.
                mergeCollectorRows(scannedRows);
                renderCollectorRows();

                const currentCount = state.collectorRows.filter(isCollectorTarget).length;
                if (!result.truncated) {
                    stablePasses = currentCount === previousCount ? stablePasses + 1 : 0;
                    previousCount = currentCount;
                    if (stablePasses >= 2) {
                        complete = true;
                        break;
                    }
                    await new Promise(resolve => window.setTimeout(resolve, 500));
                } else {
                    stablePasses = 0;
                    previousCount = currentCount;
                    await new Promise(resolve => window.setTimeout(resolve, 140));
                }
            }

            const count = state.collectorRows.filter(isCollectorTarget).length;
            if (status) {
                status.textContent = complete
                    ? count > 0
                        ? `${count} filière${count > 1 ? 's' : ''} détectée${count > 1 ? 's' : ''}. La récupération des cours va commencer.`
                        : 'Aucune filière trouvée dans la Faculté des Sciences et Techniques. ADE va être relu au prochain essai.'
                    : `${count} filière${count > 1 ? 's' : ''} détectée${count > 1 ? 's' : ''}. La lecture reprendra automatiquement.`;
            }
            return { ok: count > 0, complete, count };
        } catch (error) {
            renderCollectorRows();
            const authRequired = ['AUTH_REQUIRED', 'ADE_NOT_OPEN'].includes(error?.code);
            if (authRequired) {
                sessionStorage.setItem('planilim-admin-collector-resume', '1');
                if (status) status.textContent = 'Connecte-toi dans ADE. Reviens ensuite sur Planilim : la synchronisation reprendra automatiquement.';
                try { await requestExtension('PLANILIM_ADE_CONNECT', { timeout: 20000 }); } catch {}
            } else if (status) {
                status.textContent = state.collectorRows.length
                    ? 'La lecture a été interrompue. Les filières déjà trouvées sont conservées ; relance pour reprendre.'
                    : 'Le collecteur n’a pas pu lire ADE. Réessaie dans quelques instants.';
            }
            return { ok: false, code: error?.code || 'CATALOG_FAILED', authRequired };
        } finally {
            setLoading(false);
            renderCollectorRows();
        }
    }

    async function publishCollectorPayloads(onlyResourceId = null) {
        if (!state.isAdmin) return { ok: false, code: 'ADMIN_REQUIRED' };
        const client = getSupabase();
        if (!client) return { ok: false, code: 'SUPABASE_UNAVAILABLE' };

        const result = await requestExtension('PLANILIM_COLLECTOR_PAYLOADS', { timeout: 20000 });
        const resources = (Array.isArray(result?.resources) ? result.resources : [])
            .filter(item => onlyResourceId == null || Number(item.resourceId) === Number(onlyResourceId));
        if (!resources.length) return { ok: false, code: 'NO_COLLECTOR_PAYLOADS' };

        const rows = resources.map(item => ({
            resource_id: String(item.resourceId),
            label: item.label || `Planning ${item.resourceId}`,
            path: item.path || null,
            academic_year: item.academicYear || item.payload?.academicYear || null,
            event_count: item.eventCount ?? item.payload?.events?.length ?? 0,
            week_count: item.weekCount ?? item.payload?.weekCount ?? 0,
            payload: item.payload,
            active: true,
            source_updated_at: item.payload?.generatedAt || item.updatedAt || new Date().toISOString(),
            updated_at: new Date().toISOString()
        })).filter(item => item.payload?.events && Array.isArray(item.payload.events));

        const { error } = await client.from(SHARED_RESOURCES_TABLE).upsert(rows, {
            onConflict: 'resource_id'
        });
        if (error) throw error;
        return { ok: true, code: 'COLLECTOR_PUBLISHED', count: rows.length };
    }

    async function syncCollectorResources(targetOverride = null) {
        if (!state.isAdmin || state.busy) return;
        const targets = Array.isArray(targetOverride) && targetOverride.length
            ? targetOverride
            : state.collectorRows.filter(isCollectorTarget);
        if (!targets.length) return;

        const status = byId('planning-collector-status');
        setLoading(true, 'Collecte ADE en cours…', `${targets.length} emploi${targets.length > 1 ? 's' : ''} du temps en cours de synchronisation.`);
        if (status) status.textContent = 'Garde ADE ouvert. Chaque filière terminée est publiée immédiatement.';

        let successCount = 0;
        const successfulResourceIds = [];
        const failures = [];
        let authRequired = false;

        try {
            for (let index = 0; index < targets.length; index += 1) {
                const target = targets[index];
                if (status) {
                    status.textContent = `Synchronisation ${index + 1}/${targets.length} : ${target.label || 'emploi du temps'}…`;
                }

                try {
                    const sync = await requestExtension('PLANILIM_COLLECTOR_SYNC_RESOURCE', {
                        timeout: COLLECTOR_SYNC_TIMEOUT,
                        payload: { target }
                    });

                    if (sync?.code === 'AUTH_REQUIRED') {
                        authRequired = true;
                        failures.push({ target, code: 'AUTH_REQUIRED' });
                        break;
                    }

                    if (!sync?.ok) {
                        failures.push({ target, code: sync?.code || 'SYNC_FAILED' });
                        continue;
                    }

                    try {
                        const published = await publishCollectorPayloads(target.resourceId);
                        if (published?.ok) {
                            successCount += 1;
                            successfulResourceIds.push(target.resourceId);
                        } else failures.push({ target, code: published?.code || 'PUBLISH_FAILED' });
                    } catch (publishError) {
                        console.warn('Publication différée pour', target?.label, publishError);
                        failures.push({ target, code: 'PUBLISH_FAILED' });
                    }
                } catch (resourceError) {
                    // Une formation en erreur ne doit plus interrompre les 200+ suivantes.
                    console.warn('Synchronisation impossible pour', target?.label, resourceError);
                    failures.push({
                        target,
                        code: resourceError?.code || resourceError?.message || 'SYNC_EXCEPTION'
                    });
                }
            }

            // Deuxième passe de publication : récupère également les payloads qui
            // auraient fini côté extension juste après un timeout réseau du site.
            try { await publishCollectorPayloads(); } catch (error) {
                console.warn('Publication globale de rattrapage impossible :', error);
            }

            await loadSharedResources();
            if (status) {
                if (authRequired) {
                    status.textContent = `${successCount} emploi${successCount > 1 ? 's' : ''} du temps publié${successCount > 1 ? 's' : ''}. Reconnecte-toi à ADE puis relance pour continuer.`;
                } else if (!failures.length) {
                    status.textContent = `${successCount} emploi${successCount > 1 ? 's' : ''} du temps publié${successCount > 1 ? 's' : ''}. Tu peux fermer ADE.`;
                } else {
                    status.textContent = `${successCount} sur ${targets.length} emplois du temps publiés. ${failures.length} ont échoué mais la file a continué jusqu'au bout.`;
                }
            }

            const failureRows = failures.map(item => ({
                resourceId: item.target?.resourceId ?? null,
                label: item.target?.label || null,
                path: item.target?.path || null,
                level: item.target?.level ?? null,
                branchToggle: item.target?.branchToggle ?? false,
                expanded: item.target?.expanded ?? null,
                code: item.code,
                message: item.message || null
            }));
            saveCollectorFailures(failureRows);
            await persistCollectorFailureRows(failureRows, successfulResourceIds);

            return {
                ok: !authRequired && failures.length === 0,
                successCount,
                total: targets.length,
                failures: failureRows
            };
        } finally {
            setLoading(false);
            renderCollectorRows();
        }
    }

    function isMobileDevice() {
        return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    }

    async function runAdminCollector() {
        if (!state.isAdmin || state.busy || state.collectorRunning) return;
        const status = byId('planning-collector-status');
        state.collectorRunning = true;
        updateCollectorActionButtons();

        try {
            if (!state.extensionDetected) {
                await requestStatusAndPayload({ persistIfCloudEmpty: true });
            }
            if (!state.extensionDetected) {
                if (isMobileDevice()) {
                    if (status) status.textContent = 'Ouverture du collecteur sur ce téléphone…';
                    window.location.href = 'planilim-collector://sync';
                } else {
                    if (status) status.textContent = 'Le collecteur PC n’est pas détecté. Installe-le puis relance ce bouton.';
                    launchExtensionInstall();
                }
                return;
            }

            sessionStorage.removeItem('planilim-admin-collector-resume');
            saveCollectorFailures([]);
            const catalog = await refreshCollectorTree();
            if (catalog?.ok && catalog?.complete) {
                await syncCollectorResources();
            } else if (catalog?.ok && status) {
                status.textContent = `${catalog.count || 0} EDT trouvés, mais l’analyse n’est pas encore complète. Relance pour reprendre sans perdre ceux déjà détectés.`;
            }
        } finally {
            state.collectorRunning = false;
            updateCollectorActionButtons();
        }
    }

    async function retryFailedCollectorResources() {
        if (!state.isAdmin || state.busy || state.collectorRunning) return;
        const status = byId('planning-collector-status');
        const failures = [...state.collectorFailures];
        if (!failures.length) return;

        state.collectorRunning = true;
        updateCollectorActionButtons();
        if (status) status.textContent = `Nouvelle tentative sur ${failures.length} emploi${failures.length > 1 ? 's' : ''} du temps en échec…`;
        try {
            await syncCollectorResources(failures);
        } finally {
            state.collectorRunning = false;
            updateCollectorActionButtons();
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
        const cloud = byId('planning-cloud-status');
        const lastSync = byId('planning-last-sync');
        const count = byId('planning-course-count');
        const selected = state.sharedResources.find(resource =>
            String(resource.resource_id) === String(state.selectedResourceId)
        );
        if (count) count.textContent = `${state.payload?.eventCount ?? state.payload?.events?.length ?? 0} cours`;
        if (lastSync) {
            const value = selected?.updated_at || selected?.source_updated_at || state.payload?.generatedAt || null;
            lastSync.textContent = value
                ? `Mis à jour ${new Date(value).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                : 'Aucune mise à jour';
        }
        if (cloud) {
            cloud.hidden = true;
            cloud.textContent = '';
        }
        updateCollectorActionButtons();
        updatePlanningRoleUi();
    }

    function setLoading(active, title = 'Chargement en cours…', detail = 'Veuillez patienter quelques instants.') {
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
        if (!state.isAdmin) {
            updatePlanningRoleUi();
            renderResourceChooser();
            return null;
        }
        if (state.bridgeProbePromise) return state.bridgeProbePromise;

        state.bridgeProbePromise = (async () => {
            try {
                state.status = await requestExtension('PLANILIM_ADE_STATUS');
                state.extensionDetected = true;
                state.extensionVersion = state.status?.extensionVersion || state.extensionVersion;

                const collectorResources = state.status?.collector?.resources || [];
                const publishSignature = collectorResources
                    .map(item => `${item.resourceId}:${item.updatedAt || ''}:${item.eventCount || 0}`)
                    .sort()
                    .join('|');
                if (state.isAdmin && publishSignature && publishSignature !== state.lastCollectorPublishSignature) {
                    const published = await publishCollectorPayloads();
                    if (published?.ok) {
                        state.lastCollectorPublishSignature = publishSignature;
                        await loadSharedResources();
                    }
                }
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

    function setPlanningAccess(user) {
        state.user = user || null;
        const navButton = document.querySelector('.nav-btn[data-target="planning"]');
        const navItem = navButton?.closest('li');
        if (navItem) navItem.hidden = !state.user;

        if (!state.user) {
            state.isAdmin = false;
            state.adeVerified = false;
            state.sharedResources = [];
            state.selectedResourceId = null;
            state.collectorRows = [];
            state.collectorFailures = [];
            state.payload = null;
            state.cloudLoaded = false;
            state.currentWeekStart = null;
            state.mobileSelectedDate = null;
            state.filters = { kinds: { cm: true, td: true, tp: true, exam: true, other: true }, selectedCourses: new Set(), courseMode: 'hide', excludedEvents: new Set(), showExcludedEvents: false };
            state.filterCatalogSignature = '';
            stopInstallProbe();
            updatePlanningRoleUi();
            renderResourceChooser();
            if (byId('planning')?.classList.contains('active')) {
                document.querySelector('.nav-btn[data-target="about"]')?.click();
            }
            return;
        }

        loadCollectorFailuresLocal();

        // Aucun cache de planning n'est chargé avant la validation universitaire.
        // Cela empêche un ancien cache local de contourner la première vérification ADE.
        state.payload = null;
        consumeAdeVerificationResult();
        loadPlanningFilters();
        renderPlanningFilters(true);
        if (window.location.hash === '#planning' && !byId('planning')?.classList.contains('active')) {
            navButton?.click();
        }
    }

    async function onAccountChanged(user) {
        setPlanningAccess(user);
        if (!state.user) return;
        state.isAdmin = await detectAdminRole();
        if (state.isAdmin) await loadCollectorFailures();
        await loadAdeVerification();
        updatePlanningRoleUi();
        if (state.isAdmin || state.adeVerified) {
            state.payload = loadLocalPayload(state.user.id);
            await loadCloudPayload();
        }
        ensureCurrentWeek();
        renderWeek();
        updateConnectionUi();
        if (state.isAdmin) await requestStatusAndPayload({ persistIfCloudEmpty: true });
    }

    function bindControls() {
        byId('planning-verify-ade')?.addEventListener('click', beginAdeVerification);
        byId('planning-resource-year')?.addEventListener('change', event => {
            resetHierarchyAfter(event.target, ['planning-resource-speciality', 'planning-resource-semester', 'planning-resource-group']);
            renderResourceChooser();
        });
        byId('planning-resource-speciality')?.addEventListener('change', event => {
            resetHierarchyAfter(event.target, ['planning-resource-semester', 'planning-resource-group']);
            renderResourceChooser();
        });
        byId('planning-resource-semester')?.addEventListener('change', async event => {
            resetHierarchyAfter(event.target, ['planning-resource-group']);
            renderResourceChooser();
            if (await chooseHierarchyResource()) {
                ensureCurrentWeek();
                renderWeek();
                updateConnectionUi();
            }
        });
        byId('planning-resource-group')?.addEventListener('change', async event => {
            const resourceId = event.target.value || '';
            if (!resourceId) return;
            event.target.disabled = true;
            await savePlanningPreference(resourceId);
            event.target.disabled = false;
            ensureCurrentWeek();
            renderWeek();
            updateConnectionUi();
        });
        byId('planning-collector-run')?.addEventListener('click', runAdminCollector);
        byId('planning-collector-retry')?.addEventListener('click', retryFailedCollectorResources);
        byId('planning-prev-week')?.addEventListener('click', () => moveWeek(-1));
        byId('planning-next-week')?.addEventListener('click', () => moveWeek(1));
        byId('planning-today')?.addEventListener('click', () => {
            state.currentWeekStart = mondayOf(new Date());
            state.mobileSelectedDate = toIsoDate(new Date());
            renderWeek();
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

        const refreshFromFocus = async () => {
            if (!state.user) return;
            if (document.visibilityState === 'hidden') return;
            if (!isPlanningActive() && !state.waitingForInstall) return;
            await requestStatusAndPayload({ persistIfCloudEmpty: true }).catch(() => {});
            if (state.isAdmin && sessionStorage.getItem('planilim-admin-collector-resume') === '1' && !state.busy) {
                await runAdminCollector();
            }
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
            state.isAdmin = await detectAdminRole();
            await loadAdeVerification();
            updatePlanningRoleUi();
            if (state.isAdmin || state.adeVerified) {
                state.payload = loadLocalPayload(state.user.id);
                await loadCloudPayload();
            }
            ensureCurrentWeek();
            renderWeek();
            updateConnectionUi();
            if (state.isAdmin) await requestStatusAndPayload({ persistIfCloudEmpty: true });
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
        onAccountChanged
    };
})();
