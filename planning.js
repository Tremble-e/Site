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
    const EXTENSION_PACKAGE_URL = './downloads/planilim-collector-v4.16.1.zip';
    const BRIDGE_TIMEOUT = 2500;
    const SYNC_TIMEOUT = 180000;
    const COLLECTOR_SYNC_TIMEOUT = 600000;
    const COLLECTOR_DEFAULT_WORKERS = 4;
    const COLLECTOR_ADAPTIVE_MAX_WORKERS = 4;
    const COLLECTOR_PROGRESS_POLL_MS = 1000;
    const ANDROID_APP_DEEP_LINK = 'ade-collector://open';
    const SLOT_MINUTES = 15;
    const DEFAULT_DAY_START = 8 * 60;
    const DEFAULT_DAY_END = 19 * 60;
    const STATUS_POLL_MS = 12000;
    const INSTALL_PROBE_MS = 1500;
    const INSTALL_PROBE_DURATION_MS = 120000;
    const FILTER_KEY_PREFIX = 'planilim-planning-filters-v1:';
    const COLLECTOR_PROGRAM_SCOPE_PATH = 'Groupes Etudiants > Faculté des Sciences et Techniques';
    const COLLECTOR_ROOM_SCOPE_PATH = 'Salles > LIMOGES > LIMOGES La Borie FST';
    const COLLECTOR_PROFILES = Object.freeze({
        program: Object.freeze({
            key: 'program',
            label: 'Filières',
            singular: 'filière',
            plural: 'filières',
            scopePath: COLLECTOR_PROGRAM_SCOPE_PATH,
            targetKind: 'program',
            maxDepth: 4
        }),
        room: Object.freeze({
            key: 'room',
            label: 'Salles',
            singular: 'salle',
            plural: 'salles',
            scopePath: COLLECTOR_ROOM_SCOPE_PATH,
            targetKind: 'room',
            maxDepth: 4
        })
    });

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
        selectedProgramResourceId: null,
        selectedRoomResourceId: null,
        resourceMode: 'program',
        resourceModeTouched: false,
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

    const universityEmailVerification = {
        returnHash: '#planning',
        email: '',
        expiresAt: 0,
        resendAt: 0,
        timer: null
    };

    const byId = id => document.getElementById(id);

    function randomId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        return `planilim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function getSupabase() {
        return window.getSiteSupabase?.() || null;
    }

    function publishUniversityAccessState() {
        window.updateSiteUniversityAccess?.({
            user: state.user,
            verified: state.adeVerified,
            admin: state.isAdmin
        });
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


    function useTransientPayload(payload) {
        if (!payload?.events || !Array.isArray(payload.events)) return false;
        state.payload = payload;
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

    function pathIsInProgramScope(path) {
        const value = String(path || '').trim();
        return value === COLLECTOR_PROGRAM_SCOPE_PATH || value.startsWith(`${COLLECTOR_PROGRAM_SCOPE_PATH} > `);
    }

    function pathIsInRoomScope(path) {
        const value = String(path || '').trim();
        return value === COLLECTOR_ROOM_SCOPE_PATH || value.startsWith(`${COLLECTOR_ROOM_SCOPE_PATH} > `);
    }

    function pathIsInCollectorScope(path) {
        return pathIsInProgramScope(path) || pathIsInRoomScope(path);
    }

    function collectorKindFromPath(path) {
        return pathIsInRoomScope(path) ? 'room' : 'program';
    }

    function resourceKind(resource) {
        return collectorKindFromPath(resource?.path || '');
    }

    function collectorProfile(kind) {
        return kind === 'room' ? COLLECTOR_PROFILES.room : COLLECTOR_PROFILES.program;
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
        link.download = 'planilim-collector-v4.16.1.zip';
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
        const parts = String(resource?.path || '')
            .split('>')
            .map(part => part.trim())
            .filter(Boolean);
        if (resourceKind(resource) === 'room') {
            const useful = parts.filter(part =>
                !/^Salles$/i.test(part) &&
                !/^LIMOGES$/i.test(part) &&
                !/^LIMOGES La Borie FST$/i.test(part)
            );
            return useful.join(' › ') || resource?.label || `Salle ${resource?.resource_id || ''}`;
        }
        const useful = parts.filter(part => part && part !== 'Groupes Etudiants');
        return useful.join(' › ') || resource?.label || `Formation ${resource?.resource_id || ''}`;
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

    function roomHierarchy(resource) {
        const parts = String(resource?.path || '')
            .split('>')
            .map(part => part.trim())
            .filter(Boolean);
        const room = String(resource?.label || parts.at(-1) || '').trim();
        let building = '';
        for (let index = parts.length - 2; index >= 0; index -= 1) {
            if (/^B(?:A|Â)TIMENT\b/i.test(parts[index])) {
                building = parts[index];
                break;
            }
        }
        if (!building) {
            const siteIndex = parts.findIndex(part => /^LIMOGES La Borie FST$/i.test(part));
            if (siteIndex >= 0 && parts[siteIndex + 1] && parts[siteIndex + 1] !== room) {
                building = parts[siteIndex + 1];
            }
        }
        return {
            building: building || 'Autres salles',
            room: room || `Salle ${resource?.resource_id || ''}`
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
        return state.sharedResources
            .filter(resource => resourceKind(resource) === 'program')
            .map(resource => ({ resource, hierarchy: resourceHierarchy(resource) }));
    }

    function hierarchyCandidates({ year = '', speciality = '', semester = '' } = {}) {
        return hierarchyResources().filter(item =>
            (!year || item.hierarchy.year === year) &&
            (!speciality || item.hierarchy.speciality === speciality) &&
            (!semester || item.hierarchy.semester === semester)
        );
    }

    function roomResources() {
        return state.sharedResources
            .filter(resource => resourceKind(resource) === 'room')
            .map(resource => ({ resource, hierarchy: roomHierarchy(resource) }));
    }

    function selectedSharedResource() {
        return state.sharedResources.find(resource =>
            String(resource.resource_id) === String(state.selectedResourceId)
        ) || null;
    }

    function selectedHierarchy() {
        const selected = selectedSharedResource();
        return selected && resourceKind(selected) === 'program' ? resourceHierarchy(selected) : null;
    }

    function renderResourceModeToggle() {
        document.querySelectorAll('[data-planning-resource-mode]').forEach(button => {
            const active = button.dataset.planningResourceMode === state.resourceMode;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    function renderResourceModeCopy() {
        const title = byId('planning-resource-mode-title');
        const description = byId('planning-resource-mode-description');
        if (state.resourceMode === 'room') {
            if (title) title.textContent = 'Consulter une salle';
            if (description) description.textContent = 'Choisissez un bâtiment et une salle pour afficher son emploi du temps.';
        } else {
            if (title) title.textContent = 'Votre filière';
            if (description) description.textContent = 'Choisissez votre filière pour afficher vos cours.';
        }
    }

    function renderResourceChooser() {
        const yearSelect = byId('planning-resource-year');
        const specialitySelect = byId('planning-resource-speciality');
        const semesterSelect = byId('planning-resource-semester');
        const groupSelect = byId('planning-resource-group');
        const groupField = byId('planning-resource-group-field');
        const buildingSelect = byId('planning-resource-building');
        const roomSelect = byId('planning-resource-room');
        const programSelectors = byId('planning-resource-program-selectors');
        const roomSelectors = byId('planning-resource-room-selectors');
        const status = byId('planning-resource-status');
        if (!yearSelect || !specialitySelect || !semesterSelect) return;

        const selectedResource = selectedSharedResource();
        if (!state.resourceModeTouched && selectedResource) {
            state.resourceMode = resourceKind(selectedResource);
        }
        renderResourceModeToggle();
        renderResourceModeCopy();
        if (programSelectors) programSelectors.hidden = state.resourceMode !== 'program';
        if (roomSelectors) roomSelectors.hidden = state.resourceMode !== 'room';

        if (state.resourceMode === 'room') {
            const resources = roomResources();
            const selected = selectedResource && resourceKind(selectedResource) === 'room'
                ? roomHierarchy(selectedResource)
                : null;
            const requestedBuilding = buildingSelect?.dataset.touched === '1'
                ? buildingSelect.value
                : (selected?.building || buildingSelect?.value || '');
            const buildings = [...new Set(resources.map(item => item.hierarchy.building).filter(Boolean))]
                .sort((a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true }));
            const building = buildings.includes(requestedBuilding) ? requestedBuilding : '';
            setSelectOptions(buildingSelect, 'Choisissez un bâtiment…', buildings, building);

            const candidates = resources.filter(item => !building || item.hierarchy.building === building);
            if (roomSelect) {
                const options = candidates
                    .slice()
                    .sort((a, b) => String(a.hierarchy.room).localeCompare(String(b.hierarchy.room), 'fr', { numeric: true }))
                    .map(item => ({ value: String(item.resource.resource_id), label: item.hierarchy.room }));
                roomSelect.innerHTML = [
                    `<option value="">${building ? 'Choisissez une salle…' : 'Choisissez d’abord un bâtiment…'}</option>`,
                    ...options.map(item => `<option value="${escapePlanning(item.value)}">${escapePlanning(item.label)}</option>`)
                ].join('');
                roomSelect.disabled = !building || options.length === 0;
                if (selectedResource && resourceKind(selectedResource) === 'room' && options.some(item => item.value === String(state.selectedResourceId))) {
                    roomSelect.value = String(state.selectedResourceId);
                }
            }

            if (status) {
                status.textContent = selectedResource && resourceKind(selectedResource) === 'room'
                    ? `Salle : ${resourceDisplayLabel(selectedResource)} · ${selectedResource.event_count || selectedResource.payload?.events?.length || 0} cours · mise à jour ${selectedResource.updated_at ? new Date(selectedResource.updated_at).toLocaleString('fr-FR') : 'inconnue'}`
                    : resources.length
                        ? 'Choisissez un bâtiment puis une salle.'
                        : 'Aucune salle n’a encore été publiée par le collecteur.';
            }
            return;
        }

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
            status.textContent = selectedResource && resourceKind(selectedResource) === 'program'
                ? `Filière : ${resourceDisplayLabel(selectedResource)} · ${selectedResource.event_count || selectedResource.payload?.events?.length || 0} cours · mise à jour ${selectedResource.updated_at ? new Date(selectedResource.updated_at).toLocaleString('fr-FR') : 'inconnue'}`
                : resources.length
                    ? 'Choisissez votre année, votre spécialité puis votre semestre.'
                    : 'Aucune filière n’a encore été publiée par le collecteur.';
        }
    }

    function resetHierarchyAfter(select, ids) {
        // Une modification d'un niveau parent invalide volontairement tous les niveaux
        // descendants. Ils restent vides jusqu'à un nouveau choix explicite de l'utilisateur.
        for (const id of ids) {
            const el = byId(id);
            if (!el) continue;
            el.dataset.touched = '1';
            el.value = '';
        }
        select.dataset.touched = '1';
    }

    function clearCurrentProgramSelection() {
        state.selectedProgramResourceId = null;
        if (state.resourceMode !== 'program') return;
        state.selectedResourceId = null;
        state.payload = null;
        renderPlanningFilters(true);
        renderWeek();
        updateConnectionUi();
    }

    function clearCurrentRoomSelection() {
        state.selectedRoomResourceId = null;
        if (state.resourceMode !== 'room') return;
        state.selectedResourceId = null;
        state.payload = null;
        renderPlanningFilters(true);
        renderWeek();
        updateConnectionUi();
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
        if (verification) verification.hidden = accessGranted;
        if (resourcePanel) resourcePanel.hidden = !accessGranted;
        if (accountMeta) accountMeta.hidden = !accessGranted || !state.selectedResourceId;
        if (collector) collector.hidden = !state.isAdmin;
        configureCollectorPlatformUi();

        const title = byId('planning-access-title');
        const description = byId('planning-access-description');
        const button = byId('planning-verify-ade');
        if (!accessGranted && !state.user) {
            if (title) title.textContent = 'Activer votre compte';
            if (description) description.textContent = 'Connectez-vous ou créez un compte, puis vérifiez votre adresse universitaire pour consulter les emplois du temps.';
            if (button && !state.adeVerificationLoading) button.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Se connecter / créer un compte';
        } else if (!accessGranted) {
            if (title) title.textContent = 'Activer votre accès universitaire';
            if (description) description.textContent = 'Votre compte est connecté. Vérifiez maintenant votre adresse universitaire (@etu.unilim.fr ou @unilim.fr) avec un code à usage unique.';
            if (button && !state.adeVerificationLoading) button.innerHTML = '<i class="fa-solid fa-envelope-circle-check"></i> Vérifier mon adresse universitaire';
        }

        document.querySelectorAll(
            '#planning > .planning-toolbar, #planning > .planning-filter-panel, #planning > .planning-mobile-panel, #planning > .planning-timetable-shell'
        ).forEach(element => {
            element.hidden = !accessGranted;
            // Sécurité visuelle : certains anciens CSS forçaient le panneau de tri à rester affiché malgré [hidden].
            if (!accessGranted) element.style.setProperty('display', 'none', 'important');
            else element.style.removeProperty('display');
        });
        publishUniversityAccessState();
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
        // Ancien callback CAS : conservé comme no-op pour les anciennes URL mises en cache.
        const url = new URL(window.location.href);
        if (!url.searchParams.has('ade')) return;
        url.searchParams.delete('ade');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash || '#planning'}`);
    }

    function universityVerificationMessage(text = '', type = '') {
        const element = byId('university-email-message');
        if (!element) return;
        element.hidden = !text;
        element.textContent = text;
        element.classList.toggle('error', type === 'error');
        element.classList.toggle('success', type === 'success');
    }

    function universityVerificationStorageKey() {
        return state.user?.id ? `ade-student-email:${state.user.id}` : '';
    }

    function formatCountdown(milliseconds) {
        const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
        const minutes = Math.floor(seconds / 60);
        const rest = seconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    }

    function updateUniversityVerificationTimers() {
        const now = Date.now();
        const expiry = byId('university-code-expiry');
        const verify = byId('university-code-verify');
        const resend = byId('university-code-resend');
        if (expiry) expiry.textContent = formatCountdown(universityEmailVerification.expiresAt - now);
        if (verify) verify.disabled = Boolean(universityEmailVerification.expiresAt && now >= universityEmailVerification.expiresAt);
        if (resend) {
            const remaining = Math.max(0, Math.ceil((universityEmailVerification.resendAt - now) / 1000));
            resend.disabled = remaining > 0;
            resend.innerHTML = remaining > 0
                ? `<i class="fa-solid fa-rotate-right"></i> Renvoyer dans ${remaining} s`
                : '<i class="fa-solid fa-rotate-right"></i> Renvoyer le code';
        }
        if (universityEmailVerification.expiresAt && now >= universityEmailVerification.expiresAt) {
            const message = byId('university-email-message');
            if (message?.hidden) universityVerificationMessage('Le code a expiré. Demandez-en un nouveau.', 'error');
        }
    }

    function startUniversityVerificationTimer() {
        if (universityEmailVerification.timer) window.clearInterval(universityEmailVerification.timer);
        updateUniversityVerificationTimers();
        universityEmailVerification.timer = window.setInterval(updateUniversityVerificationTimers, 1000);
    }

    function stopUniversityVerificationTimer() {
        if (universityEmailVerification.timer) window.clearInterval(universityEmailVerification.timer);
        universityEmailVerification.timer = null;
    }

    function showUniversityAddressStep() {
        const address = byId('university-email-step-address');
        const code = byId('university-email-step-code');
        if (address) address.hidden = false;
        if (code) code.hidden = true;
        byId('university-code-input')?.setAttribute('value', '');
        const codeInput = byId('university-code-input');
        if (codeInput) codeInput.value = '';
        universityVerificationMessage('');
        window.setTimeout(() => byId('university-email-input')?.focus(), 30);
    }

    function showUniversityCodeStep(maskedEmail = '') {
        const address = byId('university-email-step-address');
        const code = byId('university-email-step-code');
        if (address) address.hidden = true;
        if (code) code.hidden = false;
        const target = byId('university-email-target');
        if (target) target.textContent = `Envoyé à ${maskedEmail || universityEmailVerification.email}`;
        universityVerificationMessage('');
        startUniversityVerificationTimer();
        window.setTimeout(() => byId('university-code-input')?.focus(), 30);
    }

    function openUniversityEmailModal(returnHash = '#planning') {
        universityEmailVerification.returnHash = ['#planning', '#courses'].includes(returnHash) ? returnHash : '#planning';
        const modal = byId('universityEmailModal');
        const input = byId('university-email-input');
        if (input && !input.value) {
            const key = universityVerificationStorageKey();
            if (key) input.value = localStorage.getItem(key) || '';
        }
        if (universityEmailVerification.email && universityEmailVerification.expiresAt > Date.now()) {
            showUniversityCodeStep(universityEmailVerification.email);
        } else {
            showUniversityAddressStep();
        }
        modal?.classList.add('active');
    }

    function closeUniversityEmailModal() {
        byId('universityEmailModal')?.classList.remove('active');
        stopUniversityVerificationTimer();
        universityVerificationMessage('');
    }

    function verificationErrorText(result = {}) {
        const retry = Number(result.retry_after_seconds || 0);
        switch (result.code) {
            case 'INVALID_STUDENT_EMAIL':
            case 'INVALID_UNIVERSITY_EMAIL': return 'Utilisez une adresse universitaire @etu.unilim.fr ou @unilim.fr.';
            case 'EMAIL_ALREADY_USED': return 'Cette adresse universitaire a déjà été utilisée pour activer un autre compte.';
            case 'WAIT_BEFORE_RESEND': return `Patientez encore ${Math.max(1, retry)} seconde${retry > 1 ? 's' : ''} avant de renvoyer un code.`;
            case 'RATE_LIMITED': return `Trop de codes ont été demandés. Réessayez dans environ ${Math.max(1, Math.ceil(retry / 60))} minute(s).`;
            case 'WRONG_CODE': return `Ce code est incorrect.${Number.isFinite(Number(result.attempts_remaining)) ? ` ${result.attempts_remaining} essai(s) restant(s).` : ''}`;
            case 'CODE_EXPIRED': return 'Ce code a expiré. Demandez-en un nouveau.';
            case 'NO_ACTIVE_CODE': return 'Aucun code actif. Demandez un nouveau code.';
            case 'TOO_MANY_ATTEMPTS': return 'Trop d’essais incorrects. Demandez un nouveau code.';
            case 'INVALID_CODE_FORMAT': return 'Le code doit contenir exactement 6 chiffres.';
            case 'SUPABASE_EMAIL_NOT_AUTHORIZED': return 'Supabase Auth refuse l’envoi à cette adresse avec son service mail intégré. Consultez la note de configuration du projet.';
            case 'SUPABASE_EMAIL_RATE_LIMIT': return 'La limite d’envoi de Supabase Auth est atteinte. Réessayez un peu plus tard.';
            case 'EMAIL_SEND_FAILED': return 'L’e-mail n’a pas pu être envoyé pour le moment. Réessayez dans quelques instants.';
            case 'SCHEMA_NOT_INSTALLED': return 'La base de données de vérification n’est pas encore installée. Exécutez le fichier supabase/email_verification_setup.sql dans Supabase.';
            case 'BACKEND_OUTDATED':
            case 'INVALID_ACTION': return 'La fonction de vérification déployée n’est pas à jour. Redéployez la fonction Supabase « verify-ade ».';
            case 'REQUEST_LOOKUP_FAILED':
            case 'REQUEST_CREATION_FAILED': return 'Le stockage des codes OTP n’est pas disponible. Vérifiez que le script SQL de vérification a bien été exécuté.';
            case 'AUTH_TARGET_CREATION_FAILED': return 'Supabase Auth n’a pas pu préparer l’adresse universitaire pour l’envoi. Vérifiez les journaux de la fonction « verify-ade ».';
            case 'SERVER_NOT_CONFIGURED': return 'Le service de vérification n’est pas disponible pour le moment.';
            default: {
                const suffix = result?.code ? ` (erreur : ${result.code})` : '';
                return `La vérification est momentanément indisponible${suffix}. Réessayez dans quelques instants.`;
            }
        }
    }

    async function invokeUniversityVerification(body) {
        const client = getSupabase();
        if (!client) throw new Error('SUPABASE_UNAVAILABLE');
        const { data, error } = await client.functions.invoke('verify-ade', { body });
        if (!error) return data || {};
        try {
            const payload = await error.context?.json?.();
            if (payload?.code) return payload;
        } catch {}
        throw error;
    }

    async function completeUniversityVerification() {
        state.adeVerified = true;
        universityVerificationMessage('Adresse universitaire vérifiée. Activation du compte…', 'success');
        await onAccountChanged(state.user);
        const planningStatus = byId('planning-verification-status');
        if (planningStatus) {
            planningStatus.textContent = 'Adresse universitaire vérifiée. Votre accès est activé.';
            planningStatus.classList.remove('error');
        }
        const coursesStatus = document.getElementById('courses-access-status');
        if (coursesStatus) {
            coursesStatus.textContent = 'Adresse universitaire vérifiée. Votre accès est activé.';
            coursesStatus.classList.remove('error');
        }
        window.setTimeout(closeUniversityEmailModal, 350);
    }

    async function sendUniversityVerificationCode({ resend = false } = {}) {
        if (!state.user || state.adeVerificationLoading) return;
        const input = byId('university-email-input');
        const email = String(resend ? universityEmailVerification.email : input?.value || '').trim().toLowerCase();
        if (!email) {
            universityVerificationMessage('Saisissez votre adresse universitaire.', 'error');
            input?.focus();
            return;
        }

        const sendButton = byId('university-email-send');
        const resendButton = byId('university-code-resend');
        state.adeVerificationLoading = true;
        if (sendButton) sendButton.disabled = true;
        if (resendButton) resendButton.disabled = true;
        universityVerificationMessage(resend ? 'Renvoi du code…' : 'Envoi du code…');

        try {
            const result = await invokeUniversityVerification({ action: 'send_code', email });
            if (result?.code === 'ALREADY_VERIFIED') {
                await completeUniversityVerification();
                return;
            }
            if (!result?.ok || result?.code !== 'CODE_SENT') {
                if (result?.code === 'WAIT_BEFORE_RESEND' && retryAfterIsFinite(result)) {
                    universityEmailVerification.resendAt = Date.now() + Number(result.retry_after_seconds) * 1000;
                    startUniversityVerificationTimer();
                }
                universityVerificationMessage(verificationErrorText(result), 'error');
                return;
            }

            universityEmailVerification.email = email;
            universityEmailVerification.expiresAt = Date.now() + Number(result.expires_in_seconds || 300) * 1000;
            universityEmailVerification.resendAt = Date.now() + Number(result.resend_after_seconds || 60) * 1000;
            const key = universityVerificationStorageKey();
            if (key) localStorage.setItem(key, email);
            showUniversityCodeStep(result.masked_email || email);
            universityVerificationMessage(resend ? 'Un nouveau code a été envoyé. L’ancien n’est plus valable. Vérifiez aussi vos courriers indésirables / spams.' : 'Code envoyé. Consultez votre messagerie universitaire et, si besoin, vos courriers indésirables / spams.', 'success');
        } catch (error) {
            console.error('Envoi du code universitaire impossible :', error);
            universityVerificationMessage('Impossible d’envoyer le code pour le moment. Réessayez dans quelques instants.', 'error');
        } finally {
            state.adeVerificationLoading = false;
            if (sendButton) sendButton.disabled = false;
            updateUniversityVerificationTimers();
        }
    }

    function retryAfterIsFinite(result) {
        return Number.isFinite(Number(result?.retry_after_seconds)) && Number(result.retry_after_seconds) > 0;
    }

    async function verifyUniversityEmailCode() {
        if (!state.user || state.adeVerificationLoading) return;
        const input = byId('university-code-input');
        const code = String(input?.value || '').replace(/\D/g, '').slice(0, 6);
        if (input) input.value = code;
        if (!/^\d{6}$/.test(code)) {
            universityVerificationMessage('Saisissez les 6 chiffres du code reçu.', 'error');
            input?.focus();
            return;
        }

        const button = byId('university-code-verify');
        state.adeVerificationLoading = true;
        if (button) button.disabled = true;
        universityVerificationMessage('Vérification du code…');
        try {
            const result = await invokeUniversityVerification({ action: 'verify_code', code });
            if (result?.code === 'ALREADY_VERIFIED' || (result?.ok && result?.code === 'VERIFIED')) {
                await completeUniversityVerification();
                return;
            }
            if (['CODE_EXPIRED', 'NO_ACTIVE_CODE', 'TOO_MANY_ATTEMPTS'].includes(result?.code)) {
                universityEmailVerification.expiresAt = 0;
            }
            universityVerificationMessage(verificationErrorText(result), 'error');
            if (result?.code === 'WRONG_CODE') {
                if (input) input.value = '';
                input?.focus();
            }
        } catch (error) {
            console.error('Validation du code universitaire impossible :', error);
            universityVerificationMessage('Impossible de vérifier le code pour le moment. Réessayez dans quelques instants.', 'error');
        } finally {
            state.adeVerificationLoading = false;
            if (button) button.disabled = false;
            updateUniversityVerificationTimers();
        }
    }

    async function beginAdeVerification(returnHash = '#planning') {
        if (!state.user) {
            window.openAccountModal?.('login');
            return;
        }
        if (state.adeVerified) return;
        openUniversityEmailModal(returnHash);
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
            console.warn('Catalogue partagé des emplois du temps indisponible :', error);
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
            const resourceId = data?.resource_id ? String(data.resource_id) : null;
            const resource = resourceId
                ? state.sharedResources.find(item => String(item.resource_id) === resourceId)
                : null;
            // Seules les filières constituent une préférence persistante. Une ancienne
            // version a pu enregistrer une salle : elle est volontairement ignorée ici.
            state.selectedProgramResourceId = resource && resourceKind(resource) === 'program' ? resourceId : null;
            if (state.resourceMode === 'program') state.selectedResourceId = state.selectedProgramResourceId;
        } catch (error) {
            console.warn('Préférence d’emploi du temps indisponible :', error);
        }
        renderResourceChooser();
        return state.selectedProgramResourceId;
    }

    function useSelectedSharedPayload() {
        const selected = state.sharedResources.find(resource =>
            String(resource.resource_id) === String(state.selectedResourceId)
        );
        if (!selected?.payload?.events || !Array.isArray(selected.payload.events)) return null;
        if (resourceKind(selected) === 'program') saveLocalPayload(selected.payload);
        else useTransientPayload(selected.payload);
        state.cloudAvailable = true;
        state.cloudLoaded = true;
        ensureCurrentWeek();
        renderPlanningFilters(true);
        renderWeek();
        renderResourceChooser();
        return selected.payload;
    }

    function activateTemporaryRoom(resourceId) {
        const id = resourceId ? String(resourceId) : null;
        const resource = id
            ? state.sharedResources.find(item => String(item.resource_id) === id)
            : null;
        if (!resource || resourceKind(resource) !== 'room') return false;
        state.selectedRoomResourceId = id;
        state.selectedResourceId = id;
        return Boolean(useSelectedSharedPayload());
    }

    function activateResourceMode(mode) {
        state.resourceMode = mode === 'room' ? 'room' : 'program';
        state.resourceModeTouched = true;
        if (state.resourceMode === 'program') {
            ['planning-resource-year', 'planning-resource-speciality', 'planning-resource-semester', 'planning-resource-group']
                .forEach(id => {
                    const select = byId(id);
                    if (select) select.dataset.touched = '0';
                });
        }
        const targetId = state.resourceMode === 'room'
            ? state.selectedRoomResourceId
            : state.selectedProgramResourceId;
        state.selectedResourceId = targetId || null;
        if (targetId) {
            useSelectedSharedPayload();
            updateConnectionUi();
        } else {
            // Ne jamais laisser l'EDT de l'autre mode affiché lorsqu'aucune ressource
            // n'est choisie dans le mode courant.
            state.payload = null;
            renderPlanningFilters(true);
            renderWeek();
            renderResourceChooser();
            updateConnectionUi();
        }
    }

    async function savePlanningPreference(resourceId) {
        if (!state.user?.id || !resourceId || (!state.isAdmin && !state.adeVerified)) return false;
        const resource = state.sharedResources.find(item => String(item.resource_id) === String(resourceId));
        if (!resource || resourceKind(resource) !== 'program') {
            console.warn('Seules les filières peuvent être enregistrées comme préférence.');
            return false;
        }
        const client = getSupabase();
        if (!client) return false;
        try {
            const { error } = await client.from(PREFERENCES_TABLE).upsert({
                user_id: state.user.id,
                resource_id: String(resourceId),
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });
            if (error) throw error;
            state.selectedProgramResourceId = String(resourceId);
            state.selectedResourceId = String(resourceId);
            useSelectedSharedPayload();
            return true;
        } catch (error) {
            console.warn('Enregistrement de l’emploi du temps impossible :', error);
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
        renderCollectorRows();
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

    function collectorItemKind(item) {
        return collectorKindFromPath(item?.path || '');
    }

    function collectorFailuresForKind(kind) {
        if (kind === 'all') return [...state.collectorFailures];
        return state.collectorFailures.filter(item => collectorItemKind(item) === kind);
    }

    function replaceCollectorFailuresForKinds(kinds, failures = []) {
        const kindSet = new Set((Array.isArray(kinds) ? kinds : [kinds]).map(kind => kind === 'room' ? 'room' : 'program'));
        const preserved = state.collectorFailures.filter(item => !kindSet.has(collectorItemKind(item)));
        const merged = new Map(preserved.map(item => [collectorFailureKey(item), item]));
        for (const item of failures || []) merged.set(collectorFailureKey(item), item);
        saveCollectorFailures([...merged.values()]);
    }

    async function clearCollectorFailuresForKinds(kinds) {
        const normalized = [...new Set((Array.isArray(kinds) ? kinds : [kinds]).map(kind => kind === 'room' ? 'room' : 'program'))];
        replaceCollectorFailuresForKinds(normalized, []);
        if (!state.isAdmin) return;
        const client = getSupabase();
        if (!client) return;
        for (const kind of normalized) {
            const profile = collectorProfile(kind);
            try {
                const { error } = await client.from(SYNC_FAILURES_TABLE)
                    .delete()
                    .like('path', `${profile.scopePath}%`);
                if (error) throw error;
            } catch (error) {
                console.warn(`Nettoyage des échecs ${profile.plural} impossible :`, error);
            }
        }
    }

    function updateCollectorActionButtons() {
        const blocked = Boolean(state.busy || state.collectorRunning);
        document.querySelectorAll('[data-collector-sync]').forEach(button => {
            button.disabled = blocked;
            button.toggleAttribute('disabled', blocked);
            button.setAttribute('aria-disabled', blocked ? 'true' : 'false');
            button.setAttribute('aria-busy', state.collectorRunning ? 'true' : 'false');
        });

        const programCount = collectorFailuresForKind('program').length;
        const roomCount = collectorFailuresForKind('room').length;
        const allCount = state.collectorFailures.length;
        const counts = { program: programCount, room: roomCount, all: allCount };
        document.querySelectorAll('[data-failure-count]').forEach(node => {
            node.textContent = String(counts[node.dataset.failureCount] ?? 0);
        });
        document.querySelectorAll('[data-collector-retry]').forEach(button => {
            const kind = button.dataset.collectorRetry || 'all';
            const count = counts[kind] ?? 0;
            const disabled = blocked || count === 0;
            button.disabled = disabled;
            button.toggleAttribute('disabled', disabled);
            button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            button.setAttribute('aria-busy', state.collectorRunning ? 'true' : 'false');
        });
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
        const failuresByKey = new Map((state.collectorFailures || []).map(item => [collectorFailureKey(item), item]));
        container.innerHTML = rows.length ? rows.map(row => {
            const failure = failuresByKey.get(collectorFailureKey(row)) || null;
            const failureText = failure
                ? [failure.code, failure.message].filter(Boolean).join(' · ')
                : '';
            const kind = collectorItemKind(row);
            return `
            <article class="planning-collector-resource${failure ? ' is-failed' : ''}">
                <i class="fa-solid ${failure ? 'fa-triangle-exclamation' : 'fa-check'}" aria-hidden="true"></i>
                <span>
                    <small class="planning-collector-resource-kind">${kind === 'room' ? 'Salle' : 'Filière'}</small>
                    <strong>${escapePlanning(row.label || `Planning ${row.resourceId}`)}</strong>
                    <small>${escapePlanning(row.path || '')}</small>
                    ${failureText ? `<small class="planning-collector-error">${escapePlanning(failureText)}</small>` : ''}
                </span>
            </article>`;
        }).join('') : '';
    }

    function isCollectorTerminalLabel(label) {
        const value = String(label || '').trim();
        return /^semestre\s+\d+$/i.test(value) || /^(?:AN|ANNÉE|ANNEE)$/i.test(value);
    }

    function isCollectorTarget(row) {
        if (row?.resourceId == null) return false;
        if (pathIsInRoomScope(row.path)) {
            const parts = String(row.path || '').split('>').map(part => part.trim()).filter(Boolean);
            const scopeParts = COLLECTOR_ROOM_SCOPE_PATH.split('>').map(part => part.trim()).filter(Boolean);
            const label = String(row.label || parts.at(-1) || '').trim();
            return parts.length >= scopeParts.length + 1 && row.branchToggle !== true && !/^B(?:A|Â)TIMENT\b/i.test(label);
        }
        return row.level >= 3 && isCollectorTerminalLabel(row.label) && pathIsInProgramScope(row.path);
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
                        maxDepth: 4,
                        scopeRoot: 'Groupes Etudiants',
                        scopePath: COLLECTOR_PROGRAM_SCOPE_PATH
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
                if (status) status.textContent = 'Connexion ADE requise. Après authentification, revenir sur Planilim pour reprendre la synchronisation.';
                try { await requestExtension('PLANILIM_ADE_CONNECT', { timeout: 20000 }); } catch {}
            } else if (status) {
                status.textContent = state.collectorRows.length
                    ? 'La lecture a été interrompue. Les filières déjà trouvées sont conservées ; une nouvelle tentative peut reprendre la lecture.'
                    : 'Le collecteur n’a pas pu lire ADE. Une nouvelle tentative peut être lancée dans quelques instants.';
            }
            return { ok: false, code: error?.code || 'CATALOG_FAILED', authRequired };
        } finally {
            setLoading(false);
            renderCollectorRows();
        }
    }


    async function runCollectorPipeline(profile = COLLECTOR_PROFILES.program, progressContext = {}) {
        if (!state.isAdmin || state.busy) return { ok: false, code: 'BUSY' };
        const status = byId('planning-collector-status');
        const activeProfile = collectorProfile(profile?.key || profile?.targetKind || 'program');
        const progressPhaseIndex = Math.max(0, Number(progressContext.phaseIndex || 0));
        const progressPhaseCount = Math.max(1, Number(progressContext.phaseCount || 1));
        updateCollectorActionButtons();

        let successCount = 0;
        let discoveredCount = 0;
        let completedCount = 0;
        let failureCount = 0;
        let authRequired = false;
        let runId = null;
        let targetCursor = 0;
        let resultCursor = 0;
        let lastSnapshot = null;
        let lastPublishAt = Date.now();
        const failures = new Map();
        const successfulResourceIds = [];
        const pendingPublishIds = [];

        const rememberFailure = item => {
            if (!item) return;
            const target = item.target || item;
            const key = target?.resourceId != null
                ? `resource:${Number(target.resourceId)}`
                : `${target?.path || ''}:${target?.label || ''}`;
            failures.set(key, {
                resourceId: target?.resourceId ?? null,
                label: target?.label || null,
                path: target?.path || null,
                level: target?.level ?? null,
                branchToggle: target?.branchToggle ?? false,
                expanded: target?.expanded ?? null,
                code: item.code || 'SYNC_FAILED',
                message: item.message || null
            });
        };

        const flushPublishedPayloads = async () => {
            if (!pendingPublishIds.length) return true;
            const ids = [...new Set(pendingPublishIds.splice(0, pendingPublishIds.length).map(Number))];
            if (!ids.length) return true;
            try {
                const published = await publishCollectorPayloads(ids);
                if (!published?.ok) throw new Error(published?.code || 'PUBLISH_FAILED');
                lastPublishAt = Date.now();
                return true;
            } catch (error) {
                for (const resourceId of ids) {
                    const target = state.collectorRows.find(row => Number(row.resourceId) === Number(resourceId)) || { resourceId };
                    rememberFailure({
                        ...target,
                        code: 'PUBLISH_FAILED',
                        message: String(error)
                    });
                }
                return false;
            }
        };

        const formatWorkerProgress = workers => {
            const activeWorkers = (Array.isArray(workers) ? workers : [])
                .filter(worker => ['syncing', 'done', 'failed'].includes(worker?.state));
            const shown = activeWorkers.slice(0, 6).map(worker => {
                const id = Number(worker.workerId) + 1;
                if (worker.state === 'syncing') {
                    const current = Number(worker.weekCurrent || 0);
                    const total = Number(worker.weekTotal || 44);
                    return `W${id} ${current}/${total}`;
                }
                return `W${id} ${worker.state === 'done' ? '✓' : '!'}`;
            });
            if (!shown.length) return '';
            const hidden = Math.max(0, activeWorkers.length - shown.length);
            return ` · ${shown.join(' · ')}${hidden ? ` · +${hidden} actifs` : ''}`;
        };

        const updatePipelineProgress = snapshot => {
            const total = Math.max(discoveredCount, Number(snapshot?.discoveredCount || 0));
            const done = Math.max(completedCount, Number(snapshot?.completedCount || 0));
            let localPercent = total > 0 ? (Math.min(done, total) / total) * 100 : 0;
            // Tant que l'extension effectue encore des réparations, garder un peu
            // de marge visuelle même si tous les EDT ont été parcourus une fois.
            if (!snapshot?.done && total > 0 && localPercent >= 100) localPercent = 99;
            const overallPercent = ((progressPhaseIndex + (localPercent / 100)) / progressPhaseCount) * 100;
            const phaseSuffix = progressPhaseCount > 1
                ? ` · étape ${progressPhaseIndex + 1}/${progressPhaseCount}`
                : '';
            setCollectorProgress({
                current: Math.min(done, total || done),
                total,
                percent: overallPercent,
                label: `${activeProfile.label} · synchronisation`,
                detail: total > 0
                    ? `${Math.min(done, total)} / ${total} EDT · ${COLLECTOR_DEFAULT_WORKERS} workers${phaseSuffix}`
                    : `Lecture du catalogue ADE…${phaseSuffix}`
            });
        };

        const updateLiveStatus = snapshot => {
            if (!status || !snapshot) return;
            const workers = Number(snapshot.workerCount || snapshot.requestedWorkerCount || COLLECTOR_DEFAULT_WORKERS);
            const adaptiveMax = Math.max(workers, Number(snapshot.adaptiveMaxWorkerCount || COLLECTOR_ADAPTIVE_MAX_WORKERS));
            const adaptiveFrozen = Boolean(snapshot.adaptiveScaleFrozen);
            const adaptiveState = String(snapshot.adaptiveScaleState || '');
            const workerLabel = adaptiveMax > COLLECTOR_DEFAULT_WORKERS
                ? `${workers}/${adaptiveMax} workers adaptatifs${adaptiveFrozen ? ' · mode stable' : ''}`
                : `${workers} workers`;
            const phase = String(snapshot.phase || '');
            if (phase.startsWith('coordinator') || phase === 'catalog_ready') {
                status.textContent = `${activeProfile.label} · Lecture de l’arbre ADE · ${Number(snapshot.discoveredCount || 0)} EDT détectés`;
                return;
            }
            if (phase === 'worker_pool_bootstrap') {
                status.textContent = `${activeProfile.label} · ${COLLECTOR_DEFAULT_WORKERS} workers · ${discoveredCount} EDT détectés · Ouverture des pages ADE…`;
                return;
            }
            if (phase === 'repairing_holes') {
                const repairWorkers = Number(snapshot.repairWorkerCount || 4);
                const repairPending = Number(snapshot.repairPendingCount || 0);
                const repairRound = Number(snapshot.repairRound || 1);
                const repairRecovered = Number(snapshot.repairRecoveredCount || 0);
                status.textContent = `${repairWorkers} workers de réparation · ${completedCount}/${discoveredCount || '…'} EDT · ${successCount} complets · ${repairPending} avec trous · tour ${repairRound} · ${repairRecovered} réparé${repairRecovered > 1 ? 's' : ''}${formatWorkerProgress(snapshot.workers)}`;
                return;
            }
            const scaleNote = adaptiveState === 'opening_worker'
                ? ' · ouverture d’un worker supplémentaire…'
                : (adaptiveState === 'fallback_4' ? ' · retour automatique au mode 4 workers' : '');
            status.textContent = `${workerLabel} · Découverte ${discoveredCount} · Synchronisation ${completedCount}/${discoveredCount || '…'} · ${successCount} réussie${successCount > 1 ? 's' : ''}${failureCount ? ` · ${failureCount} échec${failureCount > 1 ? 's' : ''}` : ''}${scaleNote}${formatWorkerProgress(snapshot.workers)}`;
        };

        setLoading(
            true,
            'Synchronisation en cours…',
            `${activeProfile.label} · lecture du catalogue puis démarrage de ${COLLECTOR_DEFAULT_WORKERS} workers stables.`
        );
        if (status) status.textContent = `${activeProfile.label} · lecture de l’arbre ADE…`;
        setCollectorProgress({
            current: 0,
            total: 0,
            percent: (progressPhaseIndex / progressPhaseCount) * 100,
            label: `${activeProfile.label} · préparation`,
            detail: progressPhaseCount > 1
                ? `Lecture du catalogue ADE · étape ${progressPhaseIndex + 1}/${progressPhaseCount}`
                : 'Lecture du catalogue ADE…'
        });

        try {
            // Le démarrage rend immédiatement un runId. Le travail continue
            // côté extension ; le site ne garde plus une requête de plusieurs
            // minutes ouverte et ne peut donc plus interrompre les workers sur
            // un timeout d'interface.
            const started = await requestExtension('PLANILIM_COLLECTOR_ASYNC_START', {
                timeout: 20000,
                payload: {
                    scopePath: activeProfile.scopePath,
                    targetKind: activeProfile.targetKind,
                    maxDepth: activeProfile.maxDepth,
                    maxActions: 600,
                    workerCount: COLLECTOR_DEFAULT_WORKERS,
                    adaptiveMaxWorkerCount: COLLECTOR_ADAPTIVE_MAX_WORKERS
                }
            });
            if (!started?.ok || !started?.runId) {
                const error = new Error(started?.message || started?.code || 'Impossible de démarrer le collecteur asynchrone.');
                error.code = started?.code || 'COLLECTOR_ASYNC_START_FAILED';
                throw error;
            }
            runId = String(started.runId);

            let consecutivePollErrors = 0;
            let guard = 0;
            while (guard++ < 7200) {
                let snapshot = null;
                try {
                    snapshot = await requestExtension('PLANILIM_COLLECTOR_ASYNC_STATE', {
                        timeout: 10000,
                        payload: { runId, targetCursor, resultCursor }
                    });
                    consecutivePollErrors = 0;
                } catch (error) {
                    consecutivePollErrors += 1;
                    if (consecutivePollErrors >= 12) throw error;
                    if (status) status.textContent = `Synchronisation toujours active · reconnexion au suivi (${consecutivePollErrors}/12)…`;
                    await new Promise(resolve => window.setTimeout(resolve, COLLECTOR_PROGRESS_POLL_MS));
                    continue;
                }

                if (!snapshot?.ok) {
                    if (['AUTH_REQUIRED', 'COLLECTOR_ASYNC_RUN_MISMATCH'].includes(snapshot?.code)) {
                        authRequired = snapshot?.code === 'AUTH_REQUIRED';
                        lastSnapshot = snapshot;
                        break;
                    }
                    const error = new Error(snapshot?.message || snapshot?.code || 'Le suivi du collecteur a échoué.');
                    error.code = snapshot?.code || 'COLLECTOR_ASYNC_STATE_FAILED';
                    throw error;
                }

                lastSnapshot = snapshot;
                discoveredCount = Math.max(discoveredCount, Number(snapshot.discoveredCount || 0));
                completedCount = Math.max(completedCount, Number(snapshot.completedCount || 0));
                // Les retries et la phase de réparation peuvent transformer un
                // échec en succès. Ces deux compteurs doivent donc refléter le
                // snapshot courant et non leur maximum historique.
                successCount = Number(snapshot.successCount || 0);
                failureCount = Number(snapshot.failureCount || 0);
                authRequired = Boolean(snapshot.authRequired || snapshot.state === 'auth_required');

                const discoveredTargets = Array.isArray(snapshot.discoveredTargets) ? snapshot.discoveredTargets : [];
                if (discoveredTargets.length) {
                    mergeCollectorRows(discoveredTargets.map(target => ({ ...target, selected: true })));
                    renderCollectorRows();
                }
                targetCursor = Math.max(targetCursor, Number(snapshot.nextTargetCursor || targetCursor));

                const completedResults = Array.isArray(snapshot.completedResults) ? snapshot.completedResults : [];
                for (const result of completedResults) {
                    if (!result) continue;
                    const resourceId = result.resourceId;
                    if (result.ok) {
                        if (resourceId != null) {
                            successfulResourceIds.push(Number(resourceId));
                            pendingPublishIds.push(Number(resourceId));
                            failures.delete(`resource:${Number(resourceId)}`);
                        }
                    } else {
                        rememberFailure(result);
                    }
                    if (result.authRequired || result.code === 'AUTH_REQUIRED') authRequired = true;
                }
                resultCursor = Math.max(resultCursor, Number(snapshot.nextResultCursor || resultCursor));

                updatePipelineProgress(snapshot);
                updateLiveStatus(snapshot);

                // Les résultats sont publiés au fil de l'eau, sans attendre la
                // fin des 216 EDT. Avec plusieurs workers, un lot de résultats
                // réussites suffit pour déclencher une écriture Supabase.
                if (pendingPublishIds.length >= COLLECTOR_DEFAULT_WORKERS || snapshot.done || Date.now() - lastPublishAt > 15000) {
                    await flushPublishedPayloads();
                    const failureRows = [...failures.values()];
                    replaceCollectorFailuresForKinds([activeProfile.key], failureRows);
                    await persistCollectorFailureRows(failureRows, successfulResourceIds);
                }

                if (snapshot.done) break;
                await new Promise(resolve => window.setTimeout(resolve, COLLECTOR_PROGRESS_POLL_MS));
            }

            await flushPublishedPayloads();
            const failureRows = [...failures.values()];
            replaceCollectorFailuresForKinds([activeProfile.key], failureRows);
            await persistCollectorFailureRows(failureRows, successfulResourceIds);
            await loadSharedResources();
            useSelectedSharedPayload();

            const finalState = String(lastSnapshot?.state || '');
            const fatal = finalState === 'failed';
            if (status) {
                if (authRequired) {
                    status.textContent = `${activeProfile.label} · ${successCount} emploi${successCount > 1 ? 's' : ''} du temps terminé${successCount > 1 ? 's' : ''}. Une reconnexion ADE est nécessaire avant la relance des échecs.`;
                } else if (fatal) {
                    status.textContent = `${activeProfile.label} · collecte interrompue après ${completedCount}/${discoveredCount || '…'} EDT. Les résultats déjà publiés sont conservés.`;
                } else if (!failureRows.length) {
                    status.textContent = `${activeProfile.label} · ${successCount} emplois du temps synchronisés sur ${discoveredCount}. ADE peut être fermé.`;
                } else {
                    status.textContent = `${activeProfile.label} · ${successCount} emplois du temps synchronisés sur ${discoveredCount}. ${failureRows.length} restent à relancer.`;
                }
            }

            if (!authRequired && !fatal) {
                setCollectorProgress({
                    current: discoveredCount,
                    total: discoveredCount,
                    percent: ((progressPhaseIndex + 1) / progressPhaseCount) * 100,
                    label: `${activeProfile.label} · terminé`,
                    detail: `${completedCount || discoveredCount} / ${discoveredCount || completedCount || 0} EDT traités${progressPhaseCount > 1 ? ` · étape ${progressPhaseIndex + 1}/${progressPhaseCount}` : ''}`
                });
            }

            return {
                ok: !authRequired && !fatal && failureRows.length === 0,
                code: lastSnapshot?.code || null,
                runId,
                successCount,
                discoveredCount,
                completedCount,
                failures: failureRows,
                profile: activeProfile.key
            };
        } catch (error) {
            console.warn('Collecteur ADE asynchrone interrompu :', error);
            if (status) {
                status.textContent = `${activeProfile.label} · suivi interrompu après ${completedCount}/${discoveredCount || '…'} EDT. Les résultats déjà publiés sont conservés.`;
            }
            const failureRows = [...failures.values()];
            replaceCollectorFailuresForKinds([activeProfile.key], failureRows);
            try { await persistCollectorFailureRows(failureRows, successfulResourceIds); } catch {}
            return { ok: false, code: error?.code || 'PIPELINE_FAILED', runId, failures: failureRows, profile: activeProfile.key };
        } finally {
            setLoading(false);
            renderCollectorRows();
        }
    }

    async function publishCollectorPayloads(resourceIds = null) {
        if (!state.isAdmin) return { ok: false, code: 'ADMIN_REQUIRED' };
        const client = getSupabase();
        if (!client) return { ok: false, code: 'SUPABASE_UNAVAILABLE' };

        const result = await requestExtension('PLANILIM_COLLECTOR_PAYLOADS', { timeout: 20000 });
        const requested = resourceIds == null
            ? null
            : new Set((Array.isArray(resourceIds) ? resourceIds : [resourceIds]).map(value => Number(value)));
        const resources = (Array.isArray(result?.resources) ? result.resources : [])
            // 4.5.9 : seul un payload explicitement validé semaine par semaine
            // peut remplacer l'EDT déjà présent dans Supabase. Les anciens caches
            // sans preuve de complétude sont volontairement ignorés.
            .filter(item => item?.verified === true)
            .filter(item => !item?.partial)
            .filter(item => Number(item?.requestedWeekCount || 0) > 0)
            .filter(item => Number(item?.successfulWeekCount || 0) === Number(item?.requestedWeekCount || 0))
            .filter(item => Number(item?.weekCount || item?.payload?.weekCount || 0) === Number(item?.requestedWeekCount || 0))
            .filter(item => requested == null || requested.has(Number(item.resourceId)));
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

    async function syncCollectorResources(targetOverride = null, options = {}) {
        if (!state.isAdmin || state.busy) return;
        const targets = Array.isArray(targetOverride) && targetOverride.length
            ? targetOverride
            : state.collectorRows.filter(isCollectorTarget);
        if (!targets.length) return;
        const failureKinds = Array.isArray(options.failureKinds) && options.failureKinds.length
            ? options.failureKinds
            : [...new Set(targets.map(target => collectorItemKind(target)))];

        const status = byId('planning-collector-status');
        setLoading(true, 'Synchronisation en cours…', `${targets.length} emploi${targets.length > 1 ? 's' : ''} du temps à récupérer.`);
        if (status) status.textContent = `Synchronisation 0/${targets.length}…`;
        setCollectorProgress({
            current: 0,
            total: targets.length,
            percent: 0,
            label: options.progressLabel || 'Synchronisation ADE',
            detail: `0 / ${targets.length} EDT`
        });

        let successCount = 0;
        const successfulResourceIds = [];
        const failures = [];
        let authRequired = false;

        try {
            // Une seule ressource ADE est traitée à la fois. Depuis la 4.7.4, l'extension capture directement la réponse native et retente seulement les semaines ratées
            // method10getTimetable produite par ADE pour chaque semaine. Il n'y a
            // plus de replay réseau ni d'attente DOM sur le chemin normal.
            const chunkSize = 6;
            const weekConcurrency = 1;
            for (let start = 0; start < targets.length; start += chunkSize) {
                const chunk = targets.slice(start, start + chunkSize);
                if (status) {
                    status.textContent = `Synchronisation ${start}/${targets.length}…`;
                }

                let batch;
                try {
                    batch = await requestExtension('PLANILIM_COLLECTOR_SYNC_FAST_SEQUENTIAL', {
                        timeout: 8 * 60 * 1000,
                        payload: {
                            targets: chunk,
                            weekConcurrency
                        }
                    });
                } catch (error) {
                    for (const target of chunk) {
                        failures.push({
                            target,
                            code: error?.code || error?.message || 'FAST_BATCH_EXCEPTION'
                        });
                    }
                    continue;
                }

                if (batch?.code === 'AUTH_REQUIRED') authRequired = true;
                const batchResults = Array.isArray(batch?.results) ? batch.results : [];
                const byResourceId = new Map(batchResults.map(item => [Number(item.resourceId), item]));
                const publishIds = [];

                for (const target of chunk) {
                    const result = byResourceId.get(Number(target.resourceId));
                    if (!result) {
                        failures.push({ target, code: 'SYNC_RESULT_MISSING' });
                        continue;
                    }

                    if (result.ok && (Number(result.eventCount || 0) > 0 || Number(result.weekCount || 0) > 0)) {
                        publishIds.push(target.resourceId);
                    }

                    if (result.ok) {
                        successCount += 1;
                        successfulResourceIds.push(target.resourceId);
                    } else {
                        failures.push({
                            target,
                            code: result.code || 'SYNC_FAILED',
                            message: result.message || (result.failedWeekCount
                                ? `${result.failedWeekCount} semaine(s) incomplète(s)`
                                : null)
                        });
                    }
                }

                try {
                    if (publishIds.length) await publishCollectorPayloads(publishIds);
                } catch (publishError) {
                    console.warn('Publication du lot impossible :', publishError);
                    for (const target of chunk.filter(item => publishIds.includes(item.resourceId))) {
                        if (!failures.some(item => Number(item.target?.resourceId) === Number(target.resourceId))) {
                            failures.push({ target, code: 'PUBLISH_FAILED' });
                        }
                    }
                }

                const done = Math.min(start + chunk.length, targets.length);
                if (status) {
                    status.textContent = `Synchronisation ${done}/${targets.length}…`;
                }
                setCollectorProgress({
                    current: done,
                    total: targets.length,
                    label: options.progressLabel || 'Synchronisation ADE',
                    detail: `${done} / ${targets.length} EDT`
                });

                // Les erreurs sont persistées au fur et à mesure. Si le PC est
                // fermé pendant une longue collecte, un autre poste peut donc
                // déjà reprendre les EDT qui ont réellement échoué.
                const interimUniqueFailures = new Map();
                for (const item of failures) {
                    const key = item.target?.resourceId != null
                        ? `resource:${Number(item.target.resourceId)}`
                        : `${item.target?.path || ''}:${item.target?.label || ''}`;
                    interimUniqueFailures.set(key, item);
                }
                const interimRows = [...interimUniqueFailures.values()].map(item => ({
                    resourceId: item.target?.resourceId ?? null,
                    label: item.target?.label || null,
                    path: item.target?.path || null,
                    level: item.target?.level ?? null,
                    branchToggle: item.target?.branchToggle ?? false,
                    expanded: item.target?.expanded ?? null,
                    code: item.code,
                    message: item.message || null
                }));
                replaceCollectorFailuresForKinds(failureKinds, interimRows);
                await persistCollectorFailureRows(interimRows, successfulResourceIds);

                if (authRequired) break;
            }

            try { await publishCollectorPayloads(); } catch (error) {
                console.warn('Publication globale de rattrapage impossible :', error);
            }

            await loadSharedResources();
            useSelectedSharedPayload();
            if (status) {
                if (authRequired) {
                    status.textContent = `${successCount} emploi${successCount > 1 ? 's' : ''} du temps terminé${successCount > 1 ? 's' : ''}. Une reconnexion ADE est nécessaire avant la relance.`;
                } else if (!failures.length) {
                    status.textContent = `${successCount} emploi${successCount > 1 ? 's' : ''} du temps synchronisé${successCount > 1 ? 's' : ''}. ADE peut être fermé.`;
                } else {
                    status.textContent = `${successCount} sur ${targets.length} emplois du temps terminés. ${failures.length} restent à relancer.`;
                }
            }

            const uniqueFailures = new Map();
            for (const item of failures) {
                const key = item.target?.resourceId != null
                    ? `resource:${Number(item.target.resourceId)}`
                    : `${item.target?.path || ''}:${item.target?.label || ''}`;
                uniqueFailures.set(key, item);
            }
            const failureRows = [...uniqueFailures.values()].map(item => ({
                resourceId: item.target?.resourceId ?? null,
                label: item.target?.label || null,
                path: item.target?.path || null,
                level: item.target?.level ?? null,
                branchToggle: item.target?.branchToggle ?? false,
                expanded: item.target?.expanded ?? null,
                code: item.code,
                message: item.message || null
            }));
            replaceCollectorFailuresForKinds(failureKinds, failureRows);
            await persistCollectorFailureRows(failureRows, successfulResourceIds);

            return {
                ok: !authRequired && failureRows.length === 0,
                authRequired,
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

    function configureCollectorPlatformUi() {
        const panel = byId('planning-collector-panel');
        const launcher = byId('planning-collector-mobile-launch');
        if (!panel) return;
        const mobile = isMobileDevice();
        panel.classList.toggle('is-mobile-launcher', mobile);
        if (launcher) launcher.hidden = !mobile;
    }

    function setCollectorProgress({ current = 0, total = 0, percent = null, label = 'Synchronisation ADE', detail = '' } = {}) {
        if (isMobileDevice()) return;
        const box = byId('planning-collector-progress');
        const fill = byId('planning-collector-progress-fill');
        const percentNode = byId('planning-collector-progress-percent');
        const labelNode = byId('planning-collector-progress-label');
        const detailNode = byId('planning-collector-progress-detail');
        const track = byId('planning-collector-progress-track');
        if (!box || !fill || !percentNode || !track) return;

        const numericTotal = Math.max(0, Number(total || 0));
        const numericCurrent = Math.max(0, Number(current || 0));
        const computed = Number.isFinite(Number(percent))
            ? Number(percent)
            : (numericTotal > 0 ? (numericCurrent / numericTotal) * 100 : 0);
        const safePercent = Math.max(0, Math.min(100, Math.round(computed)));

        box.hidden = false;
        fill.style.width = `${safePercent}%`;
        percentNode.textContent = `${safePercent} %`;
        if (labelNode) labelNode.textContent = label || 'Synchronisation ADE';
        if (detailNode) detailNode.textContent = detail || (numericTotal > 0 ? `${Math.min(numericCurrent, numericTotal)} / ${numericTotal} EDT` : 'Préparation…');
        track.setAttribute('aria-valuenow', String(safePercent));
        track.setAttribute('aria-valuetext', `${safePercent} %`);
    }

    function openCollectorAndroidApp() {
        const status = byId('planning-collector-status');
        if (!/Android/i.test(navigator.userAgent || '')) {
            if (status) status.textContent = 'L’application de synchronisation ADE est actuellement disponible sur Android.';
            return;
        }
        if (status) status.textContent = 'Ouverture de l’application ADE…';
        window.location.href = ANDROID_APP_DEEP_LINK;
    }

    async function runAdminCollector(kind = 'all') {
        if (!state.isAdmin || state.busy || state.collectorRunning) return;
        if (isMobileDevice()) {
            openCollectorAndroidApp();
            return;
        }
        const status = byId('planning-collector-status');
        const profiles = kind === 'all'
            ? [COLLECTOR_PROFILES.program, COLLECTOR_PROFILES.room]
            : [collectorProfile(kind)];
        state.collectorRunning = true;
        updateCollectorActionButtons();
        setCollectorProgress({
            current: 0,
            total: 0,
            percent: 0,
            label: kind === 'all' ? 'Filières + salles' : `${collectorProfile(kind).label}`,
            detail: 'Préparation de la synchronisation ADE…'
        });

        try {
            if (!state.extensionDetected) {
                await requestStatusAndPayload({ persistIfCloudEmpty: true });
            }
            if (!state.extensionDetected) {
                if (status) status.textContent = 'Le collecteur PC n’est pas détecté. Installation requise avant la synchronisation.';
                launchExtensionInstall();
                return;
            }

            sessionStorage.removeItem('planilim-admin-collector-resume');
            state.collectorRows = [];
            renderCollectorRows();
            await clearCollectorFailuresForKinds(profiles.map(profile => profile.key));

            const results = [];
            for (let index = 0; index < profiles.length; index += 1) {
                const profile = profiles[index];
                if (status && profiles.length > 1) {
                    status.textContent = `${index + 1}/${profiles.length} · ${profile.label} · préparation…`;
                }
                const result = await runCollectorPipeline(profile, {
                    phaseIndex: index,
                    phaseCount: profiles.length
                });
                results.push(result || { ok: false, profile: profile.key });
                if (result?.authRequired || result?.code === 'AUTH_REQUIRED') break;
            }

            await loadSharedResources();
            useSelectedSharedPayload();
            if (status && profiles.length > 1) {
                const totalSuccess = results.reduce((sum, item) => sum + Number(item?.successCount || 0), 0);
                const totalDiscovered = results.reduce((sum, item) => sum + Number(item?.discoveredCount || 0), 0);
                const remaining = profiles.reduce((sum, profile) => sum + collectorFailuresForKind(profile.key).length, 0);
                status.textContent = remaining
                    ? `${totalSuccess} emplois du temps synchronisés sur ${totalDiscovered}. ${remaining} échec${remaining > 1 ? 's' : ''} à relancer.`
                    : `${totalSuccess} emplois du temps synchronisés sur ${totalDiscovered}. ADE peut être fermé.`;
            }
            if (results.length === profiles.length && !results.some(item => item?.authRequired || item?.code === 'AUTH_REQUIRED')) {
                const totalSuccess = results.reduce((sum, item) => sum + Number(item?.successCount || 0), 0);
                const totalDiscovered = results.reduce((sum, item) => sum + Number(item?.discoveredCount || 0), 0);
                setCollectorProgress({
                    current: totalDiscovered,
                    total: totalDiscovered,
                    percent: 100,
                    label: 'Synchronisation terminée',
                    detail: `${totalSuccess} / ${totalDiscovered || totalSuccess} EDT publiés ou traités`
                });
            }
        } finally {
            state.collectorRunning = false;
            updateCollectorActionButtons();
        }
    }

    async function retryFailedCollectorResources(kind = 'all') {
        if (!state.isAdmin || state.busy || state.collectorRunning) return;
        const status = byId('planning-collector-status');
        const failureKinds = kind === 'all' ? ['program', 'room'] : [kind === 'room' ? 'room' : 'program'];
        let remaining = kind === 'all'
            ? [...state.collectorFailures]
            : collectorFailuresForKind(failureKinds[0]);
        if (!remaining.length) return;

        state.collectorRunning = true;
        updateCollectorActionButtons();
        try {
            const passes = [1];
            for (let passIndex = 0; passIndex < passes.length && remaining.length; passIndex += 1) {
                const weekConcurrency = passes[passIndex];
                if (status) {
                    status.textContent = `Rattrapage : ${remaining.length} emploi${remaining.length > 1 ? 's' : ''} du temps à relancer…`;
                }

                const result = await syncCollectorResources(remaining, {
                    weekConcurrency,
                    failureKinds,
                    progressLabel: 'Rattrapage ADE'
                });
                remaining = Array.isArray(result?.failures) ? result.failures : failureKinds.flatMap(current => collectorFailuresForKind(current));
                if (result?.authRequired || !remaining.length) break;
                await new Promise(resolve => window.setTimeout(resolve, 650 + passIndex * 450));
            }

            if (status && remaining.length) {
                status.textContent = `${remaining.length} emploi${remaining.length > 1 ? 's' : ''} du temps restent en échec. Le détail technique est affiché sur les lignes concernées.`;
            } else if (status) {
                status.textContent = 'Rattrapage terminé. ADE peut être fermé.';
            }
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
                        useSelectedSharedPayload();
                    }
                }
            } catch {
                state.extensionDetected = false;
                state.status = null;
                updateConnectionUi();
                renderWeek();
                return null;
            }

            // Une formation choisie dans le catalogue partagé est la source de vérité
            // de l'affichage. Le GET_PAYLOAD de l'extension correspond, lui, à la
            // ressource ADE actuellement sélectionnée par le collecteur administrateur
            // et change donc plusieurs fois pendant une collecte. L'utiliser ici faisait
            // sauter l'emploi du temps toutes les 12 s ou au retour de focus.
            const selectedShared = state.sharedResources.find(resource =>
                String(resource.resource_id) === String(state.selectedResourceId)
            );
            const selectedSharedPayload = selectedShared?.payload?.events && Array.isArray(selectedShared.payload.events)
                ? selectedShared.payload
                : null;
            const sharedSelectionExpected = Boolean(
                state.selectedResourceId || state.sharedResources.length || state.collectorRunning
            );

            if (selectedSharedPayload) {
                if (resourceKind(selectedShared) === 'program') saveLocalPayload(selectedSharedPayload);
                else useTransientPayload(selectedSharedPayload);
                state.cloudAvailable = true;
                state.cloudLoaded = true;
            } else if (!sharedSelectionExpected) {
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
        return state.viewMode;
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

        const key = eventOccurrenceKey(event);
        const overlapClass = laneCount > 1 ? 'is-overlap' : '';
        return `
            <article class="planning-event planning-event-${kind} ${overlapClass} ${excluded ? 'is-individually-excluded' : ''}"
                style="grid-column:${dayIndex + 2};grid-row:${startRow}/${endRow};--lane-width:${laneWidth}%;--lane-left:${laneLeft}%;"
                data-planning-open-event="${escapePlanning(key)}" role="button" tabindex="0"
                aria-label="Ouvrir ${escapePlanning(event.title || 'ce cours')}" title="${escapePlanning(tooltip)}">
                <div class="planning-event-topline">
                    <span class="planning-event-time">${escapePlanning(event.start || '—')}–${escapePlanning(event.end || '—')}</span>
                    <span class="planning-event-actions"><span class="planning-event-type">${escapePlanning(typeLabel(event))}</span></span>
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
        const key = eventOccurrenceKey(event);
        const overlapClass = laneCount > 1 ? 'is-overlap' : '';
        return `
            <article class="planning-day-event planning-event-${kind} ${sizeClass} ${overlapClass} ${excluded ? 'is-individually-excluded' : ''}"
                style="grid-column:2;grid-row:${startSlot + 1}/${endSlot + 1};--lane-width:${laneWidth}%;--lane-left:${laneLeft}%;"
                data-planning-open-event="${escapePlanning(key)}" role="button" tabindex="0" aria-label="Ouvrir ${escapePlanning(event.title || 'ce cours')}">
                <div class="planning-day-event-topline">
                    <span class="planning-day-event-time">${escapePlanning(event.start || '—')}–${escapePlanning(event.end || '—')}</span>
                    <span class="planning-event-actions"><span class="planning-day-event-type">${escapePlanning(typeLabel(event))}</span></span>
                </div>
                <strong class="planning-day-event-title">${escapePlanning(event.title || 'Cours')}</strong>
                <div class="planning-day-event-meta">
                    ${event.teacher ? `<span><i class="fa-solid fa-user"></i>${escapePlanning(event.teacher)}</span>` : ''}
                    ${roomLine ? `<span><i class="fa-solid fa-location-dot"></i>${escapePlanning(roomLine)}</span>` : ''}
                </div>
            </article>`;
    }

    function findPlanningEventByKey(key) {
        return (state.payload?.events || []).find(event => eventOccurrenceKey(event) === key) || null;
    }

    function closePlanningEventModal() {
        const modal = byId('planning-event-modal');
        if (!modal) return;
        modal.hidden = true;
        document.body.classList.remove('planning-modal-open');
    }

    function openPlanningEventModal(key) {
        const modal = byId('planning-event-modal');
        const card = byId('planning-event-modal-card');
        const event = findPlanningEventByKey(key);
        if (!modal || !card || !event) return;

        // Le planning vit dans plusieurs conteneurs scrollables/transformés. Un élément
        // position:fixed laissé dans l'un de ces conteneurs peut alors être centré sur
        // l'EDT au lieu du viewport. La modale est donc portée directement par <body>.
        if (modal.parentElement !== document.body) document.body.appendChild(modal);
        const kind = courseKind(event);
        const roomLine = [event.room, event.building].filter(Boolean).join(' · ');
        const excluded = eventIsIndividuallyExcluded(event);
        const dateLabel = new Date(`${event.date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        card.className = `planning-event-modal-card planning-event-${kind}`;
        card.innerHTML = `
            <button class="planning-event-modal-close" type="button" aria-label="Fermer"><i class="fa-solid fa-xmark"></i></button>
            <div class="planning-event-modal-summary">
                <div class="planning-event-modal-top"><span class="planning-event-modal-type">${escapePlanning(typeLabel(event))}</span><span class="planning-event-modal-date">${escapePlanning(dateLabel)}</span></div>
                <h2>${escapePlanning(event.title || 'Cours')}</h2>
                <div class="planning-event-modal-time"><i class="fa-regular fa-clock"></i>${escapePlanning(event.start || '—')} – ${escapePlanning(event.end || '—')}</div>
            </div>
            <div class="planning-event-modal-details">
                ${event.group ? `<div><i class="fa-solid fa-users"></i><span>${escapePlanning(event.group)}</span></div>` : ''}
                ${event.teacher ? `<div><i class="fa-solid fa-user"></i><span>${escapePlanning(event.teacher)}</span></div>` : ''}
                ${roomLine ? `<div><i class="fa-solid fa-location-dot"></i><span>${escapePlanning(roomLine)}</span></div>` : ''}
            </div>
            <label class="planning-event-modal-visibility">
                <input type="checkbox" data-planning-modal-event-key="${escapePlanning(key)}" ${excluded ? '' : 'checked'}>
                <span class="planning-checkbox-ui" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
                <span><strong>Afficher ce créneau</strong><small>${excluded ? 'Ce cours est actuellement masqué.' : 'Décochez pour masquer uniquement ce cours.'}</small></span>
            </label>`;
        modal.hidden = false;
        document.body.classList.add('planning-modal-open');
    }

    function renderDayTimeline(firstDate) {
        const tabs = byId('planning-mobile-day-tabs');
        const agenda = byId('planning-mobile-agenda');
        const label = byId('planning-mobile-selected-label');
        if (!tabs || !agenda) return;

        ensureMobileSelectedDate(firstDate);
        if (effectiveViewMode() === 'day' && state.mobileSelectedDate) {
            const toolbarLabel = byId('planning-week-label');
            const toolbarRange = byId('planning-week-range');
            const selectedDate = new Date(`${state.mobileSelectedDate}T12:00:00`);
            if (toolbarLabel) toolbarLabel.textContent = selectedDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
            if (toolbarRange) toolbarRange.textContent = `Semaine ${isoWeekNumber(firstDate) || ''}`.trim();
        }
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
        if (navItem) navItem.hidden = false;

        if (!state.user) {
            closeUniversityEmailModal();
            state.isAdmin = false;
            state.adeVerified = false;
            state.sharedResources = [];
            state.selectedResourceId = null;
            state.selectedProgramResourceId = null;
            state.selectedRoomResourceId = null;
            state.resourceMode = 'program';
            state.resourceModeTouched = false;
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
            publishUniversityAccessState();
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

    function isMobilePlanningSelectUi() {
        return window.matchMedia('(max-width: 760px) and (pointer: coarse)').matches;
    }

    function ensureMobilePlanningSelectSheet() {
        let sheet = byId('planning-mobile-select-sheet');
        if (sheet) return sheet;
        sheet = document.createElement('div');
        sheet.id = 'planning-mobile-select-sheet';
        sheet.className = 'planning-mobile-select-sheet';
        sheet.hidden = true;
        sheet.innerHTML = `
            <button class="planning-mobile-select-backdrop" type="button" aria-label="Fermer"></button>
            <section class="planning-mobile-select-panel" role="dialog" aria-modal="true" aria-labelledby="planning-mobile-select-title">
                <div class="planning-mobile-select-header">
                    <strong id="planning-mobile-select-title">Choisir</strong>
                    <button class="planning-mobile-select-close" type="button" aria-label="Fermer"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="planning-mobile-select-options" role="listbox"></div>
            </section>`;
        document.body.appendChild(sheet);
        const close = () => {
            sheet.hidden = true;
            document.body.classList.remove('planning-mobile-select-open');
            sheet.dataset.selectId = '';
        };
        sheet.querySelector('.planning-mobile-select-backdrop')?.addEventListener('click', close);
        sheet.querySelector('.planning-mobile-select-close')?.addEventListener('click', close);
        sheet._closePlanningSelect = close;
        return sheet;
    }

    function openMobilePlanningSelect(select) {
        if (!select || select.disabled || !isMobilePlanningSelectUi()) return false;
        const sheet = ensureMobilePlanningSelectSheet();
        const title = sheet.querySelector('#planning-mobile-select-title');
        const optionsHost = sheet.querySelector('.planning-mobile-select-options');
        const fieldLabel = select.closest('.planning-resource-field')?.querySelector(':scope > span')?.textContent?.trim();
        if (title) title.textContent = fieldLabel || 'Choisir';
        if (!optionsHost) return false;

        optionsHost.innerHTML = '';
        Array.from(select.options).forEach(option => {
            if (option.disabled || !option.value) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'planning-mobile-select-option';
            button.setAttribute('role', 'option');
            const selected = option.value === select.value;
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            if (selected) button.classList.add('is-selected');
            button.innerHTML = `<span>${escapePlanning(option.textContent || option.label || option.value)}</span>${selected ? '<i class="fa-solid fa-check"></i>' : ''}`;
            button.addEventListener('click', () => {
                if (select.value !== option.value) {
                    select.value = option.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                sheet._closePlanningSelect?.();
                select.focus({ preventScroll: true });
            });
            optionsHost.appendChild(button);
        });

        if (!optionsHost.children.length) return false;
        sheet.dataset.selectId = select.id || '';
        sheet.hidden = false;
        document.body.classList.add('planning-mobile-select-open');
        requestAnimationFrame(() => {
            optionsHost.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
        });
        return true;
    }

    function bindMobilePlanningSelects() {
        const selectors = [
            'planning-resource-year',
            'planning-resource-speciality',
            'planning-resource-semester',
            'planning-resource-group',
            'planning-resource-building',
            'planning-resource-room'
        ];
        selectors.forEach(id => {
            const select = byId(id);
            if (!select || select.dataset.mobileSelectBound === '1') return;
            select.dataset.mobileSelectBound = '1';
            const interceptMobileSelect = event => {
                if (!isMobilePlanningSelectUi() || select.disabled) return;
                event.preventDefault();
                event.stopPropagation();
                const now = Date.now();
                const lastOpen = Number(select.dataset.mobileSelectOpenedAt || 0);
                if (now - lastOpen < 300) return;
                select.dataset.mobileSelectOpenedAt = String(now);
                openMobilePlanningSelect(select);
            };
            select.addEventListener('pointerdown', interceptMobileSelect, { passive: false });
            select.addEventListener('touchstart', interceptMobileSelect, { passive: false });
        });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            const sheet = byId('planning-mobile-select-sheet');
            if (sheet && !sheet.hidden) sheet._closePlanningSelect?.();
        });
    }

    function bindControls() {
        bindMobilePlanningSelects();
        byId('planning-verify-ade')?.addEventListener('click', beginAdeVerification);
        byId('university-email-close')?.addEventListener('click', closeUniversityEmailModal);
        byId('universityEmailModal')?.addEventListener('click', event => {
            if (event.target === byId('universityEmailModal')) closeUniversityEmailModal();
        });
        byId('university-email-send')?.addEventListener('click', () => sendUniversityVerificationCode());
        byId('university-code-verify')?.addEventListener('click', verifyUniversityEmailCode);
        byId('university-code-resend')?.addEventListener('click', () => sendUniversityVerificationCode({ resend: true }));
        byId('university-code-change')?.addEventListener('click', showUniversityAddressStep);
        byId('university-code-input')?.addEventListener('input', event => {
            event.target.value = String(event.target.value || '').replace(/\D/g, '').slice(0, 6);
        });
        byId('university-code-input')?.addEventListener('keydown', event => {
            if (event.key === 'Enter') verifyUniversityEmailCode();
        });
        byId('university-email-input')?.addEventListener('keydown', event => {
            if (event.key === 'Enter') sendUniversityVerificationCode();
        });
        document.querySelectorAll('[data-planning-resource-mode]').forEach(button => {
            button.addEventListener('click', () => {
                activateResourceMode(button.dataset.planningResourceMode === 'room' ? 'room' : 'program');
            });
        });
        byId('planning-resource-building')?.addEventListener('change', event => {
            event.target.dataset.touched = '1';
            const room = byId('planning-resource-room');
            if (room) {
                room.value = '';
                room.dataset.touched = '1';
            }
            clearCurrentRoomSelection();
            renderResourceChooser();
        });
        byId('planning-resource-room')?.addEventListener('change', event => {
            const resourceId = event.target.value || '';
            event.target.dataset.touched = '1';
            if (!resourceId) {
                clearCurrentRoomSelection();
                renderResourceChooser();
                return;
            }
            activateTemporaryRoom(resourceId);
            ensureCurrentWeek();
            renderWeek();
            updateConnectionUi();
        });
        byId('planning-resource-year')?.addEventListener('change', event => {
            resetHierarchyAfter(event.target, ['planning-resource-speciality', 'planning-resource-semester', 'planning-resource-group']);
            clearCurrentProgramSelection();
            renderResourceChooser();
        });
        byId('planning-resource-speciality')?.addEventListener('change', event => {
            resetHierarchyAfter(event.target, ['planning-resource-semester', 'planning-resource-group']);
            clearCurrentProgramSelection();
            renderResourceChooser();
        });
        byId('planning-resource-semester')?.addEventListener('change', async event => {
            resetHierarchyAfter(event.target, ['planning-resource-group']);
            clearCurrentProgramSelection();
            renderResourceChooser();
            if (await chooseHierarchyResource()) {
                ensureCurrentWeek();
                renderWeek();
                updateConnectionUi();
            }
        });
        byId('planning-resource-group')?.addEventListener('change', async event => {
            const resourceId = event.target.value || '';
            event.target.dataset.touched = '1';
            if (!resourceId) {
                clearCurrentProgramSelection();
                renderResourceChooser();
                return;
            }
            event.target.disabled = true;
            await savePlanningPreference(resourceId);
            event.target.disabled = false;
            ensureCurrentWeek();
            renderWeek();
            updateConnectionUi();
        });
        byId('planning-open-android-app')?.addEventListener('click', openCollectorAndroidApp);
        configureCollectorPlatformUi();
        document.querySelectorAll('[data-collector-sync]').forEach(button => {
            button.addEventListener('click', () => runAdminCollector(button.dataset.collectorSync || 'all'));
        });
        document.querySelectorAll('[data-collector-retry]').forEach(button => {
            button.addEventListener('click', () => retryFailedCollectorResources(button.dataset.collectorRetry || 'all'));
        });
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

        byId('planning')?.addEventListener('click', event => {
            const card = event.target.closest('[data-planning-open-event]');
            if (!card) return;
            openPlanningEventModal(card.dataset.planningOpenEvent || '');
        });
        byId('planning')?.addEventListener('keydown', event => {
            if (!['Enter', ' '].includes(event.key)) return;
            const card = event.target.closest('[data-planning-open-event]');
            if (!card) return;
            event.preventDefault();
            openPlanningEventModal(card.dataset.planningOpenEvent || '');
        });
        byId('planning-event-modal')?.addEventListener('click', event => {
            if (event.target === byId('planning-event-modal') || event.target.classList.contains('planning-event-modal-backdrop') || event.target.closest('.planning-event-modal-close')) closePlanningEventModal();
        });
        byId('planning-event-modal')?.addEventListener('change', event => {
            const input = event.target.closest('input[data-planning-modal-event-key]');
            if (!input) return;
            const key = input.dataset.planningModalEventKey || '';
            if (input.checked) state.filters.excludedEvents.delete(key);
            else state.filters.excludedEvents.add(key);
            savePlanningFilters();
            renderPlanningFilters();
            renderWeek();
            const hint = input.closest('.planning-event-modal-visibility')?.querySelector('small');
            if (hint) hint.textContent = input.checked
                ? 'Décochez pour masquer uniquement ce cours.'
                : 'Ce cours est actuellement masqué.';
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !byId('planning-event-modal')?.hidden) closePlanningEventModal();
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
        if (isCompactPlanning()) state.viewMode = 'day';
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
        verifyUniversity: beginAdeVerification,
        getUniversityAccess: () => ({ user: state.user, verified: state.adeVerified, admin: state.isAdmin, granted: Boolean(state.user && (state.adeVerified || state.isAdmin)) }),
        onAccountChanged
    };
})();
