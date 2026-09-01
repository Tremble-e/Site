'use strict';

document.documentElement.classList.add('js');

/* ==========================================================
   CONFIGURATION GÉNÉRALE
========================================================== */
const VALID_SECTIONS = ['about', 'services', 'projects', 'courses'];
const navButtons = [...document.querySelectorAll('.nav-btn')];
const pageSections = [...document.querySelectorAll('.page-section')];
const mobileMenu = document.getElementById('nav-menu');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');

let activeProjectCategory = 'all';
let projectSearchTerm = '';
let currentSubjectIndex = 0;
let currentSubjectTab = 'lessons';
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

let supabaseClient = null;
let remoteContentInitialized = false;
let adminAuthenticated = false;
let adminCache = { subjects: [], documents: [], infos: [], projects: [] };
let adminBusy = false;


/* ==========================================================
   DONNÉES DES PROJETS
   Les informations existantes sont conservées, avec des
   métadonnées de présentation (catégorie / tags).
========================================================== */
const LEGACY_PROJECTS = [
    {
        name: 'MathNote',
        logoUrl: 'image/application/MathNote.ico',
        icon: 'fa-solid fa-note-sticky',
        category: 'application',
        tags: ['Études', 'Productivité', 'Documents'],
        description: "L'application parfaite pour les étudiants en sciences.",
        features: ['Canvas', 'Éditeur de documents', 'Visionneuse de PDF', 'Tableur', 'Planning', 'Calculatrice Avancée', 'Traducteur', 'Pomodoro', 'Raccourci vers des sites ou des applications'],
        appUrl: '',
        devUrl: ''
    },
    {
        name: 'MathWriter',
        logoUrl: 'image/application/MathWriter.svg',
        icon: 'fa-solid fa-square-root-variable',
        category: 'application',
        tags: ['Mathématiques', 'Édition', 'PDF'],
        description: 'Rédaction de documents mathématiques propres et professionnels sans aucune connaissance en Latex.',
        features: ['Objets mathématiques', 'Graphiques', 'Images', 'Texte', 'Figures Géométriques', 'Écriture manuscrite', 'Tableau', 'Exportation pour une modification ultérieur et/ou en PDF'],
        appUrl: '',
        devUrl: ''
    },
    {
        name: 'Windows Assistant',
        logoUrl: 'image/application/WindowsAssistant.ico',
        icon: 'fa-solid fa-microphone-lines',
        category: 'tool',
        tags: ['Windows', 'Automatisation', 'Assistant vocal'],
        description: 'Assistant vocal pour la gestion d\'un environement windows et la discussion.',
        features: ["Gestion d'application", "Gestion d'environnement windows", 'Gestion de fichiers', 'Recherche intelligente', 'Mode Système & Discussion', 'Mémoire', 'Gestion du clavier & de la souris', 'Traduction'],
        appUrl: '',
        devUrl: ''
    },
    {
        name: 'SoftMusic',
        logoUrl: 'image/application/softmusic.png',
        icon: 'fa-solid fa-music',
        category: 'application',
        tags: ['Audio', 'Windows', 'Playlists'],
        description: 'Lecteur audio windows.',
        features: ['Fichier Audio', 'Radio en directe', 'Playlist', 'Favori', 'Mini-Lecteur', 'Différents thèmes'],
        appUrl: 'https://drive.google.com/file/d/1fvoeOJPJsn38riANiCY7NAawM_vter2Z/view?usp=sharing',
        devUrl: 'https://drive.google.com/file/d/1C3ooparOQ-_dzkrkINQr4k-v4TCikk9a/view?usp=drive_link'
    },
    {
        name: 'Youtube Converter',
        logoUrl: 'image/application/YoutubeConverter.png',
        icon: 'fa-brands fa-youtube',
        category: 'tool',
        tags: ['YouTube', 'Audio', 'Vidéo'],
        description: 'Téléchargeur de liens YouTube.',
        features: ['Vidéo, short, playlist et chaîne', 'Format mp3 / mp4', 'Choix de la qualité', 'Prévisualisation de la vidéo'],
        appUrl: 'https://drive.google.com/file/d/1pWI9xss7edq8Wk0c-lIJdzVqrZ2s7kpK/view?usp=sharing',
        devUrl: 'https://drive.google.com/file/d/1KDj5qfWVZF91ar3ZETvP0JDEbn4nYVvN/view?usp=drive_link'
    },
    {
        name: 'Simple Recorder',
        logoUrl: 'image/application/SimpleRecorder.ico',
        icon: 'fa-solid fa-display',
        category: 'tool',
        tags: ['Capture écran', 'Windows', 'Raccourcis'],
        description: "Enregistreur d'écran érgonomique.",
        features: ["Facile d'utilisation", 'Raccourci clavier', 'Visibilité de la souris', "Système de 'spotlight'"],
        appUrl: 'https://drive.google.com/file/d/1SPu71o6UflF8swauVCxnGRkCdLQbQP17/view?usp=sharing',
        devUrl: 'https://drive.google.com/file/d/1_eDR0OEjzF6I2PQC6Uthq2WtsgydN9RQ/view?usp=drive_link'
    },
    {
        name: 'Essential Converter',
        logoUrl: 'image/application/EssentialConverter.ico',
        icon: 'fa-solid fa-arrows-rotate',
        category: 'tool',
        tags: ['Conversion', 'Multimédia', 'Documents'],
        description: 'Convertisseur de formats populaires.',
        features: ["Facile d'utilisation", 'Drag & drop', 'Images', 'Documents', 'Audio', 'Vidéo', 'PDF'],
        appUrl: '',
        devUrl: ''
    },
    {
        name: 'Dofurion Multicompte',
        logoUrl: 'image/application/DofurionMultiCompte.ico',
        icon: 'fa-solid fa-computer-mouse',
        category: 'tool',
        tags: ['Automatisation', 'Multi-compte', 'Raccourcis'],
        description: 'Logiciel de gestion MultiCompte pour Dofus.',
        features: ['Multi clics', 'Invitation au groupe', 'Havre sac', 'Mini menus utilitaires', 'Raccourci clavier'],
        appUrl: 'https://drive.google.com/file/d/1lbh7rl_RYIGX-jl-vTfLhrywX8Lahtb7/view?usp=drive_link',
        devUrl: 'https://drive.google.com/file/d/1PIRnAMjyvRjftdDm3ytKtS8CrBNDTljx/view?usp=drive_link'
    },
    {
        name: 'NeoTower',
        logoUrl: 'image/application/NeoTower.ico',
        icon: 'fa-brands fa-fort-awesome',
        category: 'game',
        tags: ['Tower Defense', 'Arcade', 'Progression'],
        description: 'Tower Defense et incrémental dans un style néon.',
        features: ['Vague infini', 'Améliorations variées', 'Laboratoire de recherche et Prestiges', 'Modules', 'Cartes', 'Sauvegarde de la progression'],
        appUrl: 'https://drive.google.com/file/d/1B3HfMTyIrTYuwJWxMQzGdMfrwAfe4oJZ/view?usp=sharing',
        devUrl: 'https://drive.google.com/file/d/16F3DFhjkRfvVAyxmvl_1v20GWdrhoakJ/view?usp=drive_link'
    },
    {
        name: 'Hypergride',
        logoUrl: 'image/application/Hypergride.png',
        icon: 'fa-solid fa-gamepad',
        category: 'game',
        tags: ['Arcade', 'Mini-jeux', 'Progression'],
        description: 'Collection de mini-jeux dans un style néon.',
        features: ['Arcade', 'Jeux de Société', 'Jeux smartphones populaires', 'Campagne et mode Infini', 'Sauvegarde de la progression'],
        appUrl: 'https://drive.google.com/file/d/1QTubCUwpvD42Q4ZWRFG4GJjjPmstgMM9/view?usp=sharing',
        devUrl: 'https://drive.google.com/file/d/1giCkfIwZqaIxuO7ZgK99TJY_ERQ6gTEL/view?usp=sharing'
    }
];

let myProjects = JSON.parse(JSON.stringify(LEGACY_PROJECTS));

const categoryLabels = {
    application: 'Application',
    tool: 'Outil',
    game: 'Jeu'
};

/* ==========================================================
   INFORMATIONS GÉNÉRALES
========================================================== */
const LEGACY_GENERAL_INFO = [
    {
        icon: 'fa-regular fa-clock',
        title: 'Information 1',
        text: '....',
        imageUrl: ''
    },
    {
        icon: 'fa-solid fa-triangle-exclamation',
        title: 'Information 2',
        text: '.....',
        imageUrl: ''
    },
    {
        icon: 'fa-solid fa-triangle-exclamation',
        title: 'Information 3',
        text: '........',
        imageUrl: ''
    }
];

let generalInfo = JSON.parse(JSON.stringify(LEGACY_GENERAL_INFO));

/* ==========================================================
   DONNÉES DES COURS & EXERCICES
========================================================== */
const LEGACY_COURSES = [
    {
        id: 'SSF',
        name: 'Suites et séries de fonctions',
        icon: 'fa-solid fa-arrow-trend-up',
        lessons: [
            { title: 'Chapitre 1 - Suites et Séries de Fonctions', url: 'cours/SuitesEtSériesDeFonctions.pdf' },
            { title: 'Chapitre 2 - Séries entières', url: 'cours/SériesEntières.pdf' }
        ],
        exercises: [],
        sheets: [
            { title: 'Formulaire - SSF', url: 'FormulairesEtFiches/FormulaireSSF.pdf' },
            { title: 'Fiches - SSF', url: 'FormulairesEtFiches/SSFFiche.pdf' }
        ]
    },
    {
        id: 'AA',
        name: 'Arithmétique et Algèbre',
        icon: 'fa-solid fa-divide',
        lessons: [
            { title: 'Arithmétique et Algèbre', url: 'cours/ArithmétiqueEtAlgèbre.pdf' }
        ],
        exercises: [],
        sheets: []
    },
    {
        id: 'TopoDER',
        name: "Compléments d'analyse et Topologie de R",
        icon: 'fa-solid fa-circle-nodes',
        lessons: [
            { title: 'Topologie de R', url: 'cours/TopologieDeR.pdf' }
        ],
        exercises: [],
        sheets: [
            { title: 'Fiche - Topologie de R', url: 'FormulairesEtFiches/TopologieDeRFiche.pdf' }
        ]
    },
    {
        id: 'AL',
        name: 'Algèbre linéaire',
        icon: 'fa-solid fa-table-cells-large',
        lessons: [
            { title: 'Algèbre linéaire', url: 'cours/AlgèbreLinéaire.pdf' }
        ],
        exercises: [],
        sheets: [
            { title: 'Fiche - Algèbre linéaire', url: 'FormulairesEtFiches/AlgèbreLinéaireFiche.pdf' }
        ]
    },
    {
        id: 'Alg',
        name: 'Algèbre',
        icon: 'fa-solid fa-calculator',
        lessons: [
            { title: 'Algèbre', url: 'cours/Algèbre.pdf' }
        ],
        exercises: [],
        sheets: [
            { title: 'Fiche - Algèbre', url: 'FormulairesEtFiches/AlgèbreFiche.pdf' }
        ]
    },
    {
        id: 'Analyse',
        name: 'Analyse',
        icon: 'fa-solid fa-chart-area',
        lessons: [
            { title: 'Analyse', url: 'cours/Analyse.pdf' }
        ],
        exercises: [],
        sheets: [
            { title: 'Fiche - Analyse', url: 'FormulairesEtFiches/AnalyseFiche.pdf' }
        ]
    },
    {
        id: 'ABG',
        name: 'Algèbre Bilinéaire et Géométrie',
        icon: 'fa-solid fa-vector-square',
        lessons: [
            { title: 'Chapitre 1 - Espaces Vectoriels, Applications Linéaires, Matrices', url: 'cours/chapitre1ABG.pdf' },
            { title: 'Chapitre 2 - Formes linéaires, Dualité, Transposition', url: 'cours/chapitre2ABG.pdf' },
            { title: 'Chapitre 3 - Formes Bilinéaires et quadratiques', url: 'cours/chapitre3ABG.pdf' }
        ],
        exercises: [],
        sheets: [
            { title: 'Fiche - ABG', url: 'FormulairesEtFiches/AlgèbreBilinéaireFiche.pdf' }
        ]
    },
    {
        id: 'APV',
        name: 'Analyse en Plusieurs Variables',
        icon: 'fa-solid fa-cubes',
        lessons: [
            { title: "Chapitre 0 - Vecteurs dans l'espace", url: 'cours/chapitre0APV.pdf' },
            { title: 'Chapitre 1 - Droites, Plans, Surface et Exemples', url: 'cours/chapitre1APV.pdf' },
            { title: 'Chapitre 2 - Espaces vectoriels normés - Notions métriques', url: 'cours/chapitre2APV.pdf' },
            { title: 'Chapitre 3 - Applications Continues en Dimension Finie', url: 'cours/chapitre3APV.pdf' },
            { title: 'Chapitre 4 - Dérivées partielles, différentielle', url: 'cours/chapitre4APV.pdf' },
            { title: "Chapitre 5 - Étude d'extrema d'une Fonction de Plusieurs Variables", url: 'cours/chapitre5APV.pdf' }
        ],
        exercises: [],
        sheets: [
            { title: 'Fiche - APV', url: 'FormulairesEtFiches/APVFiche.pdf' }
        ]
    },
    {
        id: 'Proba',
        name: 'Probabilités',
        icon: 'fa-solid fa-dice',
        lessons: [
            { title: 'Probabilités', url: 'cours/Probabilités.pdf' }
        ],
        exercises: [],
        sheets: [
            { title: 'Fiche - Probabilités', url: 'FormulairesEtFiches/ProbabilitésFiche.pdf' }
        ]
    },
    {
        id: 'CG',
        name: 'Configurations Géométriques',
        icon: 'fa-solid fa-shapes',
        lessons: [
            { title: 'Configuration Géométriques', url: 'cours/ConfigurationGéométrique.pdf' }
        ],
        exercises: [],
        sheets: [
            { title: 'Fiche - Configurations Géométriques', url: 'FormulairesEtFiches/CGFiche.pdf' }
        ]
    },
    {
        id: 'StatInf',
        name: 'Statistiques Inférentielles',
        icon: 'fa-solid fa-chart-pie',
        lessons: [
            { title: 'Statistiques Inférentielles', url: 'cours/StatistiquesInférentielles.pdf' },
            { title: 'Tables des Lois', url: 'cours/TablesdesLois.pdf' }
        ],
        exercises: [],
        sheets: [
            { title: 'Fiche - Statistiques Inférentielles', url: 'FormulairesEtFiches/StatistiquesInférentiellesFiche.pdf' }
        ]
    }
];

let myCourses = JSON.parse(JSON.stringify(LEGACY_COURSES));

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

const projectStatusLabels = {
    available: 'Disponible',
    development: 'En développement',
    prototype: 'Prototype',
    archived: 'Archivé'
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
            ? `<img src="${project.logoUrl}" alt="" class="project-logo" loading="lazy">`
            : `<i class="${project.icon}" aria-hidden="true"></i>`;
        const tags = project.tags.map(tag => `<span class="tech-chip">${tag}</span>`).join('');
        const download = safeExternalLink(project.appUrl)
            ? `<a href="${project.appUrl}" class="primary-btn" target="_blank" rel="noopener"><i class="fa-solid fa-download"></i> Télécharger</a>`
            : '';
        const source = safeExternalLink(project.devUrl)
            ? `<a href="${project.devUrl}" class="project-mini-link" target="_blank" rel="noopener" title="Code source" aria-label="Code source de ${project.name}"><i class="fa-solid fa-code"></i></a>`
            : '';

        return `
            <article class="project-card">
                <div class="project-card-top">
                    <div class="project-media">${mediaElement}</div>
                    <span class="project-status ${status}">${projectStatusLabels[status] || 'Projet'}</span>
                </div>
                <div class="project-card-body">
                    <span class="project-category">${categoryLabels[project.category] || 'Projet'}</span>
                    <h2>${project.name}</h2>
                    <p class="project-desc">${project.description}</p>
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

    if (emptyState) emptyState.hidden = filtered.length !== 0;
}

function openProjectModal(index) {
    const project = myProjects[index];
    const modal = document.getElementById('projectModal');
    const body = document.getElementById('project-modal-body');
    if (!project || !modal || !body) return;

    const status = projectStatus(project);
    const mediaElement = project.logoUrl
        ? `<img src="${project.logoUrl}" alt="">`
        : `<i class="${project.icon}" aria-hidden="true"></i>`;
    const tags = project.tags.map(tag => `<span class="tech-chip">${tag}</span>`).join('');
    const features = project.features.map(feature => `<li><i class="fa-solid fa-check"></i><span>${feature}</span></li>`).join('');

    const actions = [];
    if (safeExternalLink(project.appUrl)) {
        actions.push(`<a href="${project.appUrl}" class="primary-btn" target="_blank" rel="noopener"><i class="fa-solid fa-download"></i> Télécharger</a>`);
    }
    if (safeExternalLink(project.devUrl)) {
        actions.push(`<a href="${project.devUrl}" class="secondary-btn" target="_blank" rel="noopener"><i class="fa-solid fa-code"></i> Code source</a>`);
    }
    if (!actions.length) {
        actions.push('<span class="project-unavailable"><i class="fa-solid fa-clock"></i> Liens non disponibles pour le moment</span>');
    }

    body.innerHTML = `
        <div class="project-modal-header">
            <div class="project-modal-media">${mediaElement}</div>
            <div>
                <span class="project-status ${status}">${projectStatusLabels[status] || 'Projet'}</span>
                <h2 id="project-modal-title">${project.name}</h2>
                <p>${project.description}</p>
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
    if (event && event.target !== event.currentTarget) return;
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
   INFORMATIONS GÉNÉRALES
========================================================== */
function renderGeneralInfo() {
    const container = document.getElementById('general-info-container');
    if (!container) return;

    const publishedInfo = generalInfo.filter(info => {
        const cleaned = String(info.text || '').replace(/\./g, '').trim();
        return cleaned.length > 0;
    });

    if (!publishedInfo.length) {
        container.innerHTML = `
            <div class="info-block">
                <h3 class="info-block-title"><i class="fa-regular fa-circle-check"></i> Rien à signaler</h3>
                <p class="info-block-text">Aucune information particulière n'est publiée pour le moment.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = publishedInfo.map(info => {
        const imageHtml = info.imageUrl ? `<img src="${info.imageUrl}" alt="${info.title}" class="info-block-img" loading="lazy">` : '';
        return `
            <article class="info-block">
                <h3 class="info-block-title"><i class="${info.icon}"></i>${info.title}</h3>
                <p class="info-block-text">${info.text}</p>
                ${imageHtml}
            </article>
        `;
    }).join('');
}

/* ==========================================================
   COURS : AFFICHAGE PAR MATIÈRE
========================================================== */
function renderSubjects() {
    const subjectList = document.getElementById('subject-list');
    if (!subjectList) return;

    subjectList.innerHTML = myCourses.map((subject, index) => `
        <button class="subject-btn ${index === currentSubjectIndex ? 'active' : ''}" type="button" onclick="selectSubject(${index})">
            <i class="${subject.icon}"></i><span>${subject.name}</span>
        </button>
    `).join('');

    const label = document.getElementById('subject-total-label');
    if (label) label.textContent = `${myCourses.length} matière${myCourses.length > 1 ? 's' : ''}`;

    if (!myCourses.length) {
        const title = document.getElementById('current-subject-title');
        if (title) title.textContent = 'Aucune matière publiée';
        ['lessons-list', 'exercises-list', 'sheets-list'].forEach(id => {
            const list = document.getElementById(id);
            if (list) list.innerHTML = '<li class="list-empty">Aucun document</li>';
        });
        ['lessons', 'exercises', 'sheets'].forEach(key => {
            const count = document.getElementById(`count-${key}`);
            if (count) count.textContent = '0';
        });
        closePdf();
        return;
    }

    currentSubjectIndex = Math.min(currentSubjectIndex, myCourses.length - 1);
    selectSubject(currentSubjectIndex, currentSubjectTab);
}

function createDocumentList(items, emptyLabel) {
    if (!items.length) return `<li class="list-empty">${emptyLabel}</li>`;

    return items.map(item => `
        <li>
            <button class="pdf-item" type="button" data-title="${escapeHtmlAttribute(item.title)}" data-url="${escapeHtmlAttribute(item.url)}">
                <span><i class="fa-regular fa-file-lines"></i>${item.title}</span>
                <i class="fa-solid fa-eye" aria-hidden="true"></i>
            </button>
        </li>
    `).join('');
}

document.addEventListener('click', event => {
    const documentButton = event.target.closest('.pdf-item[data-url]');
    if (!documentButton) return;
    openPdf(documentButton.dataset.title || 'Document', documentButton.dataset.url || '');
});

function selectSubject(index, preferredTab = 'lessons') {
    if (!myCourses[index]) return;
    currentSubjectIndex = index;
    currentSubjectTab = preferredTab;
    const subject = myCourses[index];

    document.querySelectorAll('.subject-btn').forEach((btn, idx) => {
        btn.classList.toggle('active', idx === index);
    });

    const title = document.getElementById('current-subject-title');
    if (title) title.textContent = subject.name;

    const lessonsList = document.getElementById('lessons-list');
    const exercisesList = document.getElementById('exercises-list');
    const sheetsList = document.getElementById('sheets-list');

    if (lessonsList) lessonsList.innerHTML = createDocumentList(subject.lessons, 'Aucun cours enregistré');
    if (exercisesList) exercisesList.innerHTML = createDocumentList(subject.exercises, 'Aucun exercice enregistré');
    if (sheetsList) sheetsList.innerHTML = createDocumentList(subject.sheets, 'Aucune fiche enregistrée');

    const counts = {
        lessons: subject.lessons.length,
        exercises: subject.exercises.length,
        sheets: subject.sheets.length
    };
    Object.entries(counts).forEach(([key, value]) => {
        const element = document.getElementById(`count-${key}`);
        if (element) element.textContent = value;
    });

    closePdf();
    switchSubjectTab(preferredTab);
}

function switchMainCourseTab(tabId) {
    const tabCourses = document.getElementById('courses-content');
    const tabInfo = document.getElementById('global-info-content');
    const btnCourses = document.getElementById('btn-tab-courses');
    const btnInfo = document.getElementById('btn-tab-global-info');
    const showCourses = tabId === 'courses-content';

    if (tabCourses) tabCourses.hidden = !showCourses;
    if (tabInfo) tabInfo.hidden = showCourses;
    btnCourses?.classList.toggle('active', showCourses);
    btnInfo?.classList.toggle('active', !showCourses);
}

function switchSubjectTab(tabType) {
    const tabs = {
        lessons: { panel: document.getElementById('subject-tab-lessons'), btn: document.getElementById('btn-tab-lessons') },
        exercises: { panel: document.getElementById('subject-tab-exercises'), btn: document.getElementById('btn-tab-exercises') },
        sheets: { panel: document.getElementById('subject-tab-sheets'), btn: document.getElementById('btn-tab-sheets') }
    };

    if (!tabs[tabType]) tabType = 'lessons';
    currentSubjectTab = tabType;

    Object.entries(tabs).forEach(([key, tab]) => {
        const active = key === tabType;
        if (tab.panel) tab.panel.hidden = !active;
        tab.btn?.classList.toggle('active', active);
    });
}

/* ==========================================================
   RECHERCHE GLOBALE DANS LES COURS
========================================================== */
const courseTypeLabels = {
    lessons: 'Cours',
    exercises: 'Exercice',
    sheets: 'Fiche'
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

        ['lessons', 'exercises', 'sheets'].forEach(type => {
            subject[type].forEach((item, itemIndex) => {
                entries.push({
                    kind: 'document',
                    subjectIndex,
                    subjectName: subject.name,
                    type,
                    itemIndex,
                    title: item.title,
                    url: item.url,
                    icon: type === 'lessons' ? 'fa-solid fa-book-open' : type === 'exercises' ? 'fa-solid fa-pen-ruler' : 'fa-solid fa-file-lines',
                    searchable: normalizeText(`${subject.name} ${item.title} ${courseTypeLabels[type]}`)
                });
            });
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
                    <i class="${entry.icon}"></i>
                    <span><strong>${entry.title}</strong><small>Ouvrir la matière</small></span>
                    <span class="course-search-type">Matière</span>
                </button>
            `;
        }

        return `
            <button type="button" class="course-search-item" onclick="openCourseSearchResult(${entry.subjectIndex}, '${entry.type}', ${entry.itemIndex})">
                <i class="${entry.icon}"></i>
                <span><strong>${entry.title}</strong><small>${entry.subjectName}</small></span>
                <span class="course-search-type">${courseTypeLabels[entry.type]}</span>
            </button>
        `;
    }).join('');
}

function openCourseSearchResult(subjectIndex, type, itemIndex) {
    const subject = myCourses[subjectIndex];
    if (!subject) return;

    navigateToSection('courses');
    switchMainCourseTab('courses-content');
    selectSubject(subjectIndex, type);

    const searchInput = document.getElementById('course-search');
    const results = document.getElementById('course-search-results');
    if (searchInput) searchInput.value = '';
    if (results) {
        results.hidden = true;
        results.innerHTML = '';
    }

    if (itemIndex >= 0 && subject[type]?.[itemIndex]) {
        const item = subject[type][itemIndex];
        window.setTimeout(() => openPdf(item.title, item.url), motionReduced ? 0 : 120);
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
function openPdf(title, url) {
    const viewerContainer = document.getElementById('viewer-container');
    const pdfFrame = document.getElementById('pdf-frame');
    const imgViewer = document.getElementById('img-viewer');
    const odtViewer = document.getElementById('odt-viewer');
    const pdfFileName = document.getElementById('pdf-file-name');
    const pdfExternalLink = document.getElementById('pdf-external-link');
    const odtDownloadLink = document.getElementById('odt-download-link');

    if (!viewerContainer || !pdfFrame || !imgViewer || !odtViewer) return;

    if (pdfFileName) pdfFileName.innerHTML = `<i class="fa-solid fa-file"></i> ${title}`;
    if (pdfExternalLink) pdfExternalLink.href = url;

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
        if (odtDownloadLink) odtDownloadLink.href = url;
        odtViewer.hidden = false;
    } else {
        pdfFrame.src = url;
        pdfFrame.hidden = false;
    }

    viewerContainer.hidden = false;
    viewerContainer.scrollIntoView({ behavior: motionReduced ? 'auto' : 'smooth', block: 'nearest' });
}

function closePdf() {
    const viewerContainer = document.getElementById('viewer-container');
    const pdfFrame = document.getElementById('pdf-frame');
    const imgViewer = document.getElementById('img-viewer');
    if (viewerContainer) viewerContainer.hidden = true;
    if (pdfFrame) pdfFrame.src = '';
    if (imgViewer) imgViewer.src = '';
}

window.selectSubject = selectSubject;
window.switchMainCourseTab = switchMainCourseTab;
window.switchSubjectTab = switchSubjectTab;
window.openCourseSearchResult = openCourseSearchResult;
window.openPdf = openPdf;
window.closePdf = closePdf;

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
    if (event && event.target !== event.currentTarget) return;
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
    const exerciseCount = myCourses.reduce((sum, subject) => sum + subject.exercises.length, 0);
    const sheetCount = myCourses.reduce((sum, subject) => sum + subject.sheets.length, 0);
    const documentCount = lessonCount + exerciseCount + sheetCount;
    const availableCount = myProjects.filter(project => projectStatus(project) === 'available').length;

    const values = {
        'stat-projects': myProjects.length,
        'stat-available': availableCount,
        'stat-subjects': myCourses.length,
        'stat-documents': documentCount,
        'study-subject-count': myCourses.length,
        'study-lesson-count': lessonCount,
        'study-exercise-count': exerciseCount,
        'study-sheet-count': sheetCount
    };

    Object.entries(values).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    });
}

/* ==========================================================
   TEXTE ROTATIF DU HERO
========================================================== */
const rotatingMessages = [
    'Étudiant en L3 de Mathématiques',
    "Créateur d'applications de bureau",
    "Concepteur d'outils d'automatisation",
    'Développement, jeux et expérimentation'
];

function startRotatingText() {
    const element = document.getElementById('rotating-text');
    if (!element) return;

    let index = 0;
    window.setInterval(() => {
        if (motionReduced) return;
        element.classList.add('switching');
        window.setTimeout(() => {
            index = (index + 1) % rotatingMessages.length;
            element.textContent = rotatingMessages[index];
            element.classList.remove('switching');
        }, 190);
    }, 3200);
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
        button.title = motionReduced ? 'Réactiver les animations' : 'Désactiver les animations';
        button.setAttribute('aria-label', button.title);
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
   SUPABASE : CHARGEMENT DU CONTENU PUBLIC
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
                    persistSession: false,
                    autoRefreshToken: true,
                    detectSessionInUrl: false
                }
            }
        );
    }
    return true;
}

function resetToLegacyContent() {
    myProjects = JSON.parse(JSON.stringify(LEGACY_PROJECTS));
    generalInfo = JSON.parse(JSON.stringify(LEGACY_GENERAL_INFO));
    myCourses = JSON.parse(JSON.stringify(LEGACY_COURSES));
    remoteContentInitialized = false;
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
        icon: row.icon || 'fa-solid fa-circle-info',
        title: row.title || '',
        text: row.text || '',
        imageUrl: row.image_url || '',
        imageStoragePath: row.image_storage_path || '',
        sortOrder: Number(row.sort_order || 0),
        isPublished: row.is_published !== false
    };
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
            exercises: [],
            sheets: []
        };

        documentRows
            .filter(doc => doc.subject_id === subject.id)
            .forEach(doc => {
                const type = ['lessons', 'exercises', 'sheets'].includes(doc.type) ? doc.type : 'lessons';
                course[type].push({
                    _dbId: doc.id,
                    title: doc.title || 'Document',
                    url: doc.url || '',
                    storagePath: doc.storage_path || '',
                    fileName: doc.file_name || '',
                    sortOrder: Number(doc.sort_order || 0)
                });
            });

        ['lessons', 'exercises', 'sheets'].forEach(type => {
            course[type].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, 'fr'));
        });
        return course;
    });
}

async function loadRemoteContent() {
    if (!initSupabaseClient()) {
        resetToLegacyContent();
        return false;
    }

    try {
        const settingsResult = await supabaseClient
            .from('site_settings')
            .select('content_initialized')
            .eq('id', 'main')
            .maybeSingle();

        if (settingsResult.error) throw settingsResult.error;
        remoteContentInitialized = Boolean(settingsResult.data?.content_initialized);
        if (!remoteContentInitialized) {
            resetToLegacyContent();
            return false;
        }

        const [subjectsResult, documentsResult, infosResult, projectsResult] = await Promise.all([
            supabaseClient.from('subjects').select('*').eq('is_published', true).order('sort_order').order('name'),
            supabaseClient.from('documents').select('*').eq('is_published', true).order('sort_order').order('title'),
            supabaseClient.from('info_blocks').select('*').eq('is_published', true).order('sort_order').order('id'),
            supabaseClient.from('projects').select('*').eq('is_published', true).order('sort_order').order('name')
        ]);

        const firstError = [subjectsResult, documentsResult, infosResult, projectsResult].find(result => result.error)?.error;
        if (firstError) throw firstError;

        myCourses = buildCoursesFromRows(subjectsResult.data || [], documentsResult.data || []);
        generalInfo = (infosResult.data || []).map(mapInfoRow);
        myProjects = (projectsResult.data || []).map(mapProjectRow);
        currentSubjectIndex = Math.min(currentSubjectIndex, Math.max(0, myCourses.length - 1));
        return true;
    } catch (error) {
        console.error('Impossible de charger le contenu Supabase :', error);
        resetToLegacyContent();
        return false;
    }
}

function refreshDynamicContent() {
    courseSearchEntries = getCourseSearchEntries();
    renderProjects();
    renderGeneralInfo();
    renderSubjects();
    updateStats();
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

function openAdminModal() {
    if (!adminModal) return;
    adminModal.classList.add('active');
    setBodyModalState();
    const configured = isSupabaseConfigured();
    const warning = document.getElementById('admin-config-warning');
    if (warning) warning.hidden = configured;
    if (adminAuthenticated) showAdminDashboard();
    else {
        adminLoginView.hidden = false;
        adminDashboard.hidden = true;
        window.setTimeout(() => document.getElementById('admin-password')?.focus(), 50);
    }
}

function closeAdminModal(event) {
    if (event && event.target !== event.currentTarget) return;
    adminModal?.classList.remove('active');
    setBodyModalState();
}

function showAdminDashboard() {
    adminLoginView.hidden = true;
    adminDashboard.hidden = false;
    const label = document.getElementById('admin-session-label');
    if (label) label.textContent = `Connecté en tant qu’administrateur — ${SUPABASE_CONFIG.adminEmail}`;
    const seedBanner = document.getElementById('admin-seed-banner');
    if (seedBanner) seedBanner.hidden = remoteContentInitialized;
    renderAdminAll();
}

async function verifyAdminRole() {
    if (!supabaseClient) return false;
    const { data, error } = await supabaseClient.rpc('is_site_admin');
    if (error) {
        console.error(error);
        return false;
    }
    return data === true;
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

        adminAuthenticated = true;
        document.getElementById('admin-password').value = '';
        await loadAdminCache();
        const settings = await supabaseClient.from('site_settings').select('content_initialized').eq('id', 'main').maybeSingle();
        remoteContentInitialized = Boolean(settings.data?.content_initialized);
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
    adminCache = { subjects: [], documents: [], infos: [], projects: [] };
    adminDashboard.hidden = true;
    adminLoginView.hidden = false;
    setAdminStatus('');
    document.getElementById('admin-password')?.focus();
}

function switchAdminTab(tabName) {
    document.querySelectorAll('.admin-tab').forEach(button => button.classList.toggle('active', button.dataset.adminTab === tabName));
    document.querySelectorAll('.admin-panel').forEach(panel => {
        const active = panel.id === `admin-panel-${tabName}`;
        panel.hidden = !active;
        panel.classList.toggle('active', active);
    });
}

async function loadAdminCache() {
    if (!adminAuthenticated || !supabaseClient) return;
    const [subjects, documents, infos, projects] = await Promise.all([
        supabaseClient.from('subjects').select('*').order('sort_order').order('name'),
        supabaseClient.from('documents').select('*').order('sort_order').order('title'),
        supabaseClient.from('info_blocks').select('*').order('sort_order').order('id'),
        supabaseClient.from('projects').select('*').order('sort_order').order('name')
    ]);
    const firstError = [subjects, documents, infos, projects].find(result => result.error)?.error;
    if (firstError) throw firstError;
    adminCache = {
        subjects: subjects.data || [],
        documents: documents.data || [],
        infos: infos.data || [],
        projects: projects.data || []
    };
}

function renderAdminAll() {
    if (!adminAuthenticated) return;
    renderAdminSubjects();
    renderAdminDocuments();
    renderAdminInfos();
    renderAdminProjects();
    populateAdminSubjectSelect();
}

function adminPublishedBadge(published) {
    return published
        ? '<span class="admin-badge published"><i class="fa-solid fa-eye"></i> Visible</span>'
        : '<span class="admin-badge draft"><i class="fa-solid fa-eye-slash"></i> Masqué</span>';
}

function populateAdminSubjectSelect() {
    const select = document.getElementById('admin-doc-subject');
    if (!select) return;
    const current = select.value;
    select.innerHTML = adminCache.subjects.map(subject => `<option value="${escapeHtmlAttribute(subject.id)}">${escapeHtmlAttribute(subject.name)}</option>`).join('');
    if (adminCache.subjects.some(subject => subject.id === current)) select.value = current;
}

function renderAdminDocuments() {
    const container = document.getElementById('admin-document-list');
    if (!container) return;
    const term = normalizeText(document.getElementById('admin-document-search')?.value || '');
    const subjectsById = Object.fromEntries(adminCache.subjects.map(subject => [subject.id, subject.name]));
    const rows = adminCache.documents.filter(doc => !term || normalizeText(`${doc.title} ${subjectsById[doc.subject_id] || ''} ${doc.type}`).includes(term));
    if (!rows.length) {
        container.innerHTML = '<div class="admin-empty"><i class="fa-regular fa-folder-open"></i><p>Aucun document.</p></div>';
        return;
    }
    container.innerHTML = rows.map(doc => `
        <article class="admin-row">
            <div class="admin-row-icon"><i class="fa-regular fa-file-lines"></i></div>
            <div class="admin-row-main"><strong>${escapeHtmlAttribute(doc.title)}</strong><span>${escapeHtmlAttribute(subjectsById[doc.subject_id] || doc.subject_id)} · ${courseTypeLabels[doc.type] || 'Document'}</span></div>
            ${adminPublishedBadge(doc.is_published)}
            <div class="admin-row-actions"><button type="button" class="icon-btn" onclick="editAdminDocument(${doc.id})" title="Modifier"><i class="fa-solid fa-pen"></i></button><button type="button" class="icon-btn danger-btn" onclick="deleteAdminDocument(${doc.id})" title="Supprimer"><i class="fa-solid fa-trash"></i></button></div>
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
            <div class="admin-row-actions"><button type="button" class="icon-btn" onclick="editAdminSubject('${escapeHtmlAttribute(subject.id)}')" title="Modifier"><i class="fa-solid fa-pen"></i></button><button type="button" class="icon-btn danger-btn" onclick="deleteAdminSubject('${escapeHtmlAttribute(subject.id)}')" title="Supprimer"><i class="fa-solid fa-trash"></i></button></div>
        </article>`;
    }).join('');
}

function renderAdminInfos() {
    const container = document.getElementById('admin-info-list');
    if (!container) return;
    if (!adminCache.infos.length) {
        container.innerHTML = '<div class="admin-empty"><i class="fa-regular fa-message"></i><p>Aucune information.</p></div>';
        return;
    }
    container.innerHTML = adminCache.infos.map(info => `
        <article class="admin-row">
            <div class="admin-row-icon"><i class="${escapeHtmlAttribute(info.icon || 'fa-solid fa-circle-info')}"></i></div>
            <div class="admin-row-main"><strong>${escapeHtmlAttribute(info.title)}</strong><span>${escapeHtmlAttribute((info.text || '').slice(0, 120))}${(info.text || '').length > 120 ? '…' : ''}</span></div>
            ${adminPublishedBadge(info.is_published)}
            <div class="admin-row-actions"><button type="button" class="icon-btn" onclick="editAdminInfo(${info.id})" title="Modifier"><i class="fa-solid fa-pen"></i></button><button type="button" class="icon-btn danger-btn" onclick="deleteAdminInfo(${info.id})" title="Supprimer"><i class="fa-solid fa-trash"></i></button></div>
        </article>`).join('');
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
            <div class="admin-row-actions"><button type="button" class="icon-btn" onclick="editAdminProject(${project.id})" title="Modifier"><i class="fa-solid fa-pen"></i></button><button type="button" class="icon-btn danger-btn" onclick="deleteAdminProject(${project.id})" title="Supprimer"><i class="fa-solid fa-trash"></i></button></div>
        </article>`;
    }).join('');
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
    document.getElementById('admin-doc-published').checked = true;
    document.getElementById('admin-document-form-title').textContent = 'Ajouter un document';
    populateAdminSubjectSelect();
}

function editAdminDocument(id) {
    const doc = adminCache.documents.find(item => Number(item.id) === Number(id));
    if (!doc) return;
    resetAdminDocumentForm();
    document.getElementById('admin-doc-id').value = doc.id;
    document.getElementById('admin-doc-storage-path').value = doc.storage_path || '';
    document.getElementById('admin-doc-title').value = doc.title || '';
    document.getElementById('admin-doc-subject').value = doc.subject_id || '';
    document.getElementById('admin-doc-type').value = doc.type || 'lessons';
    document.getElementById('admin-doc-url').value = doc.url || '';
    document.getElementById('admin-doc-order').value = doc.sort_order || 0;
    document.getElementById('admin-doc-published').checked = doc.is_published !== false;
    document.getElementById('admin-document-form-title').textContent = 'Modifier le document';
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
    document.getElementById('admin-info-icon').value = 'fa-solid fa-circle-info';
    document.getElementById('admin-info-order').value = '0';
    document.getElementById('admin-info-published').checked = true;
    document.getElementById('admin-info-form-title').textContent = 'Nouvelle information';
}

function editAdminInfo(id) {
    const info = adminCache.infos.find(item => Number(item.id) === Number(id));
    if (!info) return;
    resetAdminInfoForm();
    document.getElementById('admin-info-id').value = info.id;
    document.getElementById('admin-info-storage-path').value = info.image_storage_path || '';
    document.getElementById('admin-info-title').value = info.title || '';
    document.getElementById('admin-info-icon').value = info.icon || 'fa-solid fa-circle-info';
    document.getElementById('admin-info-text').value = info.text || '';
    document.getElementById('admin-info-image-url').value = info.image_url || '';
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
    const allowed = ['pdf', 'doc', 'docx', 'odt', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
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
    const seedBanner = document.getElementById('admin-seed-banner');
    if (seedBanner) seedBanner.hidden = remoteContentInitialized;
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
            uploaded = await uploadAdminFile(STORAGE_BUCKETS.documents, `documents/${document.getElementById('admin-doc-subject').value}`, file);
            url = uploaded.url;
            storagePath = uploaded.path;
        }
        if (!url) throw new Error('Choisissez un fichier ou renseignez une URL.');

        const payload = {
            title: document.getElementById('admin-doc-title').value.trim(),
            subject_id: document.getElementById('admin-doc-subject').value,
            type: document.getElementById('admin-doc-type').value,
            url,
            storage_path: storagePath || null,
            file_name: file?.name || old?.file_name || null,
            sort_order: Number(document.getElementById('admin-doc-order').value || 0),
            is_published: document.getElementById('admin-doc-published').checked
        };

        const result = id
            ? await supabaseClient.from('documents').update(payload).eq('id', id)
            : await supabaseClient.from('documents').insert(payload);
        if (result.error) throw result.error;

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
        const result = originalId
            ? await supabaseClient.from('subjects').update(payload).eq('id', originalId)
            : await supabaseClient.from('subjects').insert({ id, ...payload });
        if (result.error) throw result.error;
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
    const file = document.getElementById('admin-info-file').files?.[0];
    let imageUrl = document.getElementById('admin-info-image-url').value.trim();
    let storagePath = document.getElementById('admin-info-storage-path').value || '';
    let uploaded = null;
    try {
        setAdminBusy(true, 'Enregistrement de l’information…');
        if (file) {
            if (!isAllowedImageFile(file)) throw new Error('Format d’image non accepté ou image supérieure à 10 Mo.');
            uploaded = await uploadAdminFile(STORAGE_BUCKETS.assets, 'informations', file);
            imageUrl = uploaded.url;
            storagePath = uploaded.path;
        }
        const payload = {
            title: document.getElementById('admin-info-title').value.trim(),
            icon: document.getElementById('admin-info-icon').value.trim() || 'fa-solid fa-circle-info',
            text: document.getElementById('admin-info-text').value.trim(),
            image_url: imageUrl || null,
            image_storage_path: storagePath || null,
            sort_order: Number(document.getElementById('admin-info-order').value || 0),
            is_published: document.getElementById('admin-info-published').checked
        };
        const result = id
            ? await supabaseClient.from('info_blocks').update(payload).eq('id', id)
            : await supabaseClient.from('info_blocks').insert(payload);
        if (result.error) throw result.error;
        if (uploaded && old?.image_storage_path && old.image_storage_path !== uploaded.path) {
            await removeStorageFile(STORAGE_BUCKETS.assets, old.image_storage_path);
        }
        resetAdminInfoForm();
        hideAdminEditor('info');
        await afterAdminMutation(id ? 'Information modifiée.' : 'Information publiée.');
    } catch (error) {
        if (uploaded?.path) await removeStorageFile(STORAGE_BUCKETS.assets, uploaded.path);
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
        const result = id
            ? await supabaseClient.from('projects').update(payload).eq('id', id)
            : await supabaseClient.from('projects').insert(payload);
        if (result.error) throw result.error;
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
    if (!doc || !confirm(`Supprimer « ${doc.title} » de la bibliothèque ?`)) return;
    try {
        setAdminBusy(true, 'Suppression du document…');
        const { error } = await supabaseClient.from('documents').delete().eq('id', id);
        if (error) throw error;
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
    if (!confirm(`Supprimer la matière « ${subject.name} » ?`)) return;
    try {
        setAdminBusy(true, 'Suppression de la matière…');
        const { error } = await supabaseClient.from('subjects').delete().eq('id', id);
        if (error) throw error;
        await afterAdminMutation('Matière supprimée.');
    } catch (error) { setAdminStatus(error.message || 'Suppression impossible.', 'error'); }
    finally { setAdminBusy(false); }
}

async function deleteAdminInfo(id) {
    const info = adminCache.infos.find(item => Number(item.id) === Number(id));
    if (!info || !confirm(`Supprimer l’information « ${info.title} » ?`)) return;
    try {
        setAdminBusy(true, 'Suppression de l’information…');
        const { error } = await supabaseClient.from('info_blocks').delete().eq('id', id);
        if (error) throw error;
        await removeStorageFile(STORAGE_BUCKETS.assets, info.image_storage_path);
        await afterAdminMutation('Information supprimée.');
    } catch (error) { setAdminStatus(error.message || 'Suppression impossible.', 'error'); }
    finally { setAdminBusy(false); }
}

async function deleteAdminProject(id) {
    const project = adminCache.projects.find(item => Number(item.id) === Number(id));
    if (!project || !confirm(`Supprimer l’application « ${project.name} » ?`)) return;
    try {
        setAdminBusy(true, 'Suppression de l’application…');
        const { error } = await supabaseClient.from('projects').delete().eq('id', id);
        if (error) throw error;
        await removeStorageFile(STORAGE_BUCKETS.assets, project.logo_storage_path);
        await afterAdminMutation('Application supprimée.');
    } catch (error) { setAdminStatus(error.message || 'Suppression impossible.', 'error'); }
    finally { setAdminBusy(false); }
}

async function seedCurrentSiteContent() {
    if (!adminAuthenticated || !supabaseClient || remoteContentInitialized) return;
    if (!confirm('Importer le contenu actuellement codé dans le site vers Supabase ? Cette opération ne doit être faite qu’une seule fois.')) return;
    try {
        setAdminBusy(true, 'Import du contenu actuel…');

        // Si une précédente tentative s'est interrompue, on repart proprement tant que
        // le drapeau content_initialized est à false.
        const cleanupResults = await Promise.all([
            supabaseClient.from('documents').delete().gte('id', 0),
            supabaseClient.from('info_blocks').delete().gte('id', 0),
            supabaseClient.from('projects').delete().gte('id', 0)
        ]);
        const cleanupError = cleanupResults.find(result => result.error)?.error;
        if (cleanupError) throw cleanupError;
        const { error: subjectCleanupError } = await supabaseClient.from('subjects').delete().neq('id', '');
        if (subjectCleanupError) throw subjectCleanupError;

        const subjectRows = LEGACY_COURSES.map((subject, index) => ({
            id: subject.id,
            name: subject.name,
            icon: subject.icon,
            sort_order: index,
            is_published: true
        }));
        const { error: subjectError } = await supabaseClient.from('subjects').upsert(subjectRows, { onConflict: 'id' });
        if (subjectError) throw subjectError;

        const documentRows = [];
        LEGACY_COURSES.forEach((subject, subjectIndex) => {
            ['lessons', 'exercises', 'sheets'].forEach(type => {
                subject[type].forEach((doc, docIndex) => documentRows.push({
                    subject_id: subject.id,
                    type,
                    title: doc.title,
                    url: doc.url,
                    storage_path: null,
                    file_name: doc.url.split('/').pop(),
                    sort_order: docIndex,
                    is_published: true
                }));
            });
        });
        if (documentRows.length) {
            const { error } = await supabaseClient.from('documents').insert(documentRows);
            if (error) throw error;
        }

        const infoRows = LEGACY_GENERAL_INFO
            .filter(info => String(info.text || '').replace(/\./g, '').trim())
            .map((info, index) => ({
                title: info.title,
                text: info.text,
                icon: info.icon,
                image_url: info.imageUrl || null,
                sort_order: index,
                is_published: true
            }));
        if (infoRows.length) {
            const { error } = await supabaseClient.from('info_blocks').insert(infoRows);
            if (error) throw error;
        }

        const projectRows = LEGACY_PROJECTS.map((project, index) => ({
            name: project.name,
            description: project.description,
            icon: project.icon,
            category: project.category,
            status: safeExternalLink(project.appUrl) ? 'available' : 'development',
            tags: project.tags,
            features: project.features,
            logo_url: project.logoUrl || null,
            app_url: project.appUrl || null,
            dev_url: project.devUrl || null,
            sort_order: index,
            is_published: true
        }));
        const { error: projectError } = await supabaseClient.from('projects').insert(projectRows);
        if (projectError) throw projectError;

        const { error: settingsError } = await supabaseClient.from('site_settings').update({ content_initialized: true }).eq('id', 'main');
        if (settingsError) throw settingsError;
        remoteContentInitialized = true;
        await afterAdminMutation('Import terminé : le site est désormais piloté depuis l’administration.');
    } catch (error) {
        console.error(error);
        setAdminStatus(`Import interrompu : ${error.message || 'erreur inconnue'}`, 'error');
    } finally {
        setAdminBusy(false);
    }
}

// Wiring administration
adminModal?.addEventListener('click', closeAdminModal);
document.getElementById('admin-open-btn')?.addEventListener('click', openAdminModal);
document.getElementById('admin-close-btn')?.addEventListener('click', () => closeAdminModal());
document.getElementById('admin-login-form')?.addEventListener('submit', handleAdminLogin);
document.getElementById('admin-logout-btn')?.addEventListener('click', logoutAdmin);
document.getElementById('admin-seed-btn')?.addEventListener('click', seedCurrentSiteContent);
document.getElementById('admin-password-toggle')?.addEventListener('click', () => {
    const input = document.getElementById('admin-password');
    const button = document.getElementById('admin-password-toggle');
    if (!input || !button) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    button.innerHTML = input.type === 'password' ? '<i class="fa-regular fa-eye"></i>' : '<i class="fa-regular fa-eye-slash"></i>';
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
document.querySelectorAll('[data-admin-cancel]').forEach(button => button.addEventListener('click', () => hideAdminEditor(button.dataset.adminCancel)));
document.getElementById('admin-document-form')?.addEventListener('submit', handleDocumentSave);
document.getElementById('admin-subject-form')?.addEventListener('submit', handleSubjectSave);
document.getElementById('admin-info-form')?.addEventListener('submit', handleInfoSave);
document.getElementById('admin-project-form')?.addEventListener('submit', handleProjectSave);
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

/* ==========================================================
   RACCOURCIS CLAVIER & FERMETURES
========================================================== */
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
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
   INITIALISATION
========================================================== */
document.addEventListener('DOMContentLoaded', async () => {
    const savedTheme = localStorage.getItem('portfolio-accent-theme') || 'blue';
    applyTheme(savedTheme, false);

    const savedMotion = localStorage.getItem('portfolio-reduced-motion');
    const systemPrefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    motionReduced = savedMotion === null ? systemPrefersReduced : savedMotion === '1';

    initSupabaseClient();
    await loadRemoteContent();
    courseSearchEntries = getCourseSearchEntries();

    renderProjects();
    renderGeneralInfo();
    renderSubjects();
    updateStats();

    resizeCanvas();
    setMotionReduced(motionReduced, false);
    startRotatingText();

    document.getElementById('current-year').textContent = String(new Date().getFullYear());

    const initialHash = window.location.hash.replace('#', '');
    activateSection(VALID_SECTIONS.includes(initialHash) ? initialHash : 'about', { updateHash: false, scroll: false });
    refreshRevealElements();
});
