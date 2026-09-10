'use strict';

document.documentElement.classList.add('js');

/* ==========================================================
   CONFIGURATION GÉNÉRALE
========================================================== */
const VALID_SECTIONS = ['about', 'services', 'projects', 'courses', 'forum', 'library', 'notifications'];
const navButtons = [...document.querySelectorAll('.nav-btn')];
const pageSections = [...document.querySelectorAll('.page-section')];
const mobileMenu = document.getElementById('nav-menu');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');

let activeProjectCategory = 'all';
let projectSearchTerm = '';
let currentProjectPageTab = 'catalog';
let currentSubjectIndex = 0;
let currentSubjectTab = 'lessons';
let currentExerciseTab = 'exercise_statements';
let toastTimer = null;
let revealObserver = null;
let animationFrameId = null;
let motionReduced = false;

/* ==========================================================
   SUPABASE — CONTENU DYNAMIQUE + ADMINISTRATION
   IMPORTANT : la clé "publishable" est publique par nature.
   Ne mettez JAMAIS une clé service_role dans ce fichier.
========================================================== */
const SUPABASE_CONFIG = {
    url: 'https://aoyisuxgvcleocgetfnq.supabase.co',
    publishableKey: 'sb_publishable_GtX79VZzTcrYY4DFazOGpg_C6D7cu68',
    adminEmail: 'leween87220@gmail.com'
};

const STORAGE_BUCKETS = {
    documents: 'course-files',
    assets: 'site-assets'
};

const LEGACY_PROFILE_IMAGE_URL = 'image/pdp.png';
const SUPABASE_PUBLIC_STORAGE_MARKER = '/storage/v1/object/public/';

function isSupabaseStorageUrl(value) {
    try {
        const url = new URL(String(value || ''), window.location.href);
        const supabaseHost = new URL(SUPABASE_CONFIG.url).host;
        return url.host === supabaseHost && url.pathname.includes(SUPABASE_PUBLIC_STORAGE_MARKER);
    } catch { return false; }
}

function isRepositoryHostedAsset(value) {
    const raw = String(value || '').trim();
    if (!raw || /^(data:|blob:)/i.test(raw) || isSupabaseStorageUrl(raw)) return false;
    if (!/^https?:\/\//i.test(raw)) return true;
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        return url.origin === window.location.origin
            || host.endsWith('.github.io')
            || host === 'raw.githubusercontent.com'
            || host === 'github.com';
    } catch { return false; }
}

function applyPortfolioProfileImage() {
    const url = String(portfolioSettings.profileImageUrl || '').trim();
    document.querySelectorAll('[data-portfolio-profile-image]').forEach(img => {
        if (url) img.src = url;
    });
    const preview = document.getElementById('admin-profile-image-preview');
    if (preview && url) preview.src = url;
}

let supabaseClient = null;
let adminAuthenticated = false;
let adminAccessMode = 'none'; // none | moderator | admin
let adminInfoFilter = 'all';
let adminCache = { subjects: [], documents: [], infos: [], projects: [] };
let adminBusy = false;

/* ==========================================================
   BIBLIOTHÈQUE PERSONNELLE / PWA / HORS CONNEXION
========================================================== */
const SITE_FAVORITE_TYPES = new Set(['document', 'topic', 'info']);
const OFFLINE_DOCUMENT_CACHE = 'tremble-offline-documents-v1';
let siteFavoriteRows = [];
let siteFavoriteKeys = new Set();
let siteFavoriteResolved = new Map();
let personalLibraryTab = 'favorites';
let personalLibraryFilter = 'all';
let personalLibrarySearch = '';
let deferredPwaInstallPrompt = null;
let pwaInstallNoticeTimer = null;
const PWA_INSTALL_NOTICE_DISMISS_KEY = 'portfolio-pwa-install-notice-dismissed-at';
const PWA_INSTALL_NOTICE_COOLDOWN = 7 * 24 * 60 * 60 * 1000;
let lastRemoteContentLoadAt = 0;


/* ==========================================================
   ÉTAT DU CONTENU PUBLIC
   Supabase est désormais l’unique source de vérité.
   Les tableaux ci-dessous sont uniquement l’état en mémoire
   utilisé par l’interface après chargement de la base.
========================================================== */
let myProjects = [];
let generalInfo = [];
let myCourses = [];
let globalResources = [];
let publicContentLoadError = null;
let portfolioSettings = { servicesAvailable: true, servicesStatusText: 'Services disponibles actuellement', profileImageUrl: '', profileImageStoragePath: '' };

const categoryLabels = {
    application: 'Application',
    tool: 'Outil',
    game: 'Jeu'
};

/* ==========================================================
   OUTILS
========================================================== */
function escapeHtmlAttribute(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function safeExternalLink(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

function safeResourceUrl(url) {
    if (typeof url !== 'string') return false;
    const value = url.trim();
    if (!value) return false;
    if (/^https?:\/\//i.test(value)) return true;
    return !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//');
}

const projectStatusLabels = {
    available: 'Disponible',
    development: 'En développement',
    prototype: 'Prototype',
    archived: 'Archivé'
};

const projectStatusDescriptions = {
    available: 'Une version est disponible au téléchargement.',
    development: 'Projet actuellement en cours de développement.',
    prototype: 'Version expérimentale ou démonstration.',
    archived: 'Projet conservé à titre d’archive.'
};

function projectStatus(project) {
    if (project && project.status && projectStatusLabels[project.status]) return project.status;
    return safeExternalLink(project?.appUrl) ? 'available' : 'development';
}

function setBodyModalState() {
    const modalOpen = document.querySelector('.modal-overlay.active');
    document.body.classList.toggle('modal-open', Boolean(modalOpen));
}

/* ==========================================================
   MODALES — FERMETURE UNIQUEMENT SUR UN VRAI CLIC DU FOND
   Un glisser-sélection commencé dans la fenêtre puis relâché
   sur l'overlay ne doit jamais fermer la modale.
========================================================== */
const modalBackdropPointerStarts = new WeakMap();

document.addEventListener('pointerdown', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const overlay = target.closest('.modal-overlay');
    if (!overlay) return;
    modalBackdropPointerStarts.set(overlay, target === overlay);
}, true);

document.addEventListener('pointercancel', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const overlay = target.closest('.modal-overlay');
    if (overlay) modalBackdropPointerStarts.delete(overlay);
}, true);

function isRealModalBackdropClick(event) {
    if (!event) return true;
    const overlay = event.currentTarget;
    if (!(overlay instanceof Element) || !overlay.classList.contains('modal-overlay')) return false;

    const startedOnBackdrop = modalBackdropPointerStarts.get(overlay) === true;
    modalBackdropPointerStarts.delete(overlay);

    return startedOnBackdrop && event.target === overlay;
}

window.isRealModalBackdropClick = isRealModalBackdropClick;

/* ==========================================================
   CONFIRMATION THÉMATIQUE GLOBALE
========================================================== */
let siteConfirmResolver = null;

function closeSiteConfirm(result = false) {
    const modal = document.getElementById('siteConfirmModal');
    if (modal) modal.classList.remove('active');
    setBodyModalState();
    const resolver = siteConfirmResolver;
    siteConfirmResolver = null;
    if (resolver) resolver(Boolean(result));
}

function siteConfirm(options = {}) {
    const modal = document.getElementById('siteConfirmModal');
    if (!modal) return Promise.resolve(window.confirm(typeof options === 'string' ? options : (options.message || 'Confirmer cette action ?')));

    if (typeof options === 'string') options = { message: options };
    if (siteConfirmResolver) closeSiteConfirm(false);

    const title = options.title || 'Confirmer cette action';
    const message = options.message || 'Voulez-vous continuer ?';
    const detail = options.detail || '';
    const confirmLabel = options.confirmLabel || 'Confirmer';
    const cancelLabel = options.cancelLabel || 'Annuler';
    const danger = Boolean(options.danger);
    const icon = options.icon || (danger ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-circle-question');

    const titleEl = document.getElementById('site-confirm-title');
    const messageEl = document.getElementById('site-confirm-message');
    const detailEl = document.getElementById('site-confirm-detail');
    const iconEl = document.getElementById('site-confirm-icon');
    const acceptBtn = document.getElementById('site-confirm-accept');
    const cancelBtn = document.getElementById('site-confirm-cancel');

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (detailEl) { detailEl.textContent = detail; detailEl.hidden = !detail; }
    if (iconEl) iconEl.className = icon;
    if (acceptBtn) {
        acceptBtn.innerHTML = `<i class="${danger ? 'fa-solid fa-trash-can' : 'fa-solid fa-check'}"></i> ${escapeHtmlAttribute(confirmLabel)}`;
        acceptBtn.classList.toggle('danger-confirm-btn', danger);
    }
    if (cancelBtn) cancelBtn.textContent = cancelLabel;
    modal.classList.toggle('danger', danger);
    modal.classList.add('active');
    setBodyModalState();

    return new Promise(resolve => {
        siteConfirmResolver = resolve;
        requestAnimationFrame(() => acceptBtn?.focus());
    });
}

window.siteConfirm = siteConfirm;
window.closeSiteConfirm = closeSiteConfirm;

document.getElementById('site-confirm-accept')?.addEventListener('click', () => closeSiteConfirm(true));
document.getElementById('site-confirm-cancel')?.addEventListener('click', () => closeSiteConfirm(false));
document.getElementById('site-confirm-close')?.addEventListener('click', () => closeSiteConfirm(false));
document.getElementById('siteConfirmModal')?.addEventListener('click', event => {
    if (isRealModalBackdropClick(event)) closeSiteConfirm(false);
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('siteConfirmModal')?.classList.contains('active')) closeSiteConfirm(false);
});

/* ==========================================================
   TOOLTIPS — ACCESSIBLES, DYNAMIQUES ET ADAPTATIFS
========================================================== */
const tooltipElement = document.getElementById('site-tooltip');
let tooltipTarget = null;
let tooltipShowTimer = null;
let tooltipHideTimer = null;

function getTooltipTarget(node) {
    return node instanceof Element ? node.closest('[data-tooltip]') : null;
}

function positionTooltip(target) {
    if (!tooltipElement || !target || tooltipElement.hidden) return;
    const rect = target.getBoundingClientRect();
    const tipRect = tooltipElement.getBoundingClientRect();
    const margin = 10;
    const viewportPadding = 10;

    let placement = target.dataset.tooltipPlacement || 'top';
    let top = rect.top - tipRect.height - margin;
    let left = rect.left + (rect.width - tipRect.width) / 2;

    if (placement === 'bottom' || top < viewportPadding) {
        placement = 'bottom';
        top = rect.bottom + margin;
    }
    if (top + tipRect.height > window.innerHeight - viewportPadding) {
        placement = 'top';
        top = Math.max(viewportPadding, rect.top - tipRect.height - margin);
    }

    left = Math.min(
        Math.max(viewportPadding, left),
        Math.max(viewportPadding, window.innerWidth - tipRect.width - viewportPadding)
    );

    tooltipElement.dataset.placement = placement;
    tooltipElement.style.left = `${Math.round(left)}px`;
    tooltipElement.style.top = `${Math.round(top)}px`;

    const targetCenter = rect.left + rect.width / 2;
    const arrowLeft = Math.min(Math.max(14, targetCenter - left), tipRect.width - 14);
    tooltipElement.style.setProperty('--tooltip-arrow-left', `${Math.round(arrowLeft)}px`);
}

function showTooltip(target, { immediate = false } = {}) {
    if (!tooltipElement || !target) return;
    const text = (target.dataset.tooltip || '').trim();
    if (!text) return;

    window.clearTimeout(tooltipHideTimer);
    window.clearTimeout(tooltipShowTimer);
    tooltipTarget = target;

    const display = () => {
        if (tooltipTarget !== target || !document.documentElement.contains(target)) return;
        tooltipElement.textContent = text;
        tooltipElement.hidden = false;
        tooltipElement.classList.remove('visible');
        positionTooltip(target);
        window.requestAnimationFrame(() => tooltipElement.classList.add('visible'));
        target.setAttribute('aria-describedby', 'site-tooltip');
    };

    if (immediate) display();
    else tooltipShowTimer = window.setTimeout(display, 180);
}

function hideTooltip(target = tooltipTarget, { immediate = false } = {}) {
    if (!tooltipElement) return;
    window.clearTimeout(tooltipShowTimer);
    window.clearTimeout(tooltipHideTimer);

    const hide = () => {
        if (target) target.removeAttribute('aria-describedby');
        tooltipElement.classList.remove('visible');
        window.setTimeout(() => {
            if (!tooltipElement.classList.contains('visible')) tooltipElement.hidden = true;
        }, motionReduced ? 0 : 120);
        if (tooltipTarget === target) tooltipTarget = null;
    };

    if (immediate) hide();
    else tooltipHideTimer = window.setTimeout(hide, 60);
}

document.addEventListener('mouseover', event => {
    const target = getTooltipTarget(event.target);
    if (!target || target === tooltipTarget) return;
    showTooltip(target);
});

document.addEventListener('mouseout', event => {
    const target = getTooltipTarget(event.target);
    if (!target) return;
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
    hideTooltip(target);
});

document.addEventListener('focusin', event => {
    const target = getTooltipTarget(event.target);
    if (target) showTooltip(target, { immediate: true });
});

document.addEventListener('focusout', event => {
    const target = getTooltipTarget(event.target);
    if (target) hideTooltip(target, { immediate: true });
});

document.addEventListener('pointerdown', () => hideTooltip(tooltipTarget, { immediate: true }), true);
window.addEventListener('scroll', () => hideTooltip(tooltipTarget, { immediate: true }), { passive: true });
window.addEventListener('resize', () => {
    if (tooltipTarget && tooltipElement && !tooltipElement.hidden) positionTooltip(tooltipTarget);
}, { passive: true });

/* ==========================================================
   NAVIGATION + HASH URL
========================================================== */
function activateSection(target, { updateHash = false, scroll = true } = {}) {
    const sectionId = VALID_SECTIONS.includes(target) ? target : 'about';

    navButtons.forEach(btn => {
        const active = btn.dataset.target === sectionId;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-current', active ? 'page' : 'false');
    });

    pageSections.forEach(section => {
        section.classList.toggle('active', section.id === sectionId);
    });

    if (updateHash && window.location.hash !== `#${sectionId}`) {
        history.pushState(null, '', `#${sectionId}`);
    }

    closeMobileMenu();
    refreshRevealElements();

    if (scroll) {
        window.scrollTo({ top: 0, behavior: motionReduced ? 'auto' : 'smooth' });
    }
}

function navigateToSection(target) {
    activateSection(target, { updateHash: true, scroll: true });
    if (['projects', 'courses'].includes(target)) refreshRemoteContentIfStale().catch(console.warn);
    if (target === 'library') renderPersonalLibrary().catch(console.warn);
    if (target === 'notifications') window.refreshNotificationCenter?.();
}

function syncSectionFromHash({ scroll = false } = {}) {
    const target = window.location.hash.replace('#', '');
    activateSection(VALID_SECTIONS.includes(target) ? target : 'about', { updateHash: false, scroll });
}

function closeMobileMenu() {
    if (!mobileMenu || !mobileMenuBtn) return;
    mobileMenu.classList.remove('open');
    mobileMenuBtn.setAttribute('aria-expanded', 'false');
    mobileMenuBtn.innerHTML = '<i class="fa-solid fa-bars"></i>';
    mobileMenuBtn.dataset.tooltip = 'Ouvrir le menu';
    mobileMenuBtn.setAttribute('aria-label', 'Ouvrir le menu');
}

navButtons.forEach(button => {
    button.addEventListener('click', () => navigateToSection(button.dataset.target));
});

document.querySelectorAll('[data-go]').forEach(button => {
    button.addEventListener('click', () => navigateToSection(button.dataset.go));
});

mobileMenuBtn?.addEventListener('click', () => {
    const isOpen = mobileMenu.classList.toggle('open');
    mobileMenuBtn.setAttribute('aria-expanded', String(isOpen));
    mobileMenuBtn.innerHTML = isOpen ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-bars"></i>';
    mobileMenuBtn.dataset.tooltip = isOpen ? 'Fermer le menu' : 'Ouvrir le menu';
    mobileMenuBtn.setAttribute('aria-label', mobileMenuBtn.dataset.tooltip);
});

window.addEventListener('hashchange', () => syncSectionFromHash({ scroll: false }));
window.addEventListener('popstate', () => syncSectionFromHash({ scroll: false }));

/* ==========================================================
   PROJETS : FILTRES, RECHERCHE ET MODALE
========================================================== */
function renderProjects() {
    const container = document.getElementById('projects-container');
    const emptyState = document.getElementById('projects-empty');
    if (!container) return;

    const term = normalizeText(projectSearchTerm);
    const filtered = myProjects
        .map((project, index) => ({ project, index }))
        .filter(({ project }) => {
            const categoryMatch = activeProjectCategory === 'all' || project.category === activeProjectCategory;
            const searchable = normalizeText([
                project.name,
                project.description,
                project.category,
                ...project.tags,
                ...project.features
            ].join(' '));
            return categoryMatch && (!term || searchable.includes(term));
        });

    container.innerHTML = filtered.map(({ project, index }) => {
        const status = projectStatus(project);
        const mediaElement = project.logoUrl
            ? `<img src="${escapeHtmlAttribute(project.logoUrl)}" alt="" class="project-logo" loading="lazy">`
            : `<i class="${escapeHtmlAttribute(project.icon)}" aria-hidden="true"></i>`;
        const tags = project.tags.map(tag => `<span class="tech-chip">${escapeHtmlAttribute(tag)}</span>`).join('');
        const download = safeExternalLink(project.appUrl)
            ? `<a href="${escapeHtmlAttribute(project.appUrl)}" class="primary-btn" target="_blank" rel="noopener"><i class="fa-solid fa-download"></i> Télécharger</a>`
            : '';
        const source = safeExternalLink(project.devUrl)
            ? `<a href="${escapeHtmlAttribute(project.devUrl)}" class="project-mini-link" target="_blank" rel="noopener" data-tooltip="Voir le code source" aria-label="Code source de ${escapeHtmlAttribute(project.name)}"><i class="fa-solid fa-code"></i></a>`
            : '';

        return `
            <article class="project-card">
                <div class="project-card-top">
                    <div class="project-media">${mediaElement}</div>
                    <span class="project-status ${status}" data-tooltip="${escapeHtmlAttribute(projectStatusDescriptions[status] || 'Statut du projet')}">${projectStatusLabels[status] || 'Projet'}</span>
                </div>
                <div class="project-card-body">
                    <span class="project-category">${categoryLabels[project.category] || 'Projet'}</span>
                    <h2>${escapeHtmlAttribute(project.name)}</h2>
                    <p class="project-desc">${escapeHtmlAttribute(project.description)}</p>
                    <div class="project-tech">${tags}</div>
                    <p class="project-feature-preview"><i class="fa-solid fa-list-check"></i>${project.features.length} fonctionnalité${project.features.length > 1 ? 's' : ''} présentée${project.features.length > 1 ? 's' : ''}</p>
                    <div class="project-actions">
                        <button class="detail-btn" type="button" onclick="openProjectModal(${index})"><i class="fa-regular fa-eye"></i> Voir le détail</button>
                        ${download}
                        ${source}
                    </div>
                </div>
            </article>
        `;
    }).join('');

    if (emptyState) {
        emptyState.hidden = filtered.length !== 0;
        const heading = emptyState.querySelector('h2');
        const paragraph = emptyState.querySelector('p');
        if (publicContentLoadError) {
            if (heading) heading.textContent = 'Projets temporairement indisponibles';
            if (paragraph) paragraph.textContent = 'Le contenu n’a pas pu être chargé. Réessayez dans quelques instants.';
        } else {
            if (heading) heading.textContent = 'Aucun projet trouvé';
            if (paragraph) paragraph.textContent = 'Essayez une autre recherche ou une autre catégorie.';
        }
    }
}

function openProjectModal(index) {
    const project = myProjects[index];
    const modal = document.getElementById('projectModal');
    const body = document.getElementById('project-modal-body');
    if (!project || !modal || !body) return;

    const status = projectStatus(project);
    const mediaElement = project.logoUrl
        ? `<img src="${escapeHtmlAttribute(project.logoUrl)}" alt="">`
        : `<i class="${escapeHtmlAttribute(project.icon)}" aria-hidden="true"></i>`;
    const tags = project.tags.map(tag => `<span class="tech-chip">${escapeHtmlAttribute(tag)}</span>`).join('');
    const features = project.features.map(feature => `<li><i class="fa-solid fa-check"></i><span>${escapeHtmlAttribute(feature)}</span></li>`).join('');

    const actions = [];
    if (safeExternalLink(project.appUrl)) {
        actions.push(`<a href="${escapeHtmlAttribute(project.appUrl)}" class="primary-btn" target="_blank" rel="noopener"><i class="fa-solid fa-download"></i> Télécharger</a>`);
    }
    if (safeExternalLink(project.devUrl)) {
        actions.push(`<a href="${escapeHtmlAttribute(project.devUrl)}" class="secondary-btn" target="_blank" rel="noopener"><i class="fa-solid fa-code"></i> Code source</a>`);
    }
    if (!actions.length) {
        actions.push('<span class="project-unavailable"><i class="fa-solid fa-clock"></i> Liens non disponibles pour le moment</span>');
    }

    body.innerHTML = `
        <div class="project-modal-header">
            <div class="project-modal-media">${mediaElement}</div>
            <div>
                <span class="project-status ${status}" data-tooltip="${escapeHtmlAttribute(projectStatusDescriptions[status] || 'Statut du projet')}">${projectStatusLabels[status] || 'Projet'}</span>
                <h2 id="project-modal-title">${escapeHtmlAttribute(project.name)}</h2>
                <p>${escapeHtmlAttribute(project.description)}</p>
            </div>
        </div>
        <section class="project-modal-section">
            <h3>Catégorie & univers</h3>
            <div class="project-tech"><span class="tech-chip">${categoryLabels[project.category] || 'Projet'}</span>${tags}</div>
        </section>
        <section class="project-modal-section">
            <h3>Fonctionnalités</h3>
            <ul class="project-feature-list">${features}</ul>
        </section>
        <div class="project-modal-actions">${actions.join('')}</div>
    `;

    modal.classList.add('active');
    setBodyModalState();
    modal.querySelector('.modal-close-btn')?.focus();
}

function closeProjectModal(event) {
    if (event && !isRealModalBackdropClick(event)) return;
    document.getElementById('projectModal')?.classList.remove('active');
    setBodyModalState();
}

window.openProjectModal = openProjectModal;
window.closeProjectModal = closeProjectModal;

const projectSearch = document.getElementById('project-search');
projectSearch?.addEventListener('input', event => {
    projectSearchTerm = event.target.value;
    renderProjects();
});

document.querySelectorAll('#project-filters .filter-btn').forEach(button => {
    button.addEventListener('click', () => {
        activeProjectCategory = button.dataset.category || 'all';
        document.querySelectorAll('#project-filters .filter-btn').forEach(btn => btn.classList.toggle('active', btn === button));
        renderProjects();
    });
});

/* ==========================================================
   INFORMATIONS — ÉTUDES / PROJETS + ABONNEMENTS
========================================================== */
function infoSectionLabel(section) {
    return section === 'projects' ? 'Projets' : 'Études';
}

function formatInfoDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function fileIconFromName(name = '') {
    const ext = String(name || '').split('?')[0].split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'fa-solid fa-file-pdf';
    if (['doc', 'docx', 'odt'].includes(ext)) return 'fa-solid fa-file-word';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return 'fa-solid fa-file-excel';
    if (['ppt', 'pptx'].includes(ext)) return 'fa-solid fa-file-powerpoint';
    if (ext === 'zip') return 'fa-solid fa-file-zipper';
    if (['txt', 'md'].includes(ext)) return 'fa-solid fa-file-lines';
    return 'fa-solid fa-paperclip';
}

function renderInfoCollection(containerId, section) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Une information peut désormais être publiée sans description :
    // le titre (et éventuellement l’image) suffit.
    const publishedInfo = generalInfo.filter(info => info.section === section);

    if (!publishedInfo.length) {
        const loadFailed = Boolean(publicContentLoadError);
        container.innerHTML = `
            <div class="info-block info-block-empty">
                <div class="info-block-icon"><i class="${loadFailed ? 'fa-solid fa-cloud-arrow-down' : 'fa-regular fa-circle-check'}"></i></div>
                <div>
                    <h3 class="info-block-title">${loadFailed ? 'Informations temporairement indisponibles' : 'Rien à signaler'}</h3>
                    <p class="info-block-text">${loadFailed ? 'Le contenu n’a pas pu être chargé. Réessayez dans quelques instants.' : "Aucune information n'est publiée dans cette rubrique pour le moment."}</p>
                </div>
            </div>
        `;
        return;
    }

    container.innerHTML = publishedInfo.map(info => {
        const imageHtml = info.imageUrl ? `<img src="${escapeHtmlAttribute(info.imageUrl)}" alt="${escapeHtmlAttribute(info.title)}" class="info-block-img" loading="lazy">` : '';
        const attachmentLabel = info.attachmentName || (info.attachmentUrl ? decodeURIComponent(String(info.attachmentUrl).split('/').pop().split('?')[0] || 'Fichier joint') : '');
        const attachmentHtml = info.attachmentUrl ? `
            <a class="info-attachment" href="${escapeHtmlAttribute(info.attachmentUrl)}" target="_blank" rel="noopener noreferrer">
                <span class="info-attachment-icon"><i class="${fileIconFromName(attachmentLabel || info.attachmentUrl)}"></i></span>
                <span><strong>${escapeHtmlAttribute(attachmentLabel || 'Fichier joint')}</strong><small>Ouvrir ou télécharger le document</small></span>
                <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>
            </a>` : '';
        const dateLabel = formatInfoDate(info.publishedAt);
        const favoriteButton = siteFavoriteButtonMarkup('info', info._dbId, 'Enregistrer cette information', 'info-favorite-btn');
        return `
            <article class="info-block" data-info-id="${escapeHtmlAttribute(info._dbId)}" data-info-section="${escapeHtmlAttribute(info.section)}">
                ${favoriteButton}
                <div class="info-block-head">
                    <span class="info-block-icon"><i class="${escapeHtmlAttribute(info.icon)}"></i></span>
                    <div class="info-block-heading-copy">
                        <h3 class="info-block-title">${escapeHtmlAttribute(info.title)}</h3>
                        ${dateLabel ? `<span class="info-block-date"><i class="fa-regular fa-calendar"></i> ${escapeHtmlAttribute(dateLabel)}</span>` : ''}
                    </div>
                </div>
                ${String(info.text || '').trim() ? `<p class="info-block-text">${escapeHtmlAttribute(info.text)}</p>` : ''}
                ${imageHtml}
                ${attachmentHtml}
            </article>
        `;
    }).join('');
    refreshFavoriteButtons(container);
}

function renderGeneralInfo() {
    renderInfoCollection('general-info-container', 'studies');
}

function renderProjectInfo() {
    renderInfoCollection('project-info-container', 'projects');
    const count = generalInfo.filter(info => info.section === 'projects').length;
    const badge = document.getElementById('project-info-tab-count');
    if (badge) badge.textContent = String(count);
    const catalogBadge = document.getElementById('project-catalog-tab-count');
    if (catalogBadge) catalogBadge.textContent = String(myProjects.length);
}

function switchProjectPageTab(tabName = 'catalog') {
    currentProjectPageTab = tabName === 'infos' ? 'infos' : 'catalog';
    const catalog = document.getElementById('project-catalog-content');
    const infos = document.getElementById('project-info-content');
    const catalogBtn = document.getElementById('project-tab-catalog');
    const infoBtn = document.getElementById('project-tab-infos');
    const showingInfo = currentProjectPageTab === 'infos';

    if (catalog) catalog.hidden = showingInfo;
    if (infos) infos.hidden = !showingInfo;
    if (catalogBtn) {
        catalogBtn.classList.toggle('active', !showingInfo);
        catalogBtn.setAttribute('aria-selected', String(!showingInfo));
    }
    if (infoBtn) {
        infoBtn.classList.toggle('active', showingInfo);
        infoBtn.setAttribute('aria-selected', String(showingInfo));
    }

    if (showingInfo) {
        renderProjectInfo();
        refreshInfoSubscriptionButtons().catch(console.warn);
    }
    refreshRevealElements();
}

async function getCurrentSiteUser() {
    if (!initSupabaseClient()) return null;
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) return null;
    return data?.session?.user || null;
}


/* ==========================================================
   FAVORIS + BIBLIOTHÈQUE PERSONNELLE
========================================================== */
function siteFavoriteKey(type, id) {
    return `${String(type || '')}:${String(id ?? '')}`;
}

function siteFavoriteButtonMarkup(type, id, label = 'Ajouter aux favoris', extraClass = '') {
    if (!SITE_FAVORITE_TYPES.has(type) || id === null || id === undefined || id === '') return '';
    const active = siteFavoriteKeys.has(siteFavoriteKey(type, id));
    const tooltip = active ? 'Retirer des favoris' : label;
    return `<button type="button" class="favorite-toggle-btn ${extraClass} ${active ? 'active' : ''}" data-favorite-type="${escapeHtmlAttribute(type)}" data-favorite-id="${escapeHtmlAttribute(id)}" data-tooltip="${escapeHtmlAttribute(tooltip)}" aria-label="${escapeHtmlAttribute(tooltip)}"><i class="${active ? 'fa-solid' : 'fa-regular'} fa-bookmark"></i></button>`;
}

function refreshFavoriteButtons(root = document) {
    root.querySelectorAll?.('[data-favorite-type][data-favorite-id]').forEach(button => {
        const active = siteFavoriteKeys.has(siteFavoriteKey(button.dataset.favoriteType, button.dataset.favoriteId));
        button.classList.toggle('active', active);
        const icon = button.querySelector('i');
        if (icon) icon.className = `${active ? 'fa-solid' : 'fa-regular'} fa-bookmark`;
        const label = active ? 'Retirer des favoris' : 'Ajouter aux favoris';
        button.dataset.tooltip = label;
        button.setAttribute('aria-label', label);
    });
    const badge = document.getElementById('favorites-badge');
    if (badge) {
        badge.textContent = siteFavoriteRows.length > 99 ? '99+' : String(siteFavoriteRows.length);
        badge.hidden = siteFavoriteRows.length === 0;
    }
    const count = document.getElementById('library-favorite-count');
    if (count) count.textContent = String(siteFavoriteRows.length);
}

async function loadSiteFavorites() {
    const user = await getCurrentSiteUser();
    if (!user) {
        siteFavoriteRows = [];
        siteFavoriteKeys = new Set();
        refreshFavoriteButtons();
        return [];
    }
    const { data, error } = await supabaseClient.from('user_favorites')
        .select('item_type,item_id,created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
    if (error) {
        console.warn('Favoris indisponibles :', error);
        siteFavoriteRows = [];
        siteFavoriteKeys = new Set();
        refreshFavoriteButtons();
        return [];
    }
    siteFavoriteRows = data || [];
    siteFavoriteKeys = new Set(siteFavoriteRows.map(row => siteFavoriteKey(row.item_type, row.item_id)));
    refreshFavoriteButtons();
    return siteFavoriteRows;
}

async function toggleSiteFavorite(type, id) {
    if (!SITE_FAVORITE_TYPES.has(type) || id === null || id === undefined || id === '') return;
    const user = await getCurrentSiteUser();
    if (!user) {
        if (typeof window.openAccountModal === 'function') window.openAccountModal('login');
        else showToast('Connectez-vous pour utiliser les favoris.');
        return;
    }
    const key = siteFavoriteKey(type, id);
    const active = siteFavoriteKeys.has(key);
    try {
        const query = active
            ? supabaseClient.from('user_favorites').delete().eq('user_id', user.id).eq('item_type', type).eq('item_id', String(id))
            : supabaseClient.from('user_favorites').insert({ user_id: user.id, item_type: type, item_id: String(id) });
        const { error } = await query;
        if (error) throw error;
        if (active) {
            siteFavoriteRows = siteFavoriteRows.filter(row => siteFavoriteKey(row.item_type, row.item_id) !== key);
            siteFavoriteKeys.delete(key);
            showToast('Retiré des favoris.');
        } else {
            siteFavoriteRows.unshift({ item_type: type, item_id: String(id), created_at: new Date().toISOString() });
            siteFavoriteKeys.add(key);
            showToast('Ajouté à votre bibliothèque.');
        }
        refreshFavoriteButtons();
        if (document.getElementById('library')?.classList.contains('active')) await renderPersonalLibrary();
    } catch (error) {
        console.error('Favoris :', error);
        showToast(error?.message?.includes('user_favorites') ? 'Exécutez la migration Supabase V2.9.1.' : (error.message || 'Impossible de modifier les favoris.'));
    }
}

function collectRuntimeDocuments() {
    const map = new Map();
    myCourses.forEach((subject, subjectIndex) => {
        const groups = [
            ['lessons', 'Cours'],
            ['sheets', 'Fiche & formulaire'],
            ['exercise_statements', 'Énoncé'],
            ['exercise_corrections', 'Correction']
        ];
        groups.forEach(([type, typeLabel]) => (subject[type] || []).forEach(doc => {
            map.set(String(doc._dbId), { ...doc, subjectIndex, subjectName: subject.name, type, typeLabel, viewer: 'course' });
        }));
    });
    globalResources.forEach(doc => map.set(String(doc._dbId), { ...doc, subjectIndex: -1, subjectName: 'Ressources générales', type: 'resources', typeLabel: 'Ressource', viewer: 'resource' }));
    return map;
}

async function resolveFavoriteItems() {
    const resolved = new Map();
    const docs = collectRuntimeDocuments();
    const infos = new Map(generalInfo.map(info => [String(info._dbId), info]));

    siteFavoriteRows.forEach(row => {
        const key = siteFavoriteKey(row.item_type, row.item_id);
        if (row.item_type === 'document' && docs.has(String(row.item_id))) {
            const doc = docs.get(String(row.item_id));
            resolved.set(key, { key, type: 'document', id: String(row.item_id), title: doc.title, detail: `${doc.typeLabel} · ${doc.subjectName}`, icon: fileIconFromName(doc.fileName || doc.url), createdAt: row.created_at, raw: doc });
        } else if (row.item_type === 'info' && infos.has(String(row.item_id))) {
            const info = infos.get(String(row.item_id));
            resolved.set(key, { key, type: 'info', id: String(row.item_id), title: info.title, detail: info.section === 'projects' ? 'Information · Projets' : 'Information · Études', icon: info.icon || 'fa-solid fa-bullhorn', createdAt: row.created_at, raw: info });
        }
    });

    const topicIds = siteFavoriteRows.filter(row => row.item_type === 'topic').map(row => row.item_id);
    if (topicIds.length && supabaseClient) {
        try {
            const { data, error } = await supabaseClient.from('forum_topic_summaries').select('id,title,category_name,created_at').in('id', topicIds);
            if (error) throw error;
            const topicMap = new Map((data || []).map(topic => [String(topic.id), topic]));
            siteFavoriteRows.filter(row => row.item_type === 'topic').forEach(row => {
                const topic = topicMap.get(String(row.item_id));
                if (topic) resolved.set(siteFavoriteKey('topic', row.item_id), { key: siteFavoriteKey('topic', row.item_id), type: 'topic', id: String(row.item_id), title: topic.title, detail: `Forum · ${topic.category_name || 'Discussion'}`, icon: 'fa-regular fa-comments', createdAt: row.created_at, raw: topic });
            });
        } catch (error) { console.warn('Résolution des sujets favoris :', error); }
    }

    siteFavoriteRows.forEach(row => {
        const key = siteFavoriteKey(row.item_type, row.item_id);
        if (!resolved.has(key)) resolved.set(key, { key, type: row.item_type, id: String(row.item_id), title: 'Contenu indisponible', detail: 'Ce contenu a été supprimé, masqué ou n’est plus accessible.', icon: 'fa-solid fa-link-slash', createdAt: row.created_at, missing: true });
    });
    siteFavoriteResolved = resolved;
    return [...resolved.values()];
}

function favoriteTypeLabel(type) {
    return type === 'document' ? 'Études' : type === 'topic' ? 'Forum' : 'Information';
}

function renderFavoriteLibraryItems(items) {
    const container = document.getElementById('library-favorites-list');
    if (!container) return;
    const term = normalizeText(personalLibrarySearch);
    const filtered = items.filter(item => (personalLibraryFilter === 'all' || item.type === personalLibraryFilter) && (!term || normalizeText(`${item.title} ${item.detail}`).includes(term)));
    if (!filtered.length) {
        container.innerHTML = `<div class="library-empty"><i class="fa-regular fa-bookmark"></i><h3>Aucun favori</h3><p>${term || personalLibraryFilter !== 'all' ? 'Aucun élément ne correspond à ce filtre.' : 'Utilisez l’icône marque-page sur un cours, une fiche, une information ou un sujet du forum.'}</p></div>`;
        return;
    }
    container.innerHTML = filtered.map(item => `
        <article class="personal-library-item ${item.missing ? 'is-missing' : ''}">
            <span class="personal-library-item-icon"><i class="${escapeHtmlAttribute(item.icon)}"></i></span>
            <div class="personal-library-item-copy"><small>${favoriteTypeLabel(item.type)}</small><strong>${escapeHtmlAttribute(item.title)}</strong><span>${escapeHtmlAttribute(item.detail)}</span></div>
            <div class="personal-library-item-actions">
                ${item.missing ? '' : `<button class="secondary-btn compact-btn" type="button" data-library-open="${escapeHtmlAttribute(item.key)}"><i class="fa-solid fa-arrow-up-right-from-square"></i> Ouvrir</button>`}
                <button class="icon-btn danger-btn" type="button" data-favorite-type="${escapeHtmlAttribute(item.type)}" data-favorite-id="${escapeHtmlAttribute(item.id)}" data-tooltip="Retirer des favoris" aria-label="Retirer des favoris"><i class="fa-solid fa-bookmark"></i></button>
            </div>
        </article>`).join('');
    refreshFavoriteButtons(container);
}

async function openResolvedFavorite(key) {
    const item = siteFavoriteResolved.get(key);
    if (!item || item.missing) return;
    if (item.type === 'document') {
        const doc = item.raw;
        navigateToSection('courses');
        if (doc.viewer === 'resource') {
            switchMainCourseTab('global-resources-content');
            window.setTimeout(() => openResourcePdf(doc.title, doc.url, doc._dbId), 60);
        } else {
            switchMainCourseTab('courses-content');
            let tab = doc.type;
            if (['exercise_statements', 'exercise_corrections'].includes(tab)) tab = 'exercises';
            selectSubject(doc.subjectIndex, tab, doc.type);
            window.setTimeout(() => openPdf(doc.title, doc.url, doc._dbId), 60);
        }
        return;
    }
    if (item.type === 'info') {
        const info = item.raw;
        if (info.section === 'projects') { navigateToSection('projects'); switchProjectPageTab('infos'); }
        else { navigateToSection('courses'); switchMainCourseTab('global-info-content'); }
        window.setTimeout(() => document.querySelector(`.info-block[data-info-id="${CSS.escape(String(info._dbId))}"]`)?.scrollIntoView({ behavior: motionReduced ? 'auto' : 'smooth', block: 'center' }), 100);
        return;
    }
    if (item.type === 'topic' && typeof window.openForumTopic === 'function') {
        if (typeof window.goToForum === 'function') window.goToForum(); else navigateToSection('forum');
        await window.openForumTopic(item.id);
    }
}

/* ==========================================================
   RESSOURCES HORS CONNEXION
========================================================== */
function offlineStorageKey(userId) { return `tremble-offline-resources:${userId || 'anonymous'}`; }

function getOfflineEntries(userId) {
    if (!userId) return [];
    try { return JSON.parse(localStorage.getItem(offlineStorageKey(userId)) || '[]').filter(item => item?.id && item?.url); }
    catch { return []; }
}

function setOfflineEntries(userId, entries) {
    if (!userId) return;
    localStorage.setItem(offlineStorageKey(userId), JSON.stringify(entries));
}

async function sendServiceWorkerMessage(message) {
    if (!('serviceWorker' in navigator)) throw new Error('Le mode hors connexion n’est pas pris en charge par ce navigateur.');
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active || registration.waiting || registration.installing;
    if (!worker) throw new Error('Le service hors connexion n’est pas encore prêt. Rechargez la page puis réessayez.');
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error('Le téléchargement hors connexion a expiré.')), 30000);
        channel.port1.onmessage = event => {
            clearTimeout(timer);
            if (event.data?.ok) resolve(event.data);
            else reject(new Error(event.data?.error || 'Impossible d’enregistrer le fichier hors connexion.'));
        };
        worker.postMessage(message, [channel.port2]);
    });
}

async function refreshOfflineDocumentButtons() {
    const user = await getCurrentSiteUser();
    const saved = new Set(getOfflineEntries(user?.id).map(item => String(item.id)));
    document.querySelectorAll('[data-offline-document-id]').forEach(button => {
        const active = saved.has(String(button.dataset.offlineDocumentId));
        button.classList.toggle('active', active);
        button.innerHTML = `<i class="fa-solid ${active ? 'fa-cloud-arrow-up' : 'fa-cloud-arrow-down'}"></i>`;
        const label = active ? 'Retirer du mode hors connexion' : 'Rendre disponible hors connexion';
        button.dataset.tooltip = label;
        button.setAttribute('aria-label', label);
    });
    const count = document.getElementById('library-offline-count');
    if (count) count.textContent = String(saved.size);
}

async function toggleOfflineDocument(button) {
    const user = await getCurrentSiteUser();
    if (!user) {
        if (typeof window.openAccountModal === 'function') window.openAccountModal('login');
        else showToast('Connectez-vous pour enregistrer une ressource hors connexion.');
        return;
    }
    const id = String(button.dataset.offlineDocumentId || '');
    const url = button.dataset.offlineUrl || '';
    if (!id || !safeResourceUrl(url)) return;
    let entries = getOfflineEntries(user.id);
    const existing = entries.find(item => String(item.id) === id);
    button.disabled = true;
    try {
        if (existing) {
            await sendServiceWorkerMessage({ type: 'REMOVE_OFFLINE_DOCUMENT', url });
            entries = entries.filter(item => String(item.id) !== id);
            setOfflineEntries(user.id, entries);
            showToast('Ressource retirée du mode hors connexion.');
        } else {
            showToast('Téléchargement pour le mode hors connexion…');
            await sendServiceWorkerMessage({ type: 'CACHE_OFFLINE_DOCUMENT', url });
            entries.unshift({ id, title: button.dataset.offlineTitle || 'Document', url, viewer: button.dataset.offlineViewer || 'course', savedAt: new Date().toISOString() });
            setOfflineEntries(user.id, entries);
            showToast('Ressource disponible hors connexion.');
        }
        await refreshOfflineDocumentButtons();
        if (document.getElementById('library')?.classList.contains('active')) await renderPersonalLibrary();
    } catch (error) {
        console.error(error);
        showToast(error.message || 'Impossible d’enregistrer cette ressource hors connexion.');
    } finally { button.disabled = false; }
}

async function renderOfflineLibrary() {
    const container = document.getElementById('library-offline-list');
    if (!container) return;
    const user = await getCurrentSiteUser();
    if (!user) {
        container.innerHTML = '<div class="library-empty"><i class="fa-solid fa-cloud-arrow-down"></i><h3>Compte requis</h3><p>Connectez-vous pour gérer les ressources enregistrées sur cet appareil.</p></div>';
        return;
    }
    const term = normalizeText(personalLibrarySearch);
    const entries = getOfflineEntries(user.id).filter(item => !term || normalizeText(item.title).includes(term));
    if (!entries.length) {
        container.innerHTML = '<div class="library-empty"><i class="fa-solid fa-cloud-arrow-down"></i><h3>Aucune ressource enregistrée</h3><p>Dans la partie Études, utilisez l’icône nuage à côté d’un document pour le conserver sur cet appareil.</p></div>';
        return;
    }
    container.innerHTML = entries.map(item => `
        <article class="personal-library-item">
            <span class="personal-library-item-icon offline"><i class="${fileIconFromName(item.title || item.url)}"></i></span>
            <div class="personal-library-item-copy"><small>Hors connexion</small><strong>${escapeHtmlAttribute(item.title)}</strong><span>Enregistré ${formatInfoDate(item.savedAt) || 'sur cet appareil'}</span></div>
            <div class="personal-library-item-actions">
                <button class="secondary-btn compact-btn" type="button" data-offline-open-id="${escapeHtmlAttribute(item.id)}"><i class="fa-solid fa-eye"></i> Ouvrir</button>
                <button class="icon-btn danger-btn" type="button" data-offline-remove-id="${escapeHtmlAttribute(item.id)}" data-tooltip="Retirer du mode hors connexion" aria-label="Retirer"><i class="fa-solid fa-trash"></i></button>
            </div>
        </article>`).join('');
}

async function openOfflineEntry(id) {
    const user = await getCurrentSiteUser();
    const entry = getOfflineEntries(user?.id).find(item => String(item.id) === String(id));
    if (!entry) return;
    navigateToSection('courses');
    if (entry.viewer === 'resource') {
        switchMainCourseTab('global-resources-content');
        window.setTimeout(() => openResourcePdf(entry.title, entry.url, entry.id), 40);
    } else {
        switchMainCourseTab('courses-content');
        window.setTimeout(() => openPdf(entry.title, entry.url, entry.id), 40);
    }
}

async function removeOfflineEntry(id) {
    const user = await getCurrentSiteUser();
    if (!user) return;
    let entries = getOfflineEntries(user.id);
    const entry = entries.find(item => String(item.id) === String(id));
    if (!entry) return;
    try { await sendServiceWorkerMessage({ type: 'REMOVE_OFFLINE_DOCUMENT', url: entry.url }); } catch (error) { console.warn(error); }
    entries = entries.filter(item => String(item.id) !== String(id));
    setOfflineEntries(user.id, entries);
    await renderPersonalLibrary();
    await refreshOfflineDocumentButtons();
}

async function renderPersonalLibrary() {
    const user = await getCurrentSiteUser();
    if (user && !siteFavoriteRows.length) await loadSiteFavorites();
    const favoritePanel = document.getElementById('library-favorites-panel');
    const offlinePanel = document.getElementById('library-offline-panel');
    const showingOffline = personalLibraryTab === 'offline';
    if (favoritePanel) favoritePanel.hidden = showingOffline;
    if (offlinePanel) offlinePanel.hidden = !showingOffline;
    document.querySelectorAll('[data-library-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.libraryTab === personalLibraryTab));
    if (showingOffline) await renderOfflineLibrary();
    else if (!user) {
        const container = document.getElementById('library-favorites-list');
        if (container) container.innerHTML = '<div class="library-empty"><i class="fa-regular fa-user"></i><h3>Connectez-vous</h3><p>Votre bibliothèque personnelle est synchronisée avec votre compte.</p><button type="button" class="primary-btn compact-btn" data-library-login><i class="fa-solid fa-right-to-bracket"></i> Se connecter</button></div>';
    } else renderFavoriteLibraryItems(await resolveFavoriteItems());
    refreshFavoriteButtons();
    await refreshOfflineDocumentButtons();
    updateLibraryNetworkState();
}

async function openPersonalLibrary(tab = 'favorites') {
    personalLibraryTab = tab === 'offline' ? 'offline' : 'favorites';
    navigateToSection('library');
    await renderPersonalLibrary();
}

function updateLibraryNetworkState() {
    const online = navigator.onLine !== false;
    const card = document.getElementById('library-network-card');
    const status = document.getElementById('library-network-status');
    const detail = document.getElementById('library-network-detail');
    if (card) { card.classList.toggle('is-online', online); card.classList.toggle('is-offline', !online); const icon = card.querySelector('i'); if (icon) icon.className = `fa-solid ${online ? 'fa-wifi' : 'fa-plane-up'}`; }
    if (status) status.textContent = online ? 'En ligne' : 'Hors connexion';
    if (detail) detail.textContent = online ? 'Les ressources peuvent être synchronisées.' : 'Les fichiers enregistrés restent accessibles.';
}

/* ==========================================================
   V2.9.1 — POLISH VISUEL LÉGER
   Barre de progression + halo interactif sur les cartes.
   Désactivé automatiquement si les animations sont réduites.
========================================================== */
let siteScrollProgressFrame = 0;

function ensureSiteScrollProgress() {
    let bar = document.getElementById('site-scroll-progress');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'site-scroll-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
    return bar;
}

function updateSiteScrollProgress() {
    siteScrollProgressFrame = 0;
    const bar = ensureSiteScrollProgress();
    const root = document.documentElement;
    const maxScroll = Math.max(1, root.scrollHeight - root.clientHeight);
    const ratio = Math.min(1, Math.max(0, (window.scrollY || root.scrollTop || 0) / maxScroll));
    bar.style.transform = `scaleX(${ratio})`;
}

function scheduleSiteScrollProgress() {
    if (siteScrollProgressFrame) return;
    siteScrollProgressFrame = requestAnimationFrame(updateSiteScrollProgress);
}

function initInteractiveSurfaceEffects() {
    if (motionReduced || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;

    const selector = [
        '.stat-card', '.service-card', '.project-card', '.info-block',
        '.personal-library-item', '.notification-center-item',
        '.forum-category-card', '.forum-topic-card', '.forum-topic-row',
        '.community-member-card', '.forum-directory-member'
    ].join(',');

    document.addEventListener('pointermove', event => {
        if (motionReduced) return;
        const card = event.target.closest?.(selector);
        if (!card) return;
        const rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = ((event.clientX - rect.left) / rect.width) * 100;
        const y = ((event.clientY - rect.top) / rect.height) * 100;
        card.style.setProperty('--spot-x', `${Math.max(0, Math.min(100, x)).toFixed(1)}%`);
        card.style.setProperty('--spot-y', `${Math.max(0, Math.min(100, y)).toFixed(1)}%`);
        card.classList.add('ui-spotlight-active');
    }, { passive: true });

    document.addEventListener('pointerout', event => {
        const card = event.target.closest?.(selector);
        if (!card || card.contains(event.relatedTarget)) return;
        card.classList.remove('ui-spotlight-active');
    }, { passive: true });
}

function initSiteVisualPolish() {
    ensureSiteScrollProgress();
    updateSiteScrollProgress();
    window.addEventListener('scroll', scheduleSiteScrollProgress, { passive: true });
    window.addEventListener('resize', scheduleSiteScrollProgress, { passive: true });
    initInteractiveSurfaceEffects();
}

/* ==========================================================
   PWA / INSTALLATION
========================================================== */
async function registerSitePwa() {
    if (!('serviceWorker' in navigator)) { updatePwaInstallUi('unsupported'); return; }
    try {
        await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
        await navigator.serviceWorker.ready;
        updatePwaInstallUi();
    } catch (error) {
        console.warn('Service Worker :', error);
        updatePwaInstallUi('unsupported');
    }
}

function isStandalonePwa() {
    return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIosPwaDevice() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function pwaInstallNoticeRecentlyDismissed() {
    const dismissedAt = Number(localStorage.getItem(PWA_INSTALL_NOTICE_DISMISS_KEY) || 0);
    return dismissedAt > 0 && Date.now() - dismissedAt < PWA_INSTALL_NOTICE_COOLDOWN;
}

function clearPwaInstallNoticeTimer() {
    if (!pwaInstallNoticeTimer) return;
    window.clearTimeout(pwaInstallNoticeTimer);
    pwaInstallNoticeTimer = null;
}

function hidePwaInstallNotice(remember = false) {
    clearPwaInstallNoticeTimer();
    if (remember) localStorage.setItem(PWA_INSTALL_NOTICE_DISMISS_KEY, String(Date.now()));
    const notice = document.getElementById('pwa-install-notice');
    if (!notice) return;
    notice.classList.remove('show');
    window.setTimeout(() => {
        if (!notice.classList.contains('show')) notice.hidden = true;
    }, motionReduced ? 0 : 240);
}

function showPwaInstallNotice(force = false) {
    if (isStandalonePwa()) return;
    if (!force && !deferredPwaInstallPrompt && !isIosPwaDevice()) return;
    if (!force && pwaInstallNoticeRecentlyDismissed()) return;
    const notice = document.getElementById('pwa-install-notice');
    if (!notice) return;
    notice.hidden = false;
    requestAnimationFrame(() => notice.classList.add('show'));
}

function schedulePwaInstallNotice(delay = 1300) {
    clearPwaInstallNoticeTimer();
    if (isStandalonePwa() || pwaInstallNoticeRecentlyDismissed()) return;
    pwaInstallNoticeTimer = window.setTimeout(() => {
        pwaInstallNoticeTimer = null;
        showPwaInstallNotice();
    }, motionReduced ? 250 : delay);
}

function updatePwaInstallUi(forcedState = '') {
    const footerButton = document.getElementById('pwa-footer-install-btn');
    const footerStatus = document.getElementById('pwa-footer-install-status');
    const noticeButton = document.getElementById('pwa-install-notice-btn');
    const noticeText = document.getElementById('pwa-install-notice-text');
    const ios = isIosPwaDevice();

    if (isStandalonePwa()) {
        if (footerButton) footerButton.hidden = true;
        hidePwaInstallNotice(false);
        return;
    }

    const nativeInstallAvailable = Boolean(deferredPwaInstallPrompt);
    const manualIosInstall = ios;

    // Le bouton reste accessible dans un onglet navigateur tant que le site
    // n'est pas ouvert en mode application. Certains navigateurs ne déclenchent
    // beforeinstallprompt qu'après quelques instants ou utilisent leur propre menu.
    if (footerButton) {
        footerButton.hidden = false;
        footerButton.classList.toggle('ios-install', manualIosInstall && !nativeInstallAvailable);
    }

    if (footerStatus) {
        footerStatus.textContent = nativeInstallAvailable
            ? 'Accès rapide, plein écran et ressources hors connexion'
            : manualIosInstall
                ? 'Ajouter à l’écran d’accueil sur iPhone / iPad'
                : 'Installer depuis le navigateur';
    }

    if (noticeButton) {
        noticeButton.innerHTML = nativeInstallAvailable
            ? '<i class="fa-solid fa-download"></i> Installer maintenant'
            : '<i class="fa-solid fa-share-nodes"></i> Voir comment';
    }

    if (noticeText) {
        noticeText.textContent = nativeInstallAvailable
            ? 'Installez l’application pour un accès plus rapide, un affichage plein écran et vos ressources enregistrées hors connexion.'
            : manualIosInstall
                ? 'Sur iPhone ou iPad : touchez Partager, puis « Ajouter à l’écran d’accueil ». Le bouton disparaît lorsque vous ouvrez le site depuis l’application installée.'
                : 'Si la fenêtre d’installation ne s’ouvre pas automatiquement, utilisez l’icône d’installation dans la barre d’adresse ou le menu de votre navigateur, puis choisissez « Installer l’application ».';
    }

    if (forcedState === 'unsupported') hidePwaInstallNotice(false);
}

async function installSitePwa() {
    if (isStandalonePwa()) {
        updatePwaInstallUi();
        return;
    }

    if (deferredPwaInstallPrompt) {
        const prompt = deferredPwaInstallPrompt;
        deferredPwaInstallPrompt = null;
        hidePwaInstallNotice(false);
        prompt.prompt();
        let choice = null;
        try { choice = await prompt.userChoice; } catch {}
        if (choice?.outcome === 'dismissed') localStorage.setItem(PWA_INSTALL_NOTICE_DISMISS_KEY, String(Date.now()));
        updatePwaInstallUi();
        return;
    }

    if (isIosPwaDevice()) {
        showPwaInstallNotice(true);
        showToast('Sur iPhone/iPad : Partager → Ajouter à l’écran d’accueil.');
        return;
    }

    // Fallback PC/Android lorsque le navigateur garde la main sur l’installation
    // et ne fournit pas beforeinstallprompt.
    showPwaInstallNotice(true);
    showToast('Utilisez l’icône d’installation dans la barre d’adresse ou le menu du navigateur.');
}

window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPwaInstallPrompt = event;
    updatePwaInstallUi();
    schedulePwaInstallNotice();
});

window.addEventListener('appinstalled', () => {
    deferredPwaInstallPrompt = null;
    localStorage.removeItem(PWA_INSTALL_NOTICE_DISMISS_KEY);
    updatePwaInstallUi();
    hidePwaInstallNotice(false);
    showToast('Application installée.');
});

window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', updatePwaInstallUi);
window.addEventListener('pageshow', () => updatePwaInstallUi());
window.addEventListener('online', updateLibraryNetworkState);
window.addEventListener('offline', updateLibraryNetworkState);

window.siteFavoriteButtonMarkup = siteFavoriteButtonMarkup;
window.refreshSiteFavorites = loadSiteFavorites;
window.refreshFavoriteButtons = refreshFavoriteButtons;
window.openPersonalLibrary = openPersonalLibrary;
window.onSiteAccountChanged = async () => {
    await loadSiteFavorites();
    await refreshOfflineDocumentButtons();
    if (document.getElementById('library')?.classList.contains('active')) await renderPersonalLibrary();
};

function setInfoSubscriptionButton(channel, user, subscribed = false) {
    const button = document.querySelector(`[data-info-subscribe="${channel}"]`);
    if (!button) return;
    const icon = button.querySelector('i');
    const label = button.querySelector('span');
    button.classList.toggle('active', Boolean(user && subscribed));
    button.dataset.subscribed = user && subscribed ? '1' : '0';

    if (!user) {
        if (icon) icon.className = 'fa-regular fa-bell';
        if (label) label.textContent = "S'abonner";
        button.dataset.tooltip = 'Connectez-vous pour recevoir les nouvelles informations';
        return;
    }

    if (icon) icon.className = subscribed ? 'fa-solid fa-bell' : 'fa-regular fa-bell';
    if (label) label.textContent = subscribed ? 'Abonné' : "S'abonner";
    button.dataset.tooltip = subscribed ? `Abonnement actif — ${infoSectionLabel(channel)}` : `Recevoir les nouvelles informations — ${infoSectionLabel(channel)}`;
}

async function refreshInfoSubscriptionButtons() {
    const user = await getCurrentSiteUser();
    if (!user) {
        setInfoSubscriptionButton('studies', null, false);
        setInfoSubscriptionButton('projects', null, false);
        return;
    }

    const { data, error } = await supabaseClient
        .from('site_info_subscriptions')
        .select('section')
        .eq('user_id', user.id);

    if (error) {
        console.warn('Abonnements aux informations indisponibles :', error);
        setInfoSubscriptionButton('studies', user, false);
        setInfoSubscriptionButton('projects', user, false);
        return;
    }

    const sections = new Set((data || []).map(row => row.section));
    setInfoSubscriptionButton('studies', user, sections.has('studies'));
    setInfoSubscriptionButton('projects', user, sections.has('projects'));
}

async function toggleInfoSubscription(channel) {
    if (!['studies', 'projects'].includes(channel)) return;
    const user = await getCurrentSiteUser();
    if (!user) {
        if (typeof window.openAccountModal === 'function') window.openAccountModal('login');
        else showToast('Connectez-vous pour vous abonner.');
        return;
    }

    const button = document.querySelector(`[data-info-subscribe="${channel}"]`);
    const subscribed = button?.dataset.subscribed === '1';
    if (button) button.disabled = true;

    try {
        const query = subscribed
            ? supabaseClient.from('site_info_subscriptions').delete().eq('user_id', user.id).eq('section', channel)
            : supabaseClient.from('site_info_subscriptions').insert({ user_id: user.id, section: channel });
        const { error } = await query;
        if (error) throw error;
        setInfoSubscriptionButton(channel, user, !subscribed);
        showToast(!subscribed
            ? `Abonnement activé pour les informations ${channel === 'projects' ? 'des projets' : "d'études"}.`
            : 'Abonnement retiré.');
    } catch (error) {
        console.error(error);
        showToast(error.message || "Impossible de modifier l'abonnement.");
    } finally {
        if (button) button.disabled = false;
    }
}

async function setInfoSubscriptionPreference(channel, enabled) {
    if (!['studies', 'projects'].includes(channel)) return false;
    const user = await getCurrentSiteUser();
    if (!user) return false;
    const { data: current, error: readError } = await supabaseClient.from('site_info_subscriptions')
        .select('section').eq('user_id', user.id).eq('section', channel).maybeSingle();
    if (readError) throw readError;
    const subscribed = Boolean(current);
    if (Boolean(enabled) === subscribed) return subscribed;
    const query = enabled
        ? supabaseClient.from('site_info_subscriptions').insert({ user_id: user.id, section: channel })
        : supabaseClient.from('site_info_subscriptions').delete().eq('user_id', user.id).eq('section', channel);
    const { error } = await query;
    if (error) throw error;
    await refreshInfoSubscriptionButtons();
    return Boolean(enabled);
}
window.setInfoSubscriptionPreference = setInfoSubscriptionPreference;
window.refreshInfoSubscriptionButtons = refreshInfoSubscriptionButtons;

document.querySelectorAll('[data-project-page-tab]').forEach(button => {
    button.addEventListener('click', () => switchProjectPageTab(button.dataset.projectPageTab));
});
document.querySelectorAll('[data-info-subscribe]').forEach(button => {
    button.addEventListener('click', () => toggleInfoSubscription(button.dataset.infoSubscribe));
});

window.switchProjectPageTab = switchProjectPageTab;
window.refreshInfoSubscriptionButtons = refreshInfoSubscriptionButtons;

/* ==========================================================
   COURS : AFFICHAGE PAR MATIÈRE
========================================================== */
function renderSubjects() {
    const subjectList = document.getElementById('subject-list');
    if (!subjectList) return;

    subjectList.innerHTML = myCourses.map((subject, index) => `
        <button class="subject-btn ${index === currentSubjectIndex ? 'active' : ''}" type="button" onclick="selectSubject(${index}, 'lessons', currentExerciseTab, true)">
            <i class="${escapeHtmlAttribute(subject.icon)}"></i><span>${escapeHtmlAttribute(subject.name)}</span>
        </button>
    `).join('');

    const label = document.getElementById('subject-total-label');
    if (label) label.textContent = `${myCourses.length} matière${myCourses.length > 1 ? 's' : ''}`;

    if (!myCourses.length) {
        const title = document.getElementById('current-subject-title');
        if (title) title.textContent = publicContentLoadError ? 'Bibliothèque temporairement indisponible' : 'Aucune matière publiée';
        ['lessons-list', 'exercise-statements-list', 'exercise-corrections-list', 'sheets-list'].forEach(id => {
            const list = document.getElementById(id);
            if (list) list.innerHTML = '<li class="list-empty">Aucun document</li>';
        });
        ['lessons', 'exercises', 'sheets'].forEach(key => {
            const count = document.getElementById(`count-${key}`);
            if (count) count.textContent = '0';
        });
        ['exercise-statements', 'exercise-corrections'].forEach(key => {
            const count = document.getElementById(`count-${key}`);
            if (count) count.textContent = '0';
        });
        closePdf();
        return;
    }

    currentSubjectIndex = Math.min(currentSubjectIndex, myCourses.length - 1);
    selectSubject(currentSubjectIndex, currentSubjectTab, currentExerciseTab);
}

function createDocumentList(items, emptyLabel, viewer = 'course') {
    if (!items.length) return `<li class="list-empty">${emptyLabel}</li>`;

    return items.map(item => {
        const documentId = escapeHtmlAttribute(item._dbId || '');
        const title = escapeHtmlAttribute(item.title);
        const url = escapeHtmlAttribute(item.url);
        return `
        <li class="study-document-row">
            <button class="pdf-item" type="button" data-tooltip="Prévisualiser le document" data-tooltip-placement="bottom" data-viewer="${viewer}" data-document-id="${documentId}" data-title="${title}" data-url="${url}">
                <span><i class="fa-regular fa-file-lines"></i>${title}</span>
                <i class="fa-solid fa-eye" aria-hidden="true"></i>
            </button>
            <div class="study-document-actions">
                ${siteFavoriteButtonMarkup('document', item._dbId, 'Ajouter aux favoris', 'study-document-action')}
                <button class="study-document-action offline-document-btn" type="button" data-offline-document-id="${documentId}" data-offline-title="${title}" data-offline-url="${url}" data-offline-viewer="${viewer}" data-tooltip="Rendre disponible hors connexion" aria-label="Rendre disponible hors connexion"><i class="fa-solid fa-cloud-arrow-down"></i></button>
            </div>
        </li>`;
    }).join('');
}

document.addEventListener('click', event => {
    const documentButton = event.target.closest('.pdf-item[data-url]');
    if (!documentButton) return;
    const title = documentButton.dataset.title || 'Document';
    const url = documentButton.dataset.url || '';
    const documentId = documentButton.dataset.documentId || '';
    if (documentButton.dataset.viewer === 'resource') openResourcePdf(title, url, documentId);
    else openPdf(title, url, documentId);
});

function selectSubject(index, preferredTab = 'lessons', preferredExerciseTab = currentExerciseTab, scrollOnMobile = false) {
    if (!myCourses[index]) return;

    if (preferredTab === 'exercise_statements' || preferredTab === 'exercise_corrections' || preferredTab === 'exercises') {
        preferredExerciseTab = preferredTab === 'exercise_corrections' ? 'exercise_corrections' : 'exercise_statements';
        preferredTab = 'exercises';
    }

    currentSubjectIndex = index;
    currentSubjectTab = preferredTab;
    currentExerciseTab = preferredExerciseTab;
    const subject = myCourses[index];

    document.querySelectorAll('.subject-btn').forEach((btn, idx) => {
        btn.classList.toggle('active', idx === index);
    });

    const title = document.getElementById('current-subject-title');
    if (title) title.textContent = subject.name;

    const lessonsList = document.getElementById('lessons-list');
    const statementsList = document.getElementById('exercise-statements-list');
    const correctionsList = document.getElementById('exercise-corrections-list');
    const sheetsList = document.getElementById('sheets-list');

    if (lessonsList) lessonsList.innerHTML = createDocumentList(subject.lessons, 'Aucun cours enregistré');
    if (statementsList) statementsList.innerHTML = createDocumentList(subject.exercise_statements, 'Aucun énoncé enregistré');
    if (correctionsList) correctionsList.innerHTML = createDocumentList(subject.exercise_corrections, 'Aucune correction enregistrée');
    if (sheetsList) sheetsList.innerHTML = createDocumentList(subject.sheets, 'Aucune fiche enregistrée');

    const exerciseCount = subject.exercise_statements.length + subject.exercise_corrections.length;
    const counts = {
        lessons: subject.lessons.length,
        exercises: exerciseCount,
        sheets: subject.sheets.length,
        'exercise-statements': subject.exercise_statements.length,
        'exercise-corrections': subject.exercise_corrections.length
    };
    Object.entries(counts).forEach(([key, value]) => {
        const element = document.getElementById(`count-${key}`);
        if (element) element.textContent = value;
    });

    closePdf();
    switchSubjectTab(preferredTab);
    if (preferredTab === 'exercises') switchExerciseTab(preferredExerciseTab);
    refreshFavoriteButtons();
    refreshOfflineDocumentButtons();

    if (scrollOnMobile && window.matchMedia?.('(max-width: 880px)').matches) {
        const panel = document.querySelector('#courses-content .course-content-panel');
        if (panel) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const navHeight = document.querySelector('.site-nav')?.getBoundingClientRect().height || 66;
                const top = panel.getBoundingClientRect().top + window.scrollY - navHeight - 12;
                window.scrollTo({ top: Math.max(0, top), behavior: motionReduced ? 'auto' : 'smooth' });
                if (!motionReduced) {
                    panel.classList.remove('mobile-subject-focus');
                    void panel.offsetWidth;
                    panel.classList.add('mobile-subject-focus');
                    window.setTimeout(() => panel.classList.remove('mobile-subject-focus'), 850);
                }
            }));
        }
    }
}

function renderGlobalResources() {
    const list = document.getElementById('global-resources-list');
    const count = document.getElementById('global-resources-count');
    if (count) count.textContent = String(globalResources.length);
    if (list) list.innerHTML = createDocumentList(globalResources, 'Aucune ressource générale publiée pour le moment.', 'resource');
    refreshFavoriteButtons();
    refreshOfflineDocumentButtons();
}

function switchMainCourseTab(tabId) {
    const tabs = {
        'courses-content': { panel: document.getElementById('courses-content'), btn: document.getElementById('btn-tab-courses') },
        'global-resources-content': { panel: document.getElementById('global-resources-content'), btn: document.getElementById('btn-tab-global-resources') },
        'global-info-content': { panel: document.getElementById('global-info-content'), btn: document.getElementById('btn-tab-global-info') }
    };
    if (!tabs[tabId]) tabId = 'courses-content';

    Object.entries(tabs).forEach(([key, tab]) => {
        const active = key === tabId;
        if (tab.panel) tab.panel.hidden = !active;
        tab.btn?.classList.toggle('active', active);
    });

    if (tabId !== 'courses-content') closePdf();
    if (tabId !== 'global-resources-content') closeResourcePdf();
}

function switchSubjectTab(tabType) {
    const tabs = {
        lessons: { panel: document.getElementById('subject-tab-lessons'), btn: document.getElementById('btn-tab-lessons') },
        exercises: { panel: document.getElementById('subject-tab-exercises'), btn: document.getElementById('btn-tab-exercises') },
        sheets: { panel: document.getElementById('subject-tab-sheets'), btn: document.getElementById('btn-tab-sheets') }
    };

    if (tabType === 'exercise_statements' || tabType === 'exercise_corrections') {
        currentExerciseTab = tabType;
        tabType = 'exercises';
    }
    if (!tabs[tabType]) tabType = 'lessons';
    currentSubjectTab = tabType;

    Object.entries(tabs).forEach(([key, tab]) => {
        const active = key === tabType;
        if (tab.panel) tab.panel.hidden = !active;
        tab.btn?.classList.toggle('active', active);
    });

    if (tabType === 'exercises') switchExerciseTab(currentExerciseTab);
}

function switchExerciseTab(tabType = 'exercise_statements') {
    const tabs = {
        exercise_statements: { panel: document.getElementById('exercise-panel-statements'), btn: document.getElementById('btn-exercise-statements') },
        exercise_corrections: { panel: document.getElementById('exercise-panel-corrections'), btn: document.getElementById('btn-exercise-corrections') }
    };
    if (!tabs[tabType]) tabType = 'exercise_statements';
    currentExerciseTab = tabType;
    Object.entries(tabs).forEach(([key, tab]) => {
        const active = key === tabType;
        if (tab.panel) tab.panel.hidden = !active;
        tab.btn?.classList.toggle('active', active);
    });
    closePdf();
}

/* ==========================================================
   RECHERCHE GLOBALE DANS LES COURS
========================================================== */
const courseTypeLabels = {
    lessons: 'Cours',
    exercises: 'Énoncé',
    exercise_statements: 'Énoncé',
    exercise_corrections: 'Correction',
    sheets: 'Fiche',
    resources: 'Ressource générale'
};

const courseTypeIcons = {
    lessons: 'fa-solid fa-book-open',
    exercises: 'fa-solid fa-file-pen',
    exercise_statements: 'fa-solid fa-file-pen',
    exercise_corrections: 'fa-solid fa-circle-check',
    sheets: 'fa-solid fa-file-lines',
    resources: 'fa-solid fa-box-archive'
};

function getCourseSearchEntries() {
    const entries = [];

    myCourses.forEach((subject, subjectIndex) => {
        entries.push({
            kind: 'subject',
            subjectIndex,
            subjectName: subject.name,
            title: subject.name,
            icon: subject.icon,
            searchable: normalizeText(subject.name)
        });

        ['lessons', 'exercise_statements', 'exercise_corrections', 'sheets'].forEach(type => {
            subject[type].forEach((item, itemIndex) => {
                entries.push({
                    kind: 'document',
                    subjectIndex,
                    subjectName: subject.name,
                    type,
                    itemIndex,
                    title: item.title,
                    url: item.url,
                    icon: courseTypeIcons[type],
                    searchable: normalizeText(`${subject.name} ${item.title} ${courseTypeLabels[type]}`)
                });
            });
        });
    });

    globalResources.forEach((item, itemIndex) => {
        entries.push({
            kind: 'resource',
            subjectIndex: -1,
            subjectName: 'Ressources générales',
            type: 'resources',
            itemIndex,
            title: item.title,
            url: item.url,
            icon: courseTypeIcons.resources,
            searchable: normalizeText(`${item.title} ressource générale document transversal`)
        });
    });

    return entries;
}

let courseSearchEntries = getCourseSearchEntries();

function renderCourseSearchResults(query) {
    const results = document.getElementById('course-search-results');
    if (!results) return;

    const term = normalizeText(query);
    if (!term) {
        results.hidden = true;
        results.innerHTML = '';
        return;
    }

    const matches = courseSearchEntries.filter(entry => entry.searchable.includes(term)).slice(0, 18);
    results.hidden = false;

    if (!matches.length) {
        results.innerHTML = '<div class="search-empty">Aucune ressource trouvée.</div>';
        return;
    }

    results.innerHTML = matches.map(entry => {
        if (entry.kind === 'subject') {
            return `
                <button type="button" class="course-search-item" onclick="openCourseSearchResult(${entry.subjectIndex}, 'lessons', -1)">
                    <i class="${escapeHtmlAttribute(entry.icon)}"></i>
                    <span><strong>${escapeHtmlAttribute(entry.title)}</strong><small>Ouvrir la matière</small></span>
                    <span class="course-search-type">Matière</span>
                </button>
            `;
        }

        return `
            <button type="button" class="course-search-item" onclick="openCourseSearchResult(${entry.subjectIndex}, '${entry.type}', ${entry.itemIndex})">
                <i class="${escapeHtmlAttribute(entry.icon)}"></i>
                <span><strong>${escapeHtmlAttribute(entry.title)}</strong><small>${escapeHtmlAttribute(entry.subjectName)}</small></span>
                <span class="course-search-type">${courseTypeLabels[entry.type]}</span>
            </button>
        `;
    }).join('');
}

function openCourseSearchResult(subjectIndex, type, itemIndex) {
    navigateToSection('courses');

    const searchInput = document.getElementById('course-search');
    const results = document.getElementById('course-search-results');
    if (searchInput) searchInput.value = '';
    if (results) {
        results.hidden = true;
        results.innerHTML = '';
    }

    if (type === 'resources') {
        switchMainCourseTab('global-resources-content');
        const item = globalResources[itemIndex];
        if (item) window.setTimeout(() => openResourcePdf(item.title, item.url, item._dbId || ''), motionReduced ? 0 : 120);
        return;
    }

    const subject = myCourses[subjectIndex];
    if (!subject) return;
    switchMainCourseTab('courses-content');
    selectSubject(subjectIndex, type);

    if (itemIndex >= 0 && subject[type]?.[itemIndex]) {
        const item = subject[type][itemIndex];
        window.setTimeout(() => openPdf(item.title, item.url, item._dbId || ''), motionReduced ? 0 : 120);
    }
}

const courseSearch = document.getElementById('course-search');
courseSearch?.addEventListener('input', event => renderCourseSearchResults(event.target.value));
courseSearch?.addEventListener('focus', event => renderCourseSearchResults(event.target.value));

document.addEventListener('click', event => {
    const searchPanel = document.querySelector('.course-search-panel');
    if (searchPanel && !searchPanel.contains(event.target)) {
        const results = document.getElementById('course-search-results');
        if (results) results.hidden = true;
    }
});

/* ==========================================================
   VISIONNEUSE DE DOCUMENTS
========================================================== */
function getDocumentViewer(prefix = '') {
    return {
        viewerContainer: document.getElementById(`${prefix}viewer-container`),
        pdfFrame: document.getElementById(`${prefix}pdf-frame`),
        imgViewer: document.getElementById(`${prefix}img-viewer`),
        odtViewer: document.getElementById(`${prefix}odt-viewer`),
        pdfFileName: document.getElementById(`${prefix}pdf-file-name`),
        pdfExternalLink: document.getElementById(`${prefix}pdf-external-link`),
        odtDownloadLink: document.getElementById(`${prefix}odt-download-link`)
    };
}

function openDocumentViewer(title, url, documentId = '', prefix = '') {
    const { viewerContainer, pdfFrame, imgViewer, odtViewer, pdfFileName, pdfExternalLink, odtDownloadLink } = getDocumentViewer(prefix);
    if (!viewerContainer || !pdfFrame || !imgViewer || !odtViewer) return;
    if (!safeResourceUrl(url)) {
        showToast('Adresse de document invalide.');
        return;
    }

    if (pdfFileName) pdfFileName.innerHTML = `<i class="fa-solid fa-file"></i> ${escapeHtmlAttribute(title)}`;
    if (pdfExternalLink) { pdfExternalLink.href = url; pdfExternalLink.dataset.documentId = String(documentId || ''); }

    pdfFrame.hidden = true;
    imgViewer.hidden = true;
    odtViewer.hidden = true;
    pdfFrame.src = '';
    imgViewer.src = '';

    const cleanUrl = url.split('?')[0];
    const ext = cleanUrl.includes('.') ? cleanUrl.split('.').pop().toLowerCase() : '';

    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
        imgViewer.src = url;
        imgViewer.alt = title;
        imgViewer.hidden = false;
    } else if (['odt', 'docx', 'doc'].includes(ext)) {
        if (odtDownloadLink) { odtDownloadLink.href = url; odtDownloadLink.dataset.documentId = String(documentId || ''); }
        odtViewer.hidden = false;
    } else {
        pdfFrame.src = url;
        pdfFrame.hidden = false;
    }

    viewerContainer.hidden = false;
    viewerContainer.scrollIntoView({ behavior: motionReduced ? 'auto' : 'smooth', block: 'nearest' });
}

function closeDocumentViewer(prefix = '') {
    const { viewerContainer, pdfFrame, imgViewer } = getDocumentViewer(prefix);
    if (viewerContainer) viewerContainer.hidden = true;
    if (pdfFrame) pdfFrame.src = '';
    if (imgViewer) imgViewer.src = '';
}

function openPdf(title, url, documentId = '') { openDocumentViewer(title, url, documentId, ''); }
function closePdf() { closeDocumentViewer(''); }
function openResourcePdf(title, url, documentId = '') { openDocumentViewer(title, url, documentId, 'resource-'); }
function closeResourcePdf() { closeDocumentViewer('resource-'); }

window.selectSubject = selectSubject;
window.switchMainCourseTab = switchMainCourseTab;
window.switchSubjectTab = switchSubjectTab;
window.switchExerciseTab = switchExerciseTab;
window.openCourseSearchResult = openCourseSearchResult;
window.openPdf = openPdf;
window.closePdf = closePdf;
window.openResourcePdf = openResourcePdf;
window.closeResourcePdf = closeResourcePdf;

/* ==========================================================
   CONTACTS / TOAST
========================================================== */
async function copyToClipboard(text, message = 'Copié dans le presse-papiers !') {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
        }
        showToast(message);
    } catch (error) {
        console.error('Erreur lors de la copie :', error);
        showToast('Impossible de copier automatiquement');
    }
}

function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const label = toast.querySelector('span');
    if (label) label.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2400);
}

window.copyToClipboard = copyToClipboard;

/* ==========================================================
   MODALE PROFIL
========================================================== */
function openProfileModal() {
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    modal.classList.add('active');
    setBodyModalState();
    modal.querySelector('.modal-close-btn')?.focus();
}

function closeProfileModal(event) {
    if (event && !isRealModalBackdropClick(event)) return;
    document.getElementById('profileModal')?.classList.remove('active');
    setBodyModalState();
}

window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;

/* ==========================================================
   STATS
========================================================== */
function updateStats() {
    const lessonCount = myCourses.reduce((sum, subject) => sum + subject.lessons.length, 0);
    const statementCount = myCourses.reduce((sum, subject) => sum + subject.exercise_statements.length, 0);
    const correctionCount = myCourses.reduce((sum, subject) => sum + subject.exercise_corrections.length, 0);
    const exerciseCount = statementCount + correctionCount;
    const sheetCount = myCourses.reduce((sum, subject) => sum + subject.sheets.length, 0);
    const resourceCount = globalResources.length;
    const documentCount = lessonCount + exerciseCount + sheetCount + resourceCount;
    const availableCount = myProjects.filter(project => projectStatus(project) === 'available').length;
    const developmentCount = myProjects.filter(project => projectStatus(project) === 'development').length;

    const values = {
        'stat-projects': myProjects.length,
        'stat-documents': documentCount,
        'study-subject-count': myCourses.length,
        'study-lesson-count': lessonCount,
        'study-exercise-count': exerciseCount,
        'study-statement-count': statementCount,
        'study-correction-count': correctionCount,
        'study-sheet-count': sheetCount,
        'study-resource-count': resourceCount
    };

    Object.entries(values).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    });

    const availableInline = document.getElementById('stat-available-inline');
    const developmentInline = document.getElementById('stat-development-inline');
    if (availableInline) availableInline.textContent = `${availableCount} disponible${availableCount === 1 ? '' : 's'}`;
    if (developmentInline) developmentInline.textContent = `${developmentCount} en développement`;
    renderServiceAvailabilityStat();
}

/* ==========================================================
   TEXTE ROTATIF DU HERO
========================================================== */
const rotatingMessages = [
    'Explorer de nouvelles idées',
    "Apprendre en créant",
    "Donner vie à des projets",
    'Expérimenter pour progresser'
];

function buildRotatingLetters(element, text) {
    if (!element) return;
    element.replaceChildren(...[...String(text)].map((char, index) => {
        const span = document.createElement('span');
        span.className = char === ' ' ? 'rot-char rot-space' : 'rot-char';
        span.style.setProperty('--char-index', index);
        span.textContent = char === ' ' ? '\u00A0' : char;
        return span;
    }));
}

function startRotatingText() {
    const current = document.getElementById('rotating-text');
    const next = document.getElementById('rotating-text-next');
    const shell = current?.closest('.rotating-text-shell');
    if (!current || !next || !shell) return;

    let index = Math.max(0, rotatingMessages.indexOf(current.textContent.trim()));
    let animating = false;
    const DURATION = 820;

    buildRotatingLetters(current, rotatingMessages[index]);

    const switchLabel = () => {
        if (animating) return;
        const nextIndex = (index + 1) % rotatingMessages.length;
        const nextText = rotatingMessages[nextIndex];

        if (motionReduced) {
            index = nextIndex;
            buildRotatingLetters(current, nextText);
            next.replaceChildren();
            return;
        }

        animating = true;
        buildRotatingLetters(next, nextText);
        shell.style.setProperty('--current-chars', current.querySelectorAll('.rot-char').length);
        shell.style.setProperty('--next-chars', next.querySelectorAll('.rot-char').length);
        void shell.offsetWidth;
        shell.classList.add('changing');

        window.setTimeout(() => {
            index = nextIndex;
            buildRotatingLetters(current, nextText);
            next.replaceChildren();
            shell.classList.remove('changing');
            animating = false;
        }, DURATION);
    };

    window.setInterval(switchLabel, 3800);
}

/* ==========================================================
   COULEUR D'ACCENT
========================================================== */
const themePresets = {
    blue: { color: '#3b82f6', hover: '#2563eb', rgb: '59, 130, 246' },
    violet: { color: '#8b5cf6', hover: '#7c3aed', rgb: '139, 92, 246' },
    green: { color: '#22c55e', hover: '#16a34a', rgb: '34, 197, 94' },
    pink: { color: '#ec4899', hover: '#db2777', rgb: '236, 72, 153' }
};

function applyTheme(name, persist = true) {
    const themeName = themePresets[name] ? name : 'blue';
    const theme = themePresets[themeName];
    const root = document.documentElement;

    root.style.setProperty('--accent-color', theme.color);
    root.style.setProperty('--accent-hover', theme.hover);
    root.style.setProperty('--accent-rgb', theme.rgb);
    root.style.setProperty('--accent-soft', `rgba(${theme.rgb}, 0.14)`);

    document.querySelectorAll('.theme-swatch').forEach(swatch => {
        swatch.classList.toggle('active', swatch.dataset.theme === themeName);
    });

    if (persist) localStorage.setItem('portfolio-accent-theme', themeName);
    if (motionReduced) drawStaticParticles();
}

const themePickerBtn = document.getElementById('theme-picker-btn');
const themePopover = document.getElementById('theme-popover');

themePickerBtn?.addEventListener('click', event => {
    event.stopPropagation();
    const open = themePopover?.classList.toggle('open') || false;
    themePickerBtn.setAttribute('aria-expanded', String(open));
});

document.querySelectorAll('.theme-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
        applyTheme(swatch.dataset.theme);
        themePopover?.classList.remove('open');
        themePickerBtn?.setAttribute('aria-expanded', 'false');
    });
});

document.addEventListener('click', event => {
    if (!event.target.closest('.theme-wrapper')) {
        themePopover?.classList.remove('open');
        themePickerBtn?.setAttribute('aria-expanded', 'false');
    }
});

/* ==========================================================
   ANIMATIONS / ACCESSIBILITÉ
========================================================== */
function setMotionReduced(reduced, persist = true) {
    motionReduced = Boolean(reduced);
    document.body.classList.toggle('reduce-motion', motionReduced);

    const button = document.getElementById('motion-toggle');
    if (button) {
        button.innerHTML = motionReduced
            ? '<i class="fa-solid fa-play"></i>'
            : '<i class="fa-solid fa-wand-magic-sparkles"></i>';
        button.dataset.tooltip = motionReduced ? 'Réactiver les animations' : 'Réduire les animations';
        button.setAttribute('aria-label', button.dataset.tooltip);
    }

    if (persist) localStorage.setItem('portfolio-reduced-motion', motionReduced ? '1' : '0');

    if (motionReduced) {
        stopParticles();
        drawStaticParticles();
    } else {
        startParticles();
    }

    refreshRevealElements();
}

document.getElementById('motion-toggle')?.addEventListener('click', () => setMotionReduced(!motionReduced));

function initRevealObserver() {
    revealObserver?.disconnect();

    if (motionReduced || !('IntersectionObserver' in window)) {
        document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));
        return;
    }

    revealObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                revealObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.08, rootMargin: '0px 0px -20px 0px' });

    document.querySelectorAll('.page-section.active .reveal').forEach(element => {
        if (!element.classList.contains('is-visible')) revealObserver.observe(element);
    });
}

function refreshRevealElements() {
    window.requestAnimationFrame(initRevealObserver);
}

/* ==========================================================
   PARTICULES
========================================================== */
const canvas = document.getElementById('particles-canvas');
const ctx = canvas?.getContext('2d');
let particlesArray = [];

class Particle {
    constructor() {
        this.reset(true);
    }

    reset(randomY = false) {
        this.x = Math.random() * window.innerWidth;
        this.y = randomY ? Math.random() * window.innerHeight : window.innerHeight + 5;
        this.size = Math.random() * 1.7 + 0.45;
        this.speedX = Math.random() * 0.45 - 0.225;
        this.speedY = Math.random() * 0.45 - 0.225;
    }

    update() {
        this.x += this.speedX;
        this.y += this.speedY;
        if (this.x > window.innerWidth + 10) this.x = -10;
        if (this.x < -10) this.x = window.innerWidth + 10;
        if (this.y > window.innerHeight + 10) this.y = -10;
        if (this.y < -10) this.y = window.innerHeight + 10;
    }

    draw() {
        if (!ctx) return;
        const rgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '59, 130, 246';
        ctx.fillStyle = `rgba(${rgb}, 0.38)`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
    }
}

function resizeCanvas() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    initParticles();
    if (motionReduced) drawStaticParticles();
}

function initParticles() {
    if (!canvas) return;
    const area = window.innerWidth * window.innerHeight;
    const count = Math.max(30, Math.min(95, Math.round(area / 19000)));
    particlesArray = Array.from({ length: count }, () => new Particle());
}

function drawConnections() {
    if (!ctx) return;
    const rgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '59, 130, 246';

    for (let i = 0; i < particlesArray.length; i++) {
        for (let j = i + 1; j < particlesArray.length; j++) {
            const dx = particlesArray[i].x - particlesArray[j].x;
            const dy = particlesArray[i].y - particlesArray[j].y;
            const distanceSquared = dx * dx + dy * dy;

            if (distanceSquared < 9000) {
                const distance = Math.sqrt(distanceSquared);
                const alpha = Math.max(0, 0.13 - distance / 900);
                ctx.beginPath();
                ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
                ctx.lineWidth = 0.55;
                ctx.moveTo(particlesArray[i].x, particlesArray[i].y);
                ctx.lineTo(particlesArray[j].x, particlesArray[j].y);
                ctx.stroke();
            }
        }
    }
}

function drawStaticParticles() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particlesArray.forEach(particle => particle.draw());
}

function animateParticles() {
    if (!ctx || !canvas || motionReduced) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particlesArray.forEach(particle => {
        particle.update();
        particle.draw();
    });
    drawConnections();
    animationFrameId = window.requestAnimationFrame(animateParticles);
}

function startParticles() {
    if (!ctx || motionReduced || animationFrameId !== null) return;
    animationFrameId = window.requestAnimationFrame(animateParticles);
}

function stopParticles() {
    if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
}

window.addEventListener('resize', resizeCanvas, { passive: true });
document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopParticles();
    else if (!motionReduced) startParticles();
});


/* ==========================================================
   SUPABASE : ACCÈS AUX DONNÉES ET CHARGEMENT PUBLIC
========================================================== */
function isSupabaseConfigured() {
    return Boolean(
        SUPABASE_CONFIG.url &&
        SUPABASE_CONFIG.publishableKey &&
        SUPABASE_CONFIG.adminEmail &&
        !SUPABASE_CONFIG.url.startsWith('VOTRE_') &&
        !SUPABASE_CONFIG.publishableKey.startsWith('VOTRE_') &&
        !SUPABASE_CONFIG.adminEmail.startsWith('VOTRE_')
    );
}

function initSupabaseClient() {
    if (!isSupabaseConfigured() || !window.supabase?.createClient) return false;
    if (!supabaseClient) {
        supabaseClient = window.supabase.createClient(
            SUPABASE_CONFIG.url,
            SUPABASE_CONFIG.publishableKey,
            {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true
                }
            }
        );
    }
    return true;
}

// Point d'accès partagé pour les modules additionnels (forum, comptes, communauté).
window.getSiteSupabase = () => {
    initSupabaseClient();
    return supabaseClient;
};

async function fetchContentTables({ publishedOnly = false } = {}) {
    if (!supabaseClient) throw new Error('Client Supabase indisponible.');

    let subjectsQuery = supabaseClient.from('subjects').select('*');
    let documentsQuery = supabaseClient.from('documents').select('*');
    let infosQuery = supabaseClient.from('info_blocks').select('*');
    let projectsQuery = supabaseClient.from('projects').select('*');

    if (publishedOnly) {
        subjectsQuery = subjectsQuery.eq('is_published', true);
        documentsQuery = documentsQuery.eq('is_published', true);
        infosQuery = infosQuery.eq('is_published', true);
        projectsQuery = projectsQuery.eq('is_published', true);
    }

    const [subjects, documents, infos, projects] = await Promise.all([
        subjectsQuery.order('sort_order').order('name'),
        documentsQuery.order('sort_order').order('title'),
        infosQuery.order('sort_order').order('id'),
        projectsQuery.order('sort_order').order('name')
    ]);

    const firstError = [subjects, documents, infos, projects].find(result => result.error)?.error;
    if (firstError) throw firstError;

    return {
        subjects: subjects.data || [],
        documents: documents.data || [],
        infos: infos.data || [],
        projects: projects.data || []
    };
}

async function saveDbRecord(table, payload, id = null) {
    if (!supabaseClient) throw new Error('Client Supabase indisponible.');
    const result = id !== null && id !== undefined && id !== ''
        ? await supabaseClient.from(table).update(payload).eq('id', id)
        : await supabaseClient.from(table).insert(payload);
    if (result.error) throw result.error;
    return result.data;
}

async function deleteDbRecord(table, id) {
    if (!supabaseClient) throw new Error('Client Supabase indisponible.');
    const { error } = await supabaseClient.from(table).delete().eq('id', id);
    if (error) throw error;
}

function clearRuntimeContent() {
    myProjects = [];
    generalInfo = [];
    myCourses = [];
    globalResources = [];
}

function mapProjectRow(row) {
    return {
        _dbId: row.id,
        name: row.name || '',
        logoUrl: row.logo_url || '',
        logoStoragePath: row.logo_storage_path || '',
        icon: row.icon || 'fa-solid fa-laptop-code',
        category: row.category || 'application',
        status: row.status || (row.app_url ? 'available' : 'development'),
        tags: Array.isArray(row.tags) ? row.tags : [],
        description: row.description || '',
        features: Array.isArray(row.features) ? row.features : [],
        appUrl: row.app_url || '',
        devUrl: row.dev_url || '',
        sortOrder: Number(row.sort_order || 0)
    };
}

function mapInfoRow(row) {
    return {
        _dbId: row.id,
        section: row.section === 'projects' ? 'projects' : 'studies',
        icon: row.icon || 'fa-solid fa-circle-info',
        title: row.title || '',
        text: row.text || '',
        imageUrl: row.image_url || '',
        imageStoragePath: row.image_storage_path || '',
        attachmentUrl: row.attachment_url || '',
        attachmentStoragePath: row.attachment_storage_path || '',
        attachmentName: row.attachment_name || '',
        attachmentMime: row.attachment_mime || '',
        publishAt: row.publish_at || '',
        sortOrder: Number(row.sort_order || 0),
        isPublished: row.is_published !== false,
        createdAt: row.created_at || '',
        publishedAt: row.first_published_at || row.publish_at || row.created_at || ''
    };
}

function mapStudyDocument(row) {
    return {
        _dbId: row.id,
        title: row.title || 'Document',
        url: row.url || '',
        storagePath: row.storage_path || '',
        fileName: row.file_name || '',
        type: normalizeStudyDocumentType(row.type || 'lessons'),
        subjectId: row.subject_id || '',
        sortOrder: Number(row.sort_order || 0)
    };
}

function normalizeStudyDocumentType(type) {
    return type === 'exercises' ? 'exercise_statements' : type;
}

function buildCoursesFromRows(subjectRows, documentRows) {
    return subjectRows.map(subject => {
        const course = {
            _dbId: subject.id,
            id: subject.id,
            name: subject.name || subject.id,
            icon: subject.icon || 'fa-solid fa-book',
            sortOrder: Number(subject.sort_order || 0),
            lessons: [],
            exercise_statements: [],
            exercise_corrections: [],
            sheets: []
        };

        documentRows
            .filter(doc => doc.subject_id === subject.id && normalizeStudyDocumentType(doc.type) !== 'resources')
            .forEach(doc => {
                const type = normalizeStudyDocumentType(doc.type);
                const validType = ['lessons', 'exercise_statements', 'exercise_corrections', 'sheets'].includes(type) ? type : 'lessons';
                course[validType].push(mapStudyDocument(doc));
            });

        ['lessons', 'exercise_statements', 'exercise_corrections', 'sheets'].forEach(type => {
            course[type].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, 'fr'));
        });
        return course;
    });
}

function buildGlobalResources(documentRows) {
    return documentRows
        .filter(doc => normalizeStudyDocumentType(doc.type) === 'resources')
        .map(mapStudyDocument)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, 'fr'));
}

async function loadPortfolioSettings() {
    if (!supabaseClient) return portfolioSettings;
    try {
        const { data, error } = await supabaseClient.from('portfolio_settings')
            .select('services_available,services_status_text,profile_image_url,profile_image_storage_path')
            .eq('id', 1)
            .maybeSingle();
        if (error) throw error;
        if (data) {
            portfolioSettings = {
                servicesAvailable: data.services_available !== false,
                servicesStatusText: String(data.services_status_text || '').trim() || (data.services_available === false ? 'Services indisponibles temporairement' : 'Services disponibles actuellement'),
                profileImageUrl: String(data.profile_image_url || '').trim(),
                profileImageStoragePath: String(data.profile_image_storage_path || '').trim()
            };
            applyPortfolioProfileImage();
        }
    } catch (error) {
        console.warn('Paramètres du portfolio indisponibles :', error?.message || error);
    }
    return portfolioSettings;
}

function renderServiceAvailabilityStat() {
    const card = document.getElementById('stat-services');
    const status = document.getElementById('stat-services-status');
    const note = document.getElementById('stat-services-note');
    const available = portfolioSettings.servicesAvailable !== false;
    if (card) {
        card.classList.toggle('is-available', available);
        card.classList.toggle('is-unavailable', !available);
    }
    if (status) status.textContent = available ? 'Services disponibles' : 'Services indisponibles';
    if (note) note.textContent = portfolioSettings.servicesStatusText || (available ? 'Services disponibles actuellement' : 'Services indisponibles temporairement');
}

async function processDueSiteInfoPublications() {
    if (!supabaseClient) return 0;
    try {
        const { data, error } = await supabaseClient.rpc('process_due_site_info_publications');
        if (error) {
            if (!String(error.message || '').includes('process_due_site_info_publications')) console.warn('Publications programmées :', error);
            return 0;
        }
        return Number(data || 0);
    } catch (error) {
        console.warn('Publications programmées :', error);
        return 0;
    }
}

async function refreshRemoteContentIfStale(maxAgeMs = 60000) {
    if (Date.now() - lastRemoteContentLoadAt < maxAgeMs) return false;
    const loaded = await loadRemoteContent();
    if (loaded) refreshDynamicContent();
    return loaded;
}

async function loadRemoteContent() {
    publicContentLoadError = null;
    const hasPreviousContent = myProjects.length > 0 || generalInfo.length > 0 || myCourses.length > 0 || globalResources.length > 0;

    if (!initSupabaseClient()) {
        if (!hasPreviousContent) clearRuntimeContent();
        publicContentLoadError = new Error('Supabase n’est pas configuré.');
        return false;
    }

    try {
        await processDueSiteInfoPublications();
        const content = await fetchContentTables({ publishedOnly: true });
        myCourses = buildCoursesFromRows(content.subjects, content.documents);
        globalResources = buildGlobalResources(content.documents);
        generalInfo = content.infos.map(mapInfoRow);
        myProjects = content.projects.map(mapProjectRow);
        currentSubjectIndex = Math.min(currentSubjectIndex, Math.max(0, myCourses.length - 1));
        lastRemoteContentLoadAt = Date.now();
        return true;
    } catch (error) {
        console.error('Impossible de charger le contenu Supabase :', error);
        if (!hasPreviousContent) clearRuntimeContent();
        publicContentLoadError = error;
        return false;
    }
}

function refreshDynamicContent() {
    courseSearchEntries = getCourseSearchEntries();
    renderProjects();
    renderProjectInfo();
    renderGeneralInfo();
    renderSubjects();
    renderGlobalResources();
    updateStats();
    refreshInfoSubscriptionButtons().catch(console.warn);
}

/* ==========================================================
   ADMINISTRATION : UI / AUTHENTIFICATION
========================================================== */
const adminModal = document.getElementById('adminModal');
const adminLoginView = document.getElementById('admin-login-view');
const adminDashboard = document.getElementById('admin-dashboard');

function setAdminStatus(message = '', type = '') {
    const element = document.getElementById('admin-operation-status');
    if (!element) return;
    element.textContent = message;
    element.className = `admin-operation-status ${type}`.trim();
}

function setAdminBusy(isBusy, message = '') {
    adminBusy = isBusy;
    document.querySelectorAll('#adminModal button, #adminModal input, #adminModal select, #adminModal textarea').forEach(element => {
        if (element.id === 'admin-close-btn') return;
        element.disabled = isBusy;
    });
    if (message) setAdminStatus(message, 'working');
}

async function verifyAdminAccessMode() {
    if (!supabaseClient) return 'none';
    const [{ data: isAdmin, error: adminError }, { data: isModerator, error: moderatorError }] = await Promise.all([
        supabaseClient.rpc('is_site_admin'),
        supabaseClient.rpc('is_forum_moderator')
    ]);
    if (adminError) console.warn('Vérification administrateur :', adminError);
    if (moderatorError) console.warn('Vérification modérateur :', moderatorError);
    if (isAdmin === true) return 'admin';
    if (isModerator === true) return 'moderator';
    return 'none';
}

function applyAdminAccessMode() {
    const moderatorOnly = adminAccessMode === 'moderator';
    document.querySelectorAll('.admin-tab').forEach(button => {
        button.hidden = moderatorOnly && button.dataset.adminTab !== 'infos';
    });
    const logoutButton = document.getElementById('admin-logout-btn');
    if (logoutButton) logoutButton.hidden = moderatorOnly;

    if (moderatorOnly) {
        switchAdminTab('infos');
    } else {
        const active = document.querySelector('.admin-tab.active:not([hidden])');
        if (!active) switchAdminTab('documents');
    }
}

async function openAdminModal() {
    if (!adminModal) return;
    adminModal.classList.add('active');
    setBodyModalState();
    const configured = isSupabaseConfigured();
    const warning = document.getElementById('admin-config-warning');
    if (warning) warning.hidden = configured;

    if (initSupabaseClient()) {
        try {
            const { data } = await supabaseClient.auth.getSession();
            const mode = data?.session ? await verifyAdminAccessMode() : 'none';

            if (mode === 'none') {
                adminAuthenticated = false;
                adminAccessMode = 'none';
                adminCache = { subjects: [], documents: [], infos: [], projects: [] };
            } else {
                const accessChanged = !adminAuthenticated || adminAccessMode !== mode;
                adminAccessMode = mode;
                adminAuthenticated = true;
                if (accessChanged || !adminCache.infos.length) await loadAdminCache();
            }
        } catch (error) {
            adminAuthenticated = false;
            adminAccessMode = 'none';
            console.warn('Vérification de la session de gestion impossible :', error);
        }
    }

    if (adminAuthenticated) showAdminDashboard();
    else {
        adminLoginView.hidden = false;
        adminDashboard.hidden = true;
        window.setTimeout(() => document.getElementById('admin-password')?.focus(), 50);
    }
}

function closeAdminModal(event) {
    if (event && !isRealModalBackdropClick(event)) return;
    adminModal?.classList.remove('active');
    setBodyModalState();
}

function showAdminDashboard() {
    adminLoginView.hidden = true;
    adminDashboard.hidden = false;
    const label = document.getElementById('admin-session-label');
    if (label) {
        label.textContent = adminAccessMode === 'moderator'
            ? 'Session modérateur — gestion des informations'
            : `Connecté en tant qu’administrateur — ${SUPABASE_CONFIG.adminEmail}`;
    }
    applyAdminAccessMode();
    renderAdminAll();
}

async function verifyAdminRole() {
    return (await verifyAdminAccessMode()) === 'admin';
}

async function handleAdminLogin(event) {
    event.preventDefault();
    const errorLabel = document.getElementById('admin-login-error');
    const password = document.getElementById('admin-password')?.value || '';
    if (errorLabel) errorLabel.hidden = true;

    if (!initSupabaseClient()) {
        if (errorLabel) {
            errorLabel.textContent = 'Configurez d’abord Supabase dans script.js.';
            errorLabel.hidden = false;
        }
        return;
    }

    try {
        setAdminBusy(true, 'Connexion sécurisée…');
        const { error } = await supabaseClient.auth.signInWithPassword({
            email: SUPABASE_CONFIG.adminEmail,
            password
        });
        if (error) throw error;

        const isAdmin = await verifyAdminRole();
        if (!isAdmin) {
            await supabaseClient.auth.signOut();
            throw new Error('Ce compte n’est pas autorisé à administrer ce site.');
        }

        adminAccessMode = 'admin';
        adminAuthenticated = true;
        document.getElementById('admin-password').value = '';
        await loadAdminCache();
        showAdminDashboard();
        setAdminStatus('Connexion réussie.', 'success');
    } catch (error) {
        console.error(error);
        if (errorLabel) {
            errorLabel.textContent = error?.message?.includes('Invalid login credentials')
                ? 'Mot de passe incorrect.'
                : (error?.message || 'Connexion impossible.');
            errorLabel.hidden = false;
        }
    } finally {
        setAdminBusy(false);
    }
}

async function logoutAdmin() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    adminAuthenticated = false;
    adminAccessMode = 'none';
    adminCache = { subjects: [], documents: [], infos: [], projects: [] };
    document.querySelectorAll('.admin-tab').forEach(button => button.hidden = false);
    const logoutButton = document.getElementById('admin-logout-btn');
    if (logoutButton) logoutButton.hidden = false;
    adminDashboard.hidden = true;
    adminLoginView.hidden = false;
    setAdminStatus('');
    document.getElementById('admin-password')?.focus();
}

function switchAdminTab(tabName) {
    if (adminAccessMode === 'moderator' && tabName !== 'infos') tabName = 'infos';
    document.querySelectorAll('.admin-tab').forEach(button => button.classList.toggle('active', button.dataset.adminTab === tabName));
    document.querySelectorAll('.admin-panel').forEach(panel => {
        const active = panel.id === `admin-panel-${tabName}`;
        panel.hidden = !active;
        panel.classList.toggle('active', active);
    });
}

async function loadAdminCache() {
    if (!adminAuthenticated || !supabaseClient) return;

    if (adminAccessMode === 'moderator') {
        const { data, error } = await supabaseClient.from('info_blocks').select('*').order('sort_order').order('id');
        if (error) throw error;
        adminCache = { subjects: [], documents: [], infos: data || [], projects: [] };
        return;
    }

    const [content] = await Promise.all([
        fetchContentTables({ publishedOnly: false }),
        loadPortfolioSettings()
    ]);
    adminCache = content;
}

function renderAdminAll() {
    if (!adminAuthenticated) return;
    if (adminAccessMode === 'moderator') {
        renderAdminInfos();
        return;
    }
    renderAdminSubjects();
    renderAdminDocuments();
    renderAdminInfos();
    renderAdminProjects();
    renderAdminServices();
    renderAdminStorage();
    populateAdminSubjectSelect();
}

function adminPublishedBadge(published) {
    return published
        ? '<span class="admin-badge published" data-tooltip="Visible par les visiteurs"><i class="fa-solid fa-eye"></i> Visible</span>'
        : '<span class="admin-badge draft" data-tooltip="Masqué aux visiteurs"><i class="fa-solid fa-eye-slash"></i> Masqué</span>';
}

function adminInfoPublicationBadge(info) {
    if (info?.is_published === false) return adminPublishedBadge(false);
    const publishAt = info?.publish_at ? new Date(info.publish_at) : null;
    if (publishAt && Number.isFinite(publishAt.getTime()) && publishAt.getTime() > Date.now()) {
        return `<span class="admin-badge scheduled" data-tooltip="Publication programmée"><i class="fa-regular fa-clock"></i> ${escapeHtmlAttribute(publishAt.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }))}</span>`;
    }
    return adminPublishedBadge(true);
}

function populateAdminSubjectSelect() {
    const select = document.getElementById('admin-doc-subject');
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">Aucune matière — ressource générale</option>` + adminCache.subjects.map(subject => `<option value="${escapeHtmlAttribute(subject.id)}">${escapeHtmlAttribute(subject.name)}</option>`).join('');
    if (current === '' || adminCache.subjects.some(subject => subject.id === current)) select.value = current;
}

function syncAdminDocumentSubjectField() {
    const type = normalizeStudyDocumentType(document.getElementById('admin-doc-type')?.value || 'lessons');
    const select = document.getElementById('admin-doc-subject');
    if (!select) return;
    const field = select.closest('.field');
    const isGlobalResource = type === 'resources';

    if (isGlobalResource) {
        select.value = '';
        select.disabled = true;
        select.required = false;
        field?.classList.add('field-muted');
    } else {
        select.disabled = false;
        select.required = true;
        field?.classList.remove('field-muted');
        if (!select.value && adminCache.subjects[0]) select.value = adminCache.subjects[0].id;
    }
}

function renderAdminDocuments() {
    const container = document.getElementById('admin-document-list');
    if (!container) return;
    const term = normalizeText(document.getElementById('admin-document-search')?.value || '');
    const subjectsById = Object.fromEntries(adminCache.subjects.map(subject => [subject.id, subject.name]));
    const rows = adminCache.documents.filter(doc => !term || normalizeText(`${doc.title} ${doc.type === 'resources' ? 'ressources générales' : (subjectsById[doc.subject_id] || '')} ${courseTypeLabels[doc.type] || doc.type}`).includes(term));
    if (!rows.length) {
        container.innerHTML = '<div class="admin-empty"><i class="fa-regular fa-folder-open"></i><p>Aucun document.</p></div>';
        return;
    }
    container.innerHTML = rows.map(doc => `
        <article class="admin-row">
            <div class="admin-row-icon"><i class="fa-regular fa-file-lines"></i></div>
            <div class="admin-row-main"><strong>${escapeHtmlAttribute(doc.title)}</strong><span>${escapeHtmlAttribute(doc.type === 'resources' ? 'Ressources générales' : (subjectsById[doc.subject_id] || doc.subject_id || 'Sans matière'))} · ${courseTypeLabels[doc.type] || 'Document'}</span></div>
            ${adminPublishedBadge(doc.is_published)}
            <div class="admin-row-actions"><button type="button" class="icon-btn" onclick="editAdminDocument(${doc.id})" data-tooltip="Modifier" aria-label="Modifier"><i class="fa-solid fa-pen"></i></button><button type="button" class="icon-btn danger-btn" onclick="deleteAdminDocument(${doc.id})" data-tooltip="Supprimer" aria-label="Supprimer"><i class="fa-solid fa-trash"></i></button></div>
        </article>`).join('');
}

function renderAdminSubjects() {
    const container = document.getElementById('admin-subject-list');
    if (!container) return;
    if (!adminCache.subjects.length) {
        container.innerHTML = '<div class="admin-empty"><i class="fa-solid fa-layer-group"></i><p>Aucune matière.</p></div>';
        return;
    }
    container.innerHTML = adminCache.subjects.map(subject => {
        const count = adminCache.documents.filter(doc => doc.subject_id === subject.id).length;
        return `
        <article class="admin-row">
            <div class="admin-row-icon"><i class="${escapeHtmlAttribute(subject.icon || 'fa-solid fa-book')}"></i></div>
            <div class="admin-row-main"><strong>${escapeHtmlAttribute(subject.name)}</strong><span>${count} document${count > 1 ? 's' : ''} · identifiant : ${escapeHtmlAttribute(subject.id)}</span></div>
            ${adminPublishedBadge(subject.is_published)}
            <div class="admin-row-actions"><button type="button" class="icon-btn" onclick="editAdminSubject('${escapeHtmlAttribute(subject.id)}')" data-tooltip="Modifier" aria-label="Modifier"><i class="fa-solid fa-pen"></i></button><button type="button" class="icon-btn danger-btn" onclick="deleteAdminSubject('${escapeHtmlAttribute(subject.id)}')" data-tooltip="Supprimer" aria-label="Supprimer"><i class="fa-solid fa-trash"></i></button></div>
        </article>`;
    }).join('');
}

function renderAdminInfos() {
    const container = document.getElementById('admin-info-list');
    if (!container) return;

    const rows = adminCache.infos.filter(info => adminInfoFilter === 'all' || (info.section || 'studies') === adminInfoFilter);
    if (!rows.length) {
        container.innerHTML = '<div class="admin-empty"><i class="fa-regular fa-message"></i><p>Aucune information dans cette rubrique.</p></div>';
        return;
    }

    container.innerHTML = rows.map(info => {
        const section = info.section === 'projects' ? 'projects' : 'studies';
        const sectionLabel = section === 'projects' ? 'Projets' : 'Études';
        const sectionIcon = section === 'projects' ? 'fa-solid fa-laptop-code' : 'fa-solid fa-graduation-cap';
        return `
        <article class="admin-row">
            <div class="admin-row-icon"><i class="${escapeHtmlAttribute(info.icon || 'fa-solid fa-circle-info')}"></i></div>
            <div class="admin-row-main">
                <strong>${escapeHtmlAttribute(info.title)}</strong>
                <span>${escapeHtmlAttribute((info.text || '').slice(0, 120))}${(info.text || '').length > 120 ? '…' : ''}</span>
            </div>
            <span class="admin-info-scope-badge ${section}"><i class="${sectionIcon}"></i> ${sectionLabel}</span>
            ${adminInfoPublicationBadge(info)}
            <div class="admin-row-actions"><button type="button" class="icon-btn" onclick="editAdminInfo(${info.id})" data-tooltip="Modifier" aria-label="Modifier"><i class="fa-solid fa-pen"></i></button><button type="button" class="icon-btn danger-btn" onclick="deleteAdminInfo(${info.id})" data-tooltip="Supprimer" aria-label="Supprimer"><i class="fa-solid fa-trash"></i></button></div>
        </article>`;
    }).join('');
}

function renderAdminProjects() {
    const container = document.getElementById('admin-project-list');
    if (!container) return;
    const term = normalizeText(document.getElementById('admin-project-search')?.value || '');
    const rows = adminCache.projects.filter(project => !term || normalizeText(`${project.name} ${project.description} ${(project.tags || []).join(' ')}`).includes(term));
    if (!rows.length) {
        container.innerHTML = '<div class="admin-empty"><i class="fa-solid fa-laptop-code"></i><p>Aucune application.</p></div>';
        return;
    }
    container.innerHTML = rows.map(project => {
        const logo = project.logo_url ? `<img src="${escapeHtmlAttribute(project.logo_url)}" alt="">` : `<i class="${escapeHtmlAttribute(project.icon || 'fa-solid fa-laptop-code')}"></i>`;
        return `
        <article class="admin-row">
            <div class="admin-row-icon project-icon">${logo}</div>
            <div class="admin-row-main"><strong>${escapeHtmlAttribute(project.name)}</strong><span>${categoryLabels[project.category] || 'Projet'} · ${projectStatusLabels[project.status] || 'Projet'}</span></div>
            ${adminPublishedBadge(project.is_published)}
            <div class="admin-row-actions"><button type="button" class="icon-btn" onclick="editAdminProject(${project.id})" data-tooltip="Modifier" aria-label="Modifier"><i class="fa-solid fa-pen"></i></button><button type="button" class="icon-btn danger-btn" onclick="deleteAdminProject(${project.id})" data-tooltip="Supprimer" aria-label="Supprimer"><i class="fa-solid fa-trash"></i></button></div>
        </article>`;
    }).join('');
}

function renderAdminServices() {
    const select = document.getElementById('admin-services-available');
    const input = document.getElementById('admin-services-status-text');
    const preview = document.getElementById('admin-services-preview');
    const previewTitle = document.getElementById('admin-services-preview-title');
    const previewText = document.getElementById('admin-services-preview-text');
    if (!select || !input) return;
    const available = portfolioSettings.servicesAvailable !== false;
    select.value = available ? 'true' : 'false';
    input.value = portfolioSettings.servicesStatusText || '';
    if (preview) {
        preview.classList.toggle('is-available', available);
        preview.classList.toggle('is-unavailable', !available);
    }
    if (previewTitle) previewTitle.textContent = available ? 'Service disponible' : 'Service indisponible';
    if (previewText) previewText.textContent = input.value || (available ? 'Services disponibles actuellement' : 'Services indisponibles temporairement');
}

function renderAdminStorage() {
    const preview = document.getElementById('admin-profile-image-preview');
    if (preview && portfolioSettings.profileImageUrl) preview.src = portfolioSettings.profileImageUrl;
}

async function saveAdminProfileImage() {
    if (!adminAuthenticated || adminAccessMode !== 'admin' || !supabaseClient || adminBusy) return;
    const input = document.getElementById('admin-profile-image-file');
    const file = input?.files?.[0];
    if (!file) return setAdminStatus('Choisissez une image à envoyer.', 'error');
    if (!isAllowedImageFile(file)) return setAdminStatus('Image invalide ou supérieure à 10 Mo.', 'error');

    let uploaded = null;
    try {
        setAdminBusy(true, 'Envoi de la photo vers Supabase…');
        uploaded = await uploadAdminFile(STORAGE_BUCKETS.assets, 'site/profile', file);
        const oldPath = portfolioSettings.profileImageStoragePath || '';
        const { error } = await supabaseClient.from('portfolio_settings').upsert({
            id: 1,
            services_available: portfolioSettings.servicesAvailable !== false,
            services_status_text: portfolioSettings.servicesStatusText || 'Services disponibles actuellement',
            profile_image_url: uploaded.url,
            profile_image_storage_path: uploaded.path,
            updated_at: new Date().toISOString()
        }, { onConflict: 'id' });
        if (error) throw error;
        portfolioSettings.profileImageUrl = uploaded.url;
        portfolioSettings.profileImageStoragePath = uploaded.path;
        applyPortfolioProfileImage();
        renderAdminStorage();
        if (input) input.value = '';
        if (oldPath && oldPath !== uploaded.path) await removeStorageFile(STORAGE_BUCKETS.assets, oldPath);
        setAdminStatus('Photo du portfolio stockée dans Supabase.', 'success');
    } catch (error) {
        if (uploaded?.path) await removeStorageFile(STORAGE_BUCKETS.assets, uploaded.path);
        setAdminStatus(error.message || 'Impossible d’envoyer la photo.', 'error');
    } finally {
        setAdminBusy(false);
    }
}

function storageMigrationMessage(message, type = '') {
    const el = document.getElementById('admin-storage-migration-status');
    if (!el) return;
    el.textContent = message;
    el.className = `admin-storage-status ${type}`.trim();
}

function legacyAssetFileName(sourceUrl, fallback = 'fichier') {
    try {
        const u = new URL(sourceUrl, window.location.href);
        const name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || fallback);
        return sanitizeStorageName(name || fallback);
    } catch { return sanitizeStorageName(fallback); }
}

async function fetchLegacyAsset(sourceUrl, fallbackName = 'fichier') {
    const resolved = new URL(sourceUrl, window.location.href).href;
    const response = await fetch(resolved, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error(`Impossible de récupérer ${resolved} (${response.status}).`);
    const blob = await response.blob();
    return new File([blob], legacyAssetFileName(resolved, fallbackName), { type: blob.type || 'application/octet-stream' });
}

async function migrateLegacyAsset(sourceUrl, bucket, folder, fallbackName, maxBytes) {
    const file = await fetchLegacyAsset(sourceUrl, fallbackName);
    if (maxBytes && file.size > maxBytes) throw new Error(`${file.name} dépasse la taille autorisée.`);
    return uploadAdminFile(bucket, folder, file);
}

function collectRepositoryMigrationCandidates() {
    const candidates = [];
    for (const doc of adminCache.documents || []) {
        if (isRepositoryHostedAsset(doc.url)) candidates.push({ kind: 'document', id: doc.id, label: doc.title || `Document ${doc.id}`, url: doc.url });
    }
    for (const project of adminCache.projects || []) {
        if (isRepositoryHostedAsset(project.logo_url)) candidates.push({ kind: 'project-logo', id: project.id, label: project.name || `Projet ${project.id}`, url: project.logo_url });
    }
    for (const info of adminCache.infos || []) {
        if (isRepositoryHostedAsset(info.image_url)) candidates.push({ kind: 'info-image', id: info.id, label: info.title || `Information ${info.id}`, url: info.image_url });
        if (isRepositoryHostedAsset(info.attachment_url)) candidates.push({ kind: 'info-file', id: info.id, label: info.attachment_name || info.title || `Information ${info.id}`, url: info.attachment_url });
    }
    if (!portfolioSettings.profileImageUrl || isRepositoryHostedAsset(portfolioSettings.profileImageUrl)) {
        candidates.push({ kind: 'profile-image', id: 1, label: 'Photo du portfolio', url: portfolioSettings.profileImageUrl || LEGACY_PROFILE_IMAGE_URL });
    }
    return candidates;
}

async function migrateRepositoryAssetsToSupabase() {
    if (!adminAuthenticated || adminAccessMode !== 'admin' || !supabaseClient || adminBusy) return;
    const candidates = collectRepositoryMigrationCandidates();
    if (!candidates.length) {
        storageMigrationMessage('Aucun fichier dépendant de GitHub n’a été détecté.', 'success');
        return;
    }

    const confirmed = await siteConfirm({
        title: 'Migrer vers Supabase ?',
        message: `${candidates.length} fichier${candidates.length > 1 ? 's' : ''} à transférer.`,
        detail: 'Les fichiers sont d’abord copiés dans Supabase, puis les URL de la base sont remplacées. Ne supprimez pas encore les anciens fichiers GitHub pendant l’opération.',
        confirmLabel: 'Lancer la migration'
    });
    if (!confirmed) return;

    let done = 0;
    const failures = [];
    try {
        setAdminBusy(true, 'Migration des anciens fichiers…');
        for (const item of candidates) {
            storageMigrationMessage(`Migration ${done + 1}/${candidates.length} — ${item.label}`);
            try {
                if (item.kind === 'document') {
                    const uploaded = await migrateLegacyAsset(item.url, STORAGE_BUCKETS.documents, 'documents/migrated', `document-${item.id}`, 50 * 1024 * 1024);
                    const { error } = await supabaseClient.from('documents').update({ url: uploaded.url, storage_path: uploaded.path, file_name: legacyAssetFileName(item.url, `document-${item.id}`) }).eq('id', item.id);
                    if (error) { await removeStorageFile(STORAGE_BUCKETS.documents, uploaded.path); throw error; }
                } else if (item.kind === 'project-logo') {
                    const uploaded = await migrateLegacyAsset(item.url, STORAGE_BUCKETS.assets, 'projets/migrated', `projet-${item.id}`, 10 * 1024 * 1024);
                    const { error } = await supabaseClient.from('projects').update({ logo_url: uploaded.url, logo_storage_path: uploaded.path }).eq('id', item.id);
                    if (error) { await removeStorageFile(STORAGE_BUCKETS.assets, uploaded.path); throw error; }
                } else if (item.kind === 'info-image') {
                    const uploaded = await migrateLegacyAsset(item.url, STORAGE_BUCKETS.assets, 'informations/images/migrated', `info-${item.id}`, 10 * 1024 * 1024);
                    const { error } = await supabaseClient.from('info_blocks').update({ image_url: uploaded.url, image_storage_path: uploaded.path }).eq('id', item.id);
                    if (error) { await removeStorageFile(STORAGE_BUCKETS.assets, uploaded.path); throw error; }
                } else if (item.kind === 'info-file') {
                    const uploaded = await migrateLegacyAsset(item.url, STORAGE_BUCKETS.assets, 'informations/files/migrated', `info-fichier-${item.id}`, 50 * 1024 * 1024);
                    const { error } = await supabaseClient.from('info_blocks').update({ attachment_url: uploaded.url, attachment_storage_path: uploaded.path, attachment_name: legacyAssetFileName(item.url, `fichier-${item.id}`) }).eq('id', item.id);
                    if (error) { await removeStorageFile(STORAGE_BUCKETS.assets, uploaded.path); throw error; }
                } else if (item.kind === 'profile-image') {
                    const uploaded = await migrateLegacyAsset(item.url, STORAGE_BUCKETS.assets, 'site/profile', 'pdp.png', 10 * 1024 * 1024);
                    const { error } = await supabaseClient.from('portfolio_settings').upsert({
                        id: 1,
                        services_available: portfolioSettings.servicesAvailable !== false,
                        services_status_text: portfolioSettings.servicesStatusText || 'Services disponibles actuellement',
                        profile_image_url: uploaded.url,
                        profile_image_storage_path: uploaded.path,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'id' });
                    if (error) { await removeStorageFile(STORAGE_BUCKETS.assets, uploaded.path); throw error; }
                }
                done += 1;
            } catch (error) {
                console.error('Migration Supabase :', item, error);
                failures.push(`${item.label} : ${error.message || 'échec'}`);
            }
        }
        await Promise.all([loadAdminCache(), loadPortfolioSettings(), loadRemoteContent()]);
        refreshDynamicContent();
        renderAdminAll();
        applyPortfolioProfileImage();
        if (failures.length) {
            storageMigrationMessage(`${done}/${candidates.length} fichiers migrés. ${failures.length} échec(s) — consultez la console.`, 'warning');
            setAdminStatus('Migration partielle : certains fichiers n’ont pas pu être copiés.', 'error');
        } else {
            storageMigrationMessage(`${done} fichier${done > 1 ? 's' : ''} migré${done > 1 ? 's' : ''}. Le contenu ne dépend plus de ces fichiers GitHub.`, 'success');
            setAdminStatus('Migration GitHub → Supabase terminée.', 'success');
        }
    } finally {
        setAdminBusy(false);
    }
}

function previewAdminServices() {
    const select = document.getElementById('admin-services-available');
    const input = document.getElementById('admin-services-status-text');
    const preview = document.getElementById('admin-services-preview');
    const title = document.getElementById('admin-services-preview-title');
    const text = document.getElementById('admin-services-preview-text');
    if (!select || !input || !preview) return;
    const available = select.value !== 'false';
    preview.classList.toggle('is-available', available);
    preview.classList.toggle('is-unavailable', !available);
    if (title) title.textContent = available ? 'Service disponible' : 'Service indisponible';
    if (text) text.textContent = input.value.trim() || (available ? 'Services disponibles actuellement' : 'Services indisponibles temporairement');
}

async function handleAdminServicesSave(event) {
    event.preventDefault();
    if (!adminAuthenticated || !supabaseClient) return;
    const available = document.getElementById('admin-services-available')?.value !== 'false';
    const text = document.getElementById('admin-services-status-text')?.value.trim() || (available ? 'Services disponibles actuellement' : 'Services indisponibles temporairement');
    try {
        setAdminBusy(true, 'Mise à jour de la disponibilité…');
        const { error } = await supabaseClient.from('portfolio_settings').upsert({
            id: 1,
            services_available: available,
            services_status_text: text,
            profile_image_url: portfolioSettings.profileImageUrl || null,
            profile_image_storage_path: portfolioSettings.profileImageStoragePath || null,
            updated_at: new Date().toISOString()
        }, { onConflict: 'id' });
        if (error) throw error;
        portfolioSettings = { ...portfolioSettings, servicesAvailable: available, servicesStatusText: text };
        renderAdminServices();
        renderServiceAvailabilityStat();
        setAdminStatus('Disponibilité des services mise à jour.', 'success');
    } catch (error) {
        setAdminStatus(error.message || 'Impossible de modifier la disponibilité.', 'error');
    } finally {
        setAdminBusy(false);
    }
}

function showAdminEditor(kind, editing = false) {
    const form = document.getElementById(`admin-${kind}-form`);
    if (!form) return;
    form.hidden = false;
    form.scrollIntoView({ behavior: motionReduced ? 'auto' : 'smooth', block: 'nearest' });
    const first = form.querySelector('input:not([type="hidden"]), textarea, select');
    window.setTimeout(() => first?.focus(), 80);
}

function hideAdminEditor(kind) {
    document.getElementById(`admin-${kind}-form`)?.setAttribute('hidden', '');
}

function resetAdminDocumentForm() {
    const form = document.getElementById('admin-document-form');
    form?.reset();
    document.getElementById('admin-doc-id').value = '';
    document.getElementById('admin-doc-storage-path').value = '';
    document.getElementById('admin-doc-order').value = '0';
    document.getElementById('admin-doc-type').value = 'lessons';
    document.getElementById('admin-doc-published').checked = true;
    document.getElementById('admin-document-form-title').textContent = 'Ajouter un document';
    populateAdminSubjectSelect();
    syncAdminDocumentSubjectField();
}

function editAdminDocument(id) {
    const doc = adminCache.documents.find(item => Number(item.id) === Number(id));
    if (!doc) return;
    resetAdminDocumentForm();
    document.getElementById('admin-doc-id').value = doc.id;
    document.getElementById('admin-doc-storage-path').value = doc.storage_path || '';
    document.getElementById('admin-doc-title').value = doc.title || '';
    document.getElementById('admin-doc-subject').value = doc.subject_id || '';
    document.getElementById('admin-doc-type').value = normalizeStudyDocumentType(doc.type || 'lessons');
    document.getElementById('admin-doc-url').value = doc.url || '';
    document.getElementById('admin-doc-order').value = doc.sort_order || 0;
    document.getElementById('admin-doc-published').checked = doc.is_published !== false;
    document.getElementById('admin-document-form-title').textContent = 'Modifier le document';
    syncAdminDocumentSubjectField();
    showAdminEditor('document', true);
}

function resetAdminSubjectForm() {
    document.getElementById('admin-subject-form')?.reset();
    document.getElementById('admin-subject-original-id').value = '';
    const idInput = document.getElementById('admin-subject-id');
    idInput.value = '';
    idInput.disabled = false;
    document.getElementById('admin-subject-icon').value = 'fa-solid fa-book';
    document.getElementById('admin-subject-order').value = '0';
    document.getElementById('admin-subject-published').checked = true;
    document.getElementById('admin-subject-form-title').textContent = 'Ajouter une matière';
}

function editAdminSubject(id) {
    const subject = adminCache.subjects.find(item => item.id === id);
    if (!subject) return;
    resetAdminSubjectForm();
    document.getElementById('admin-subject-original-id').value = subject.id;
    document.getElementById('admin-subject-id').value = subject.id;
    document.getElementById('admin-subject-id').disabled = true;
    document.getElementById('admin-subject-name').value = subject.name || '';
    document.getElementById('admin-subject-icon').value = subject.icon || 'fa-solid fa-book';
    document.getElementById('admin-subject-order').value = subject.sort_order || 0;
    document.getElementById('admin-subject-published').checked = subject.is_published !== false;
    document.getElementById('admin-subject-form-title').textContent = 'Modifier la matière';
    showAdminEditor('subject', true);
}

function resetAdminInfoForm() {
    document.getElementById('admin-info-form')?.reset();
    document.getElementById('admin-info-id').value = '';
    document.getElementById('admin-info-storage-path').value = '';
    document.getElementById('admin-info-attachment-storage-path').value = '';
    document.getElementById('admin-info-icon').value = 'fa-solid fa-circle-info';
    document.getElementById('admin-info-section').value = adminInfoFilter === 'projects' ? 'projects' : 'studies';
    document.getElementById('admin-info-order').value = '0';
    document.getElementById('admin-info-publish-at').value = '';
    document.getElementById('admin-info-published').checked = true;
    document.getElementById('admin-info-form-title').textContent = 'Nouvelle information';
}

function toDatetimeLocalValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function editAdminInfo(id) {
    const info = adminCache.infos.find(item => Number(item.id) === Number(id));
    if (!info) return;
    resetAdminInfoForm();
    document.getElementById('admin-info-id').value = info.id;
    document.getElementById('admin-info-storage-path').value = info.image_storage_path || '';
    document.getElementById('admin-info-attachment-storage-path').value = info.attachment_storage_path || '';
    document.getElementById('admin-info-title').value = info.title || '';
    document.getElementById('admin-info-section').value = info.section === 'projects' ? 'projects' : 'studies';
    document.getElementById('admin-info-icon').value = info.icon || 'fa-solid fa-circle-info';
    document.getElementById('admin-info-text').value = info.text || '';
    document.getElementById('admin-info-image-url').value = info.image_url || '';
    document.getElementById('admin-info-attachment-url').value = info.attachment_url || '';
    document.getElementById('admin-info-attachment-name').value = info.attachment_name || '';
    document.getElementById('admin-info-publish-at').value = toDatetimeLocalValue(info.publish_at);
    document.getElementById('admin-info-order').value = info.sort_order || 0;
    document.getElementById('admin-info-published').checked = info.is_published !== false;
    document.getElementById('admin-info-form-title').textContent = 'Modifier l’information';
    showAdminEditor('info', true);
}

function resetAdminProjectForm() {
    document.getElementById('admin-project-form')?.reset();
    document.getElementById('admin-project-id').value = '';
    document.getElementById('admin-project-storage-path').value = '';
    document.getElementById('admin-project-icon').value = 'fa-solid fa-laptop-code';
    document.getElementById('admin-project-status').value = 'development';
    document.getElementById('admin-project-category').value = 'application';
    document.getElementById('admin-project-order').value = '0';
    document.getElementById('admin-project-published').checked = true;
    document.getElementById('admin-project-form-title').textContent = 'Ajouter une application';
}

function editAdminProject(id) {
    const project = adminCache.projects.find(item => Number(item.id) === Number(id));
    if (!project) return;
    resetAdminProjectForm();
    document.getElementById('admin-project-id').value = project.id;
    document.getElementById('admin-project-storage-path').value = project.logo_storage_path || '';
    document.getElementById('admin-project-name').value = project.name || '';
    document.getElementById('admin-project-category').value = project.category || 'application';
    document.getElementById('admin-project-status').value = project.status || 'development';
    document.getElementById('admin-project-icon').value = project.icon || 'fa-solid fa-laptop-code';
    document.getElementById('admin-project-description').value = project.description || '';
    document.getElementById('admin-project-tags').value = (project.tags || []).join(', ');
    document.getElementById('admin-project-features').value = (project.features || []).join('\n');
    document.getElementById('admin-project-logo-url').value = project.logo_url || '';
    document.getElementById('admin-project-app-url').value = project.app_url || '';
    document.getElementById('admin-project-dev-url').value = project.dev_url || '';
    document.getElementById('admin-project-order').value = project.sort_order || 0;
    document.getElementById('admin-project-published').checked = project.is_published !== false;
    document.getElementById('admin-project-form-title').textContent = 'Modifier l’application';
    showAdminEditor('project', true);
}

function sanitizeStorageName(name) {
    const parts = String(name || 'fichier').split('.');
    const ext = parts.length > 1 ? `.${parts.pop().toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
    const base = parts.join('.')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'fichier';
    return `${base}${ext}`;
}

function uniqueStoragePath(folder, fileName) {
    const random = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${folder}/${random}-${sanitizeStorageName(fileName)}`;
}

function isAllowedDocumentFile(file) {
    const allowed = ['pdf', 'doc', 'docx', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'zip', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
    const ext = String(file?.name || '').split('.').pop().toLowerCase();
    return allowed.includes(ext) && file.size <= 50 * 1024 * 1024;
}

function isAllowedImageFile(file) {
    const allowed = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'];
    const ext = String(file?.name || '').split('.').pop().toLowerCase();
    return allowed.includes(ext) && file.size <= 10 * 1024 * 1024;
}

async function uploadAdminFile(bucket, folder, file) {
    const path = uniqueStoragePath(folder, file.name);
    const { error } = await supabaseClient.storage.from(bucket).upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || undefined
    });
    if (error) throw error;
    const { data } = supabaseClient.storage.from(bucket).getPublicUrl(path);
    return { path, url: data.publicUrl };
}

async function removeStorageFile(bucket, path) {
    if (!path) return;
    const { error } = await supabaseClient.storage.from(bucket).remove([path]);
    if (error) console.warn('Fichier non supprimé du stockage :', error);
}

async function afterAdminMutation(message) {
    await loadAdminCache();
    await loadRemoteContent();
    refreshDynamicContent();
    renderAdminAll();
    setAdminStatus(message, 'success');
}

async function handleDocumentSave(event) {
    event.preventDefault();
    if (!adminAuthenticated || adminBusy) return;
    const id = Number(document.getElementById('admin-doc-id').value || 0);
    const old = id ? adminCache.documents.find(item => Number(item.id) === id) : null;
    const file = document.getElementById('admin-doc-file').files?.[0];
    let url = document.getElementById('admin-doc-url').value.trim();
    let storagePath = document.getElementById('admin-doc-storage-path').value || '';
    let uploaded = null;

    try {
        setAdminBusy(true, 'Enregistrement du document…');
        if (file) {
            if (!isAllowedDocumentFile(file)) throw new Error('Format non accepté ou fichier supérieur à 50 Mo.');
            const selectedType = normalizeStudyDocumentType(document.getElementById('admin-doc-type').value);
            const selectedSubject = document.getElementById('admin-doc-subject').value;
            const storageFolder = selectedType === 'resources' ? 'documents/resources' : `documents/${selectedSubject || 'sans-matiere'}`;
            uploaded = await uploadAdminFile(STORAGE_BUCKETS.documents, storageFolder, file);
            url = uploaded.url;
            storagePath = uploaded.path;
        }
        if (!url) throw new Error('Choisissez un fichier ou renseignez une URL.');
        if (!file && !safeExternalLink(url)) throw new Error('Les chemins locaux GitHub ne sont plus acceptés. Importez le fichier dans Supabase ou utilisez une URL https:// externe.');

        const selectedType = normalizeStudyDocumentType(document.getElementById('admin-doc-type').value);
        const selectedSubject = document.getElementById('admin-doc-subject').value;
        if (selectedType !== 'resources' && !selectedSubject) throw new Error('Choisissez une matière pour ce type de document.');

        const payload = {
            title: document.getElementById('admin-doc-title').value.trim(),
            subject_id: selectedType === 'resources' ? null : selectedSubject,
            type: selectedType,
            url,
            storage_path: storagePath || null,
            file_name: file?.name || old?.file_name || null,
            sort_order: Number(document.getElementById('admin-doc-order').value || 0),
            is_published: document.getElementById('admin-doc-published').checked
        };

        await saveDbRecord('documents', payload, id || null);

        if (uploaded && old?.storage_path && old.storage_path !== uploaded.path) {
            await removeStorageFile(STORAGE_BUCKETS.documents, old.storage_path);
        }
        resetAdminDocumentForm();
        hideAdminEditor('document');
        await afterAdminMutation(id ? 'Document modifié.' : 'Document ajouté.');
    } catch (error) {
        if (uploaded?.path) await removeStorageFile(STORAGE_BUCKETS.documents, uploaded.path);
        setAdminStatus(error.message || 'Erreur lors de l’enregistrement.', 'error');
    } finally {
        setAdminBusy(false);
        syncAdminDocumentSubjectField();
    }
}

async function handleSubjectSave(event) {
    event.preventDefault();
    if (!adminAuthenticated || adminBusy) return;
    const originalId = document.getElementById('admin-subject-original-id').value;
    let id = document.getElementById('admin-subject-id').value.trim();
    id = id.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!id) return setAdminStatus('L’identifiant de la matière est invalide.', 'error');

    const payload = {
        name: document.getElementById('admin-subject-name').value.trim(),
        icon: document.getElementById('admin-subject-icon').value.trim() || 'fa-solid fa-book',
        sort_order: Number(document.getElementById('admin-subject-order').value || 0),
        is_published: document.getElementById('admin-subject-published').checked
    };
    try {
        setAdminBusy(true, 'Enregistrement de la matière…');
        if (originalId) await saveDbRecord('subjects', payload, originalId);
        else await saveDbRecord('subjects', { id, ...payload });
        resetAdminSubjectForm();
        hideAdminEditor('subject');
        await afterAdminMutation(originalId ? 'Matière modifiée.' : 'Matière ajoutée.');
    } catch (error) {
        setAdminStatus(error.message || 'Erreur lors de l’enregistrement.', 'error');
    } finally {
        setAdminBusy(false);
    }
}

async function handleInfoSave(event) {
    event.preventDefault();
    if (!adminAuthenticated || adminBusy) return;
    const id = Number(document.getElementById('admin-info-id').value || 0);
    const old = id ? adminCache.infos.find(item => Number(item.id) === id) : null;

    const imageFile = document.getElementById('admin-info-file').files?.[0];
    const attachmentFile = document.getElementById('admin-info-attachment-file').files?.[0];
    let imageUrl = document.getElementById('admin-info-image-url').value.trim();
    let imageStoragePath = document.getElementById('admin-info-storage-path').value || '';
    let attachmentUrl = document.getElementById('admin-info-attachment-url').value.trim();
    let attachmentStoragePath = document.getElementById('admin-info-attachment-storage-path').value || '';
    let attachmentName = document.getElementById('admin-info-attachment-name').value.trim();
    let uploadedImage = null;
    let uploadedAttachment = null;

    try {
        setAdminBusy(true, 'Enregistrement de l’information…');

        if (imageUrl && !safeExternalLink(imageUrl)) throw new Error('L’URL de l’image doit commencer par http:// ou https://.');
        if (attachmentUrl && !safeExternalLink(attachmentUrl)) throw new Error('L’URL du fichier doit commencer par http:// ou https://.');

        if (imageFile) {
            if (!isAllowedImageFile(imageFile)) throw new Error('Format d’image non accepté ou image supérieure à 10 Mo.');
            uploadedImage = await uploadAdminFile(STORAGE_BUCKETS.assets, 'informations/images', imageFile);
            imageUrl = uploadedImage.url;
            imageStoragePath = uploadedImage.path;
        }

        if (attachmentFile) {
            if (!isAllowedDocumentFile(attachmentFile)) throw new Error('Format de fichier non accepté ou fichier supérieur à 50 Mo.');
            uploadedAttachment = await uploadAdminFile(STORAGE_BUCKETS.assets, 'informations/files', attachmentFile);
            attachmentUrl = uploadedAttachment.url;
            attachmentStoragePath = uploadedAttachment.path;
            if (!attachmentName) attachmentName = attachmentFile.name;
        }

        const publishLocal = document.getElementById('admin-info-publish-at').value;
        const publishAt = publishLocal ? new Date(publishLocal) : null;
        if (publishAt && !Number.isFinite(publishAt.getTime())) throw new Error('La date de publication est invalide.');

        const isPublished = document.getElementById('admin-info-published').checked;
        const payload = {
            section: document.getElementById('admin-info-section').value === 'projects' ? 'projects' : 'studies',
            title: document.getElementById('admin-info-title').value.trim(),
            icon: document.getElementById('admin-info-icon').value.trim() || 'fa-solid fa-circle-info',
            text: document.getElementById('admin-info-text').value.trim(),
            image_url: imageUrl || null,
            image_storage_path: imageStoragePath || null,
            attachment_url: attachmentUrl || null,
            attachment_storage_path: attachmentStoragePath || null,
            attachment_name: attachmentName || null,
            attachment_mime: attachmentFile?.type || old?.attachment_mime || null,
            publish_at: publishAt ? publishAt.toISOString() : null,
            sort_order: Number(document.getElementById('admin-info-order').value || 0),
            is_published: isPublished
        };

        await saveDbRecord('info_blocks', payload, id || null);

        if (uploadedImage && old?.image_storage_path && old.image_storage_path !== uploadedImage.path) {
            await removeStorageFile(STORAGE_BUCKETS.assets, old.image_storage_path);
        }
        if (uploadedAttachment && old?.attachment_storage_path && old.attachment_storage_path !== uploadedAttachment.path) {
            await removeStorageFile(STORAGE_BUCKETS.assets, old.attachment_storage_path);
        }

        resetAdminInfoForm();
        hideAdminEditor('info');
        const scheduled = isPublished && publishAt && publishAt.getTime() > Date.now();
        await afterAdminMutation(id ? (scheduled ? 'Information modifiée et reprogrammée.' : 'Information modifiée.') : (scheduled ? 'Information programmée.' : (isPublished ? 'Information publiée.' : 'Information enregistrée en brouillon.')));
    } catch (error) {
        if (uploadedImage?.path) await removeStorageFile(STORAGE_BUCKETS.assets, uploadedImage.path);
        if (uploadedAttachment?.path) await removeStorageFile(STORAGE_BUCKETS.assets, uploadedAttachment.path);
        setAdminStatus(error.message || 'Erreur lors de l’enregistrement.', 'error');
    } finally {
        setAdminBusy(false);
    }
}

async function handleProjectSave(event) {
    event.preventDefault();
    if (!adminAuthenticated || adminBusy) return;
    const id = Number(document.getElementById('admin-project-id').value || 0);
    const old = id ? adminCache.projects.find(item => Number(item.id) === id) : null;
    const file = document.getElementById('admin-project-logo-file').files?.[0];
    let logoUrl = document.getElementById('admin-project-logo-url').value.trim();
    let storagePath = document.getElementById('admin-project-storage-path').value || '';
    let uploaded = null;
    try {
        setAdminBusy(true, 'Enregistrement de l’application…');
        if (logoUrl && !safeExternalLink(logoUrl)) throw new Error('Les chemins locaux GitHub ne sont plus acceptés pour les logos. Importez le logo dans Supabase ou utilisez une URL https:// externe.');
        if (file) {
            if (!isAllowedImageFile(file)) throw new Error('Format de logo non accepté ou fichier supérieur à 10 Mo.');
            uploaded = await uploadAdminFile(STORAGE_BUCKETS.assets, 'projets', file);
            logoUrl = uploaded.url;
            storagePath = uploaded.path;
        }
        const tags = document.getElementById('admin-project-tags').value.split(',').map(value => value.trim()).filter(Boolean);
        const features = document.getElementById('admin-project-features').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        const payload = {
            name: document.getElementById('admin-project-name').value.trim(),
            category: document.getElementById('admin-project-category').value,
            status: document.getElementById('admin-project-status').value,
            icon: document.getElementById('admin-project-icon').value.trim() || 'fa-solid fa-laptop-code',
            description: document.getElementById('admin-project-description').value.trim(),
            tags,
            features,
            logo_url: logoUrl || null,
            logo_storage_path: storagePath || null,
            app_url: document.getElementById('admin-project-app-url').value.trim() || null,
            dev_url: document.getElementById('admin-project-dev-url').value.trim() || null,
            sort_order: Number(document.getElementById('admin-project-order').value || 0),
            is_published: document.getElementById('admin-project-published').checked
        };
        await saveDbRecord('projects', payload, id || null);
        if (uploaded && old?.logo_storage_path && old.logo_storage_path !== uploaded.path) {
            await removeStorageFile(STORAGE_BUCKETS.assets, old.logo_storage_path);
        }
        resetAdminProjectForm();
        hideAdminEditor('project');
        await afterAdminMutation(id ? 'Application modifiée.' : 'Application ajoutée.');
    } catch (error) {
        if (uploaded?.path) await removeStorageFile(STORAGE_BUCKETS.assets, uploaded.path);
        setAdminStatus(error.message || 'Erreur lors de l’enregistrement.', 'error');
    } finally {
        setAdminBusy(false);
    }
}

async function deleteAdminDocument(id) {
    const doc = adminCache.documents.find(item => Number(item.id) === Number(id));
    if (!doc || !(await siteConfirm({ title: 'Supprimer ce document ?', message: `« ${doc.title} » sera retiré de la bibliothèque.`, detail: 'Le fichier associé sera également supprimé du stockage lorsqu’il est hébergé par le site.', confirmLabel: 'Supprimer', danger: true }))) return;
    try {
        setAdminBusy(true, 'Suppression du document…');
        await deleteDbRecord('documents', id);
        await removeStorageFile(STORAGE_BUCKETS.documents, doc.storage_path);
        await afterAdminMutation('Document supprimé.');
    } catch (error) { setAdminStatus(error.message || 'Suppression impossible.', 'error'); }
    finally { setAdminBusy(false); }
}

async function deleteAdminSubject(id) {
    const subject = adminCache.subjects.find(item => item.id === id);
    if (!subject) return;
    const docs = adminCache.documents.filter(doc => doc.subject_id === id);
    if (docs.length) {
        setAdminStatus(`Cette matière contient ${docs.length} document${docs.length > 1 ? 's' : ''}. Supprimez ou déplacez-les d’abord.`, 'error');
        return;
    }
    if (!(await siteConfirm({ title: 'Supprimer cette matière ?', message: `Supprimer « ${subject.name} » ?`, detail: 'Cette action est définitive.', confirmLabel: 'Supprimer', danger: true }))) return;
    try {
        setAdminBusy(true, 'Suppression de la matière…');
        await deleteDbRecord('subjects', id);
        await afterAdminMutation('Matière supprimée.');
    } catch (error) { setAdminStatus(error.message || 'Suppression impossible.', 'error'); }
    finally { setAdminBusy(false); }
}

async function deleteAdminInfo(id) {
    const info = adminCache.infos.find(item => Number(item.id) === Number(id));
    if (!info || !(await siteConfirm({ title: 'Supprimer cette information ?', message: `Supprimer « ${info.title} » ?`, confirmLabel: 'Supprimer', danger: true }))) return;
    try {
        setAdminBusy(true, 'Suppression de l’information…');
        await deleteDbRecord('info_blocks', id);
        await removeStorageFile(STORAGE_BUCKETS.assets, info.image_storage_path);
        await removeStorageFile(STORAGE_BUCKETS.assets, info.attachment_storage_path);
        await afterAdminMutation('Information supprimée.');
    } catch (error) { setAdminStatus(error.message || 'Suppression impossible.', 'error'); }
    finally { setAdminBusy(false); }
}

async function deleteAdminProject(id) {
    const project = adminCache.projects.find(item => Number(item.id) === Number(id));
    if (!project || !(await siteConfirm({ title: 'Supprimer cette application ?', message: `Supprimer « ${project.name} » ?`, detail: 'Cette action est définitive.', confirmLabel: 'Supprimer', danger: true }))) return;
    try {
        setAdminBusy(true, 'Suppression de l’application…');
        await deleteDbRecord('projects', id);
        await removeStorageFile(STORAGE_BUCKETS.assets, project.logo_storage_path);
        await afterAdminMutation('Application supprimée.');
    } catch (error) { setAdminStatus(error.message || 'Suppression impossible.', 'error'); }
    finally { setAdminBusy(false); }
}

// Wiring administration
adminModal?.addEventListener('click', closeAdminModal);
document.getElementById('admin-open-btn')?.addEventListener('click', openAdminModal);
document.getElementById('admin-close-btn')?.addEventListener('click', () => closeAdminModal());
document.getElementById('admin-login-form')?.addEventListener('submit', handleAdminLogin);
document.getElementById('admin-logout-btn')?.addEventListener('click', logoutAdmin);
document.getElementById('admin-password-toggle')?.addEventListener('click', () => {
    const input = document.getElementById('admin-password');
    const button = document.getElementById('admin-password-toggle');
    if (!input || !button) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    const hidden = input.type === 'password';
    button.innerHTML = hidden ? '<i class="fa-regular fa-eye"></i>' : '<i class="fa-regular fa-eye-slash"></i>';
    button.dataset.tooltip = hidden ? 'Afficher le mot de passe' : 'Masquer le mot de passe';
    button.setAttribute('aria-label', button.dataset.tooltip);
});
document.querySelectorAll('.admin-tab').forEach(button => button.addEventListener('click', () => switchAdminTab(button.dataset.adminTab)));
document.querySelectorAll('[data-admin-new]').forEach(button => button.addEventListener('click', () => {
    const kind = button.dataset.adminNew;
    if (kind === 'document') resetAdminDocumentForm();
    if (kind === 'subject') resetAdminSubjectForm();
    if (kind === 'info') resetAdminInfoForm();
    if (kind === 'project') resetAdminProjectForm();
    showAdminEditor(kind);
}));
document.querySelectorAll('[data-admin-info-filter]').forEach(button => button.addEventListener('click', () => {
    adminInfoFilter = button.dataset.adminInfoFilter || 'all';
    document.querySelectorAll('[data-admin-info-filter]').forEach(item => item.classList.toggle('active', item === button));
    renderAdminInfos();
}));
document.querySelectorAll('[data-admin-cancel]').forEach(button => button.addEventListener('click', () => hideAdminEditor(button.dataset.adminCancel)));
document.getElementById('admin-document-form')?.addEventListener('submit', handleDocumentSave);
document.getElementById('admin-doc-type')?.addEventListener('change', syncAdminDocumentSubjectField);
document.getElementById('admin-subject-form')?.addEventListener('submit', handleSubjectSave);
document.getElementById('admin-info-form')?.addEventListener('submit', handleInfoSave);
document.getElementById('admin-project-form')?.addEventListener('submit', handleProjectSave);
document.getElementById('admin-services-form')?.addEventListener('submit', handleAdminServicesSave);
document.getElementById('admin-services-available')?.addEventListener('change', previewAdminServices);
document.getElementById('admin-services-status-text')?.addEventListener('input', previewAdminServices);
document.getElementById('admin-profile-image-save')?.addEventListener('click', saveAdminProfileImage);
document.getElementById('admin-storage-migrate')?.addEventListener('click', migrateRepositoryAssetsToSupabase);
document.getElementById('admin-document-search')?.addEventListener('input', renderAdminDocuments);
document.getElementById('admin-project-search')?.addEventListener('input', renderAdminProjects);

window.editAdminDocument = editAdminDocument;
window.deleteAdminDocument = deleteAdminDocument;
window.editAdminSubject = editAdminSubject;
window.deleteAdminSubject = deleteAdminSubject;
window.editAdminInfo = editAdminInfo;
window.deleteAdminInfo = deleteAdminInfo;
window.editAdminProject = editAdminProject;
window.deleteAdminProject = deleteAdminProject;
window.openAdminModal = openAdminModal;

/* ==========================================================
   AGRANDISSEMENT DES IMAGES — ZOOM + DÉPLACEMENT PC & MOBILE
========================================================== */
const IMAGE_ZOOM_SELECTOR = [
    '.info-block-img',
    '.image-viewer',
    '.project-modal-media img',
    '.forum-external-attachment.image img'
].join(', ');

const IMAGE_LIGHTBOX_MIN_SCALE = 1;
const IMAGE_LIGHTBOX_MAX_SCALE = 8;
const imageLightboxState = {
    scale: 1,
    x: 0,
    y: 0,
    pointers: new Map(),
    pinch: null,
    lastPanPoint: null,
    moved: false,
    suppressClickUntil: 0
};

function imageLightboxElements() {
    return {
        lightbox: document.getElementById('imageLightbox'),
        stage: document.getElementById('image-lightbox-stage'),
        image: document.getElementById('image-lightbox-img'),
        level: document.getElementById('image-lightbox-zoom-level')
    };
}

function imageLightboxClampScale(value) {
    return Math.min(IMAGE_LIGHTBOX_MAX_SCALE, Math.max(IMAGE_LIGHTBOX_MIN_SCALE, Number(value) || 1));
}

function clampImageLightboxPan() {
    const { stage, image } = imageLightboxElements();
    if (!stage || !image) return;

    const scaledWidth = image.offsetWidth * imageLightboxState.scale;
    const scaledHeight = image.offsetHeight * imageLightboxState.scale;
    const maxX = Math.max(0, (scaledWidth - stage.clientWidth) / 2);
    const maxY = Math.max(0, (scaledHeight - stage.clientHeight) / 2);

    imageLightboxState.x = Math.max(-maxX, Math.min(maxX, imageLightboxState.x));
    imageLightboxState.y = Math.max(-maxY, Math.min(maxY, imageLightboxState.y));
}

function applyImageLightboxTransform() {
    const { stage, image, level } = imageLightboxElements();
    if (!stage || !image) return;

    clampImageLightboxPan();
    image.style.transform = `translate3d(${imageLightboxState.x}px, ${imageLightboxState.y}px, 0) scale(${imageLightboxState.scale})`;
    stage.classList.toggle('zoomed', imageLightboxState.scale > 1.001);
    if (level) level.textContent = `${Math.round(imageLightboxState.scale * 100)}%`;
}

function resetImageLightboxView() {
    imageLightboxState.scale = 1;
    imageLightboxState.x = 0;
    imageLightboxState.y = 0;
    imageLightboxState.pointers.clear();
    imageLightboxState.pinch = null;
    imageLightboxState.lastPanPoint = null;
    imageLightboxState.moved = false;
    applyImageLightboxTransform();
}

function setImageLightboxZoom(nextScale, clientX = null, clientY = null) {
    const { stage } = imageLightboxElements();
    if (!stage) return;

    const oldScale = imageLightboxState.scale;
    const scale = imageLightboxClampScale(nextScale);
    if (Math.abs(scale - oldScale) < 0.0001) return;

    const rect = stage.getBoundingClientRect();
    const anchorX = Number.isFinite(clientX) ? clientX : rect.left + rect.width / 2;
    const anchorY = Number.isFinite(clientY) ? clientY : rect.top + rect.height / 2;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const ratio = scale / oldScale;

    // Le point situé sous le curseur / entre les doigts reste au même endroit.
    imageLightboxState.x = (anchorX - centerX) - ((anchorX - centerX) - imageLightboxState.x) * ratio;
    imageLightboxState.y = (anchorY - centerY) - ((anchorY - centerY) - imageLightboxState.y) * ratio;
    imageLightboxState.scale = scale;

    if (scale <= 1.001) {
        imageLightboxState.x = 0;
        imageLightboxState.y = 0;
    }
    applyImageLightboxTransform();
}

function openImageLightbox(image) {
    const { lightbox, image: lightboxImage } = imageLightboxElements();
    if (!lightbox || !lightboxImage || !image?.src) return;

    resetImageLightboxView();
    lightboxImage.src = image.currentSrc || image.src;
    lightboxImage.alt = image.alt || 'Image agrandie';
    lightbox.hidden = false;
    document.body.classList.add('image-lightbox-open');
    requestAnimationFrame(() => {
        resetImageLightboxView();
        lightbox.classList.add('active');
    });
}

function closeImageLightbox() {
    const { lightbox, image: lightboxImage, stage } = imageLightboxElements();
    if (!lightbox || lightbox.hidden) return;

    stage?.classList.remove('dragging', 'zoomed');
    imageLightboxState.pointers.clear();
    imageLightboxState.pinch = null;
    imageLightboxState.lastPanPoint = null;
    lightbox.classList.remove('active');
    document.body.classList.remove('image-lightbox-open');
    window.setTimeout(() => {
        if (lightbox.classList.contains('active')) return;
        lightbox.hidden = true;
        if (lightboxImage) {
            lightboxImage.src = '';
            lightboxImage.style.transform = '';
        }
    }, motionReduced ? 0 : 180);
}

function imageLightboxPointerDistance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function imageLightboxPointerMidpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function beginImageLightboxPinch(stage) {
    if (imageLightboxState.pointers.size < 2) return;
    const [a, b] = [...imageLightboxState.pointers.values()].slice(0, 2);
    const midpoint = imageLightboxPointerMidpoint(a, b);
    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    imageLightboxState.pinch = {
        distance: Math.max(1, imageLightboxPointerDistance(a, b)),
        scale: imageLightboxState.scale,
        contentX: (midpoint.x - centerX - imageLightboxState.x) / imageLightboxState.scale,
        contentY: (midpoint.y - centerY - imageLightboxState.y) / imageLightboxState.scale
    };
    imageLightboxState.lastPanPoint = null;
}

function updateImageLightboxPinch(stage) {
    if (imageLightboxState.pointers.size < 2 || !imageLightboxState.pinch) return;
    const [a, b] = [...imageLightboxState.pointers.values()].slice(0, 2);
    const midpoint = imageLightboxPointerMidpoint(a, b);
    const distance = Math.max(1, imageLightboxPointerDistance(a, b));
    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const scale = imageLightboxClampScale(
        imageLightboxState.pinch.scale * (distance / imageLightboxState.pinch.distance)
    );

    imageLightboxState.scale = scale;
    imageLightboxState.x = midpoint.x - centerX - imageLightboxState.pinch.contentX * scale;
    imageLightboxState.y = midpoint.y - centerY - imageLightboxState.pinch.contentY * scale;
    if (scale <= 1.001) {
        imageLightboxState.x = 0;
        imageLightboxState.y = 0;
    }
    applyImageLightboxTransform();
}

document.addEventListener('click', event => {
    const image = event.target instanceof Element ? event.target.closest(IMAGE_ZOOM_SELECTOR) : null;
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    openImageLightbox(image);
});

const imageLightboxStage = document.getElementById('image-lightbox-stage');
const imageLightboxImage = document.getElementById('image-lightbox-img');

imageLightboxImage?.addEventListener('load', () => requestAnimationFrame(resetImageLightboxView));

imageLightboxStage?.addEventListener('wheel', event => {
    // Intercepte aussi le pincement du trackpad (souvent envoyé comme Ctrl + wheel)
    // afin de zoomer l'image et non la page située derrière.
    event.preventDefault();
    event.stopPropagation();
    const factor = Math.exp(-event.deltaY * 0.0018);
    setImageLightboxZoom(imageLightboxState.scale * factor, event.clientX, event.clientY);
}, { passive: false });

imageLightboxStage?.addEventListener('dblclick', event => {
    event.preventDefault();
    const targetScale = imageLightboxState.scale > 1.05 ? 1 : 2.5;
    setImageLightboxZoom(targetScale, event.clientX, event.clientY);
});

imageLightboxStage?.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    imageLightboxState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    imageLightboxState.moved = false;
    imageLightboxStage.setPointerCapture?.(event.pointerId);

    if (imageLightboxState.pointers.size >= 2) {
        beginImageLightboxPinch(imageLightboxStage);
    } else {
        imageLightboxState.lastPanPoint = { x: event.clientX, y: event.clientY };
    }
});

imageLightboxStage?.addEventListener('pointermove', event => {
    if (!imageLightboxState.pointers.has(event.pointerId)) return;
    const previous = imageLightboxState.pointers.get(event.pointerId);
    const current = { x: event.clientX, y: event.clientY };
    imageLightboxState.pointers.set(event.pointerId, current);

    if (imageLightboxState.pointers.size >= 2) {
        imageLightboxState.moved = true;
        imageLightboxStage.classList.add('dragging');
        updateImageLightboxPinch(imageLightboxStage);
        return;
    }

    if (imageLightboxState.scale <= 1.001) return;
    const last = imageLightboxState.lastPanPoint || previous || current;
    const dx = current.x - last.x;
    const dy = current.y - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 1) imageLightboxState.moved = true;
    imageLightboxState.x += dx;
    imageLightboxState.y += dy;
    imageLightboxState.lastPanPoint = current;
    imageLightboxStage.classList.add('dragging');
    applyImageLightboxTransform();
});

function endImageLightboxPointer(event) {
    if (!imageLightboxState.pointers.has(event.pointerId)) return;
    imageLightboxState.pointers.delete(event.pointerId);
    try { imageLightboxStage?.releasePointerCapture?.(event.pointerId); } catch {}

    if (imageLightboxState.moved) imageLightboxState.suppressClickUntil = performance.now() + 260;

    if (imageLightboxState.pointers.size >= 2) {
        beginImageLightboxPinch(imageLightboxStage);
    } else if (imageLightboxState.pointers.size === 1) {
        const remaining = [...imageLightboxState.pointers.values()][0];
        imageLightboxState.pinch = null;
        imageLightboxState.lastPanPoint = { ...remaining };
    } else {
        imageLightboxState.pinch = null;
        imageLightboxState.lastPanPoint = null;
        imageLightboxStage?.classList.remove('dragging');
    }
}

imageLightboxStage?.addEventListener('pointerup', endImageLightboxPointer);
imageLightboxStage?.addEventListener('pointercancel', endImageLightboxPointer);

// Safari / iOS : empêche le geste natif de zoomer la page sous la visionneuse.
['gesturestart', 'gesturechange', 'gestureend'].forEach(type => {
    imageLightboxStage?.addEventListener(type, event => event.preventDefault(), { passive: false });
});
imageLightboxStage?.addEventListener('touchmove', event => event.preventDefault(), { passive: false });

imageLightboxStage?.addEventListener('click', event => {
    if (performance.now() < imageLightboxState.suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
    }
    if (event.target === imageLightboxStage) closeImageLightbox();
});

document.getElementById('image-lightbox-close')?.addEventListener('click', closeImageLightbox);
document.getElementById('image-lightbox-zoom-in')?.addEventListener('click', () => {
    setImageLightboxZoom(imageLightboxState.scale * 1.35);
});
document.getElementById('image-lightbox-zoom-out')?.addEventListener('click', () => {
    setImageLightboxZoom(imageLightboxState.scale / 1.35);
});
document.getElementById('image-lightbox-reset')?.addEventListener('click', resetImageLightboxView);

window.addEventListener('resize', () => {
    const { lightbox } = imageLightboxElements();
    if (!lightbox || lightbox.hidden) return;
    applyImageLightboxTransform();
});

/* ==========================================================
   RACCOURCIS CLAVIER & FERMETURES
========================================================== */
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        closeImageLightbox();
        document.getElementById('profileModal')?.classList.remove('active');
        document.getElementById('projectModal')?.classList.remove('active');
        document.getElementById('adminModal')?.classList.remove('active');
        themePopover?.classList.remove('open');
        closeMobileMenu();
        setBodyModalState();
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        navigateToSection('courses');
        window.setTimeout(() => document.getElementById('course-search')?.focus(), motionReduced ? 0 : 180);
    }
});

/* ==========================================================
   ÉVÉNEMENTS — BIBLIOTHÈQUE / HORS CONNEXION / PWA
========================================================== */
document.getElementById('favorites-btn')?.addEventListener('click', () => openPersonalLibrary('favorites'));
document.getElementById('pwa-footer-install-btn')?.addEventListener('click', installSitePwa);
document.getElementById('pwa-install-notice-btn')?.addEventListener('click', installSitePwa);
document.getElementById('pwa-install-notice-later')?.addEventListener('click', () => hidePwaInstallNotice(true));
document.getElementById('pwa-install-notice-close')?.addEventListener('click', () => hidePwaInstallNotice(true));
document.getElementById('library-search')?.addEventListener('input', event => {
    personalLibrarySearch = event.target.value.trim();
    renderPersonalLibrary().catch(console.warn);
});
document.querySelectorAll('[data-library-tab]').forEach(button => button.addEventListener('click', () => {
    personalLibraryTab = button.dataset.libraryTab === 'offline' ? 'offline' : 'favorites';
    renderPersonalLibrary().catch(console.warn);
}));
document.querySelectorAll('[data-favorite-filter]').forEach(button => button.addEventListener('click', () => {
    personalLibraryFilter = button.dataset.favoriteFilter || 'all';
    document.querySelectorAll('[data-favorite-filter]').forEach(item => item.classList.toggle('active', item === button));
    renderPersonalLibrary().catch(console.warn);
}));

document.addEventListener('click', async event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const favorite = target.closest('[data-favorite-type][data-favorite-id]');
    if (favorite) {
        event.preventDefault();
        event.stopImmediatePropagation();
        await toggleSiteFavorite(favorite.dataset.favoriteType, favorite.dataset.favoriteId);
        return;
    }

    const offlineButton = target.closest('[data-offline-document-id]');
    if (offlineButton) {
        event.preventDefault();
        event.stopImmediatePropagation();
        await toggleOfflineDocument(offlineButton);
        return;
    }

    const favoriteOpen = target.closest('[data-library-open]');
    if (favoriteOpen) { await openResolvedFavorite(favoriteOpen.dataset.libraryOpen); return; }

    const offlineOpen = target.closest('[data-offline-open-id]');
    if (offlineOpen) { await openOfflineEntry(offlineOpen.dataset.offlineOpenId); return; }

    const offlineRemove = target.closest('[data-offline-remove-id]');
    if (offlineRemove) { await removeOfflineEntry(offlineRemove.dataset.offlineRemoveId); return; }

    if (target.closest('[data-library-login]')) {
        if (typeof window.openAccountModal === 'function') window.openAccountModal('login');
    }
});

/* ==========================================================
   INITIALISATION
========================================================== */
document.addEventListener('DOMContentLoaded', async () => {
    const savedTheme = localStorage.getItem('portfolio-accent-theme') || 'blue';
    applyTheme(savedTheme, false);

    const savedMotion = localStorage.getItem('portfolio-reduced-motion');
    const systemPrefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    motionReduced = savedMotion === null ? systemPrefersReduced : savedMotion === '1';

    initSupabaseClient();
    registerSitePwa().catch(console.warn);
    await Promise.all([loadRemoteContent(), loadPortfolioSettings()]);
    applyPortfolioProfileImage();
    await loadSiteFavorites();
    courseSearchEntries = getCourseSearchEntries();

    renderProjects();
    renderProjectInfo();
    renderGeneralInfo();
    renderSubjects();
    updateStats();
    refreshInfoSubscriptionButtons().catch(console.warn);
    refreshFavoriteButtons();
    refreshOfflineDocumentButtons().catch(console.warn);
    updateLibraryNetworkState();
    updatePwaInstallUi();
    if (isIosPwaDevice() && !isStandalonePwa()) schedulePwaInstallNotice(1700);

    resizeCanvas();
    setMotionReduced(motionReduced, false);
    startRotatingText();

    document.getElementById('current-year').textContent = String(new Date().getFullYear());

    const initialHash = window.location.hash.replace('#', '');
    activateSection(VALID_SECTIONS.includes(initialHash) ? initialHash : 'about', { updateHash: false, scroll: false });
    if (initialHash === 'library') renderPersonalLibrary().catch(console.warn);
    if (initialHash === 'notifications') window.refreshNotificationCenter?.();
    refreshRevealElements();

    window.setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        if (document.getElementById('projects')?.classList.contains('active') || document.getElementById('courses')?.classList.contains('active')) {
            refreshRemoteContentIfStale(55000).catch(console.warn);
        }
    }, 60000);
});


document.addEventListener('DOMContentLoaded', initSiteVisualPolish);
