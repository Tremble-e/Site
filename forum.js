'use strict';

/* ==========================================================
   FORUM / COMPTES / COMMUNAUTÉ
   Ce module utilise le même client Supabase que script.js.
========================================================== */

const FORUM_PAGE_SIZE = 12;
const MEMBER_PAGE_SIZE = 20;
const FORUM_REACTIONS = {
    like: { icon: 'fa-regular fa-thumbs-up', label: 'Utile' },
    heart: { icon: 'fa-regular fa-heart', label: 'Merci' },
    insight: { icon: 'fa-regular fa-lightbulb', label: 'Intéressant' }
};

const forumState = {
    client: null,
    user: null,
    profile: null,
    isAdmin: false,
    isModerator: false,
    categories: [],
    adminCategories: [],
    currentView: 'discussions',
    currentCategoryId: null,
    currentCategory: null,
    currentTopicId: null,
    currentTopic: null,
    currentAuthorFilter: null,
    topicPage: 1,
    memberPage: 1,
    searchTerm: '',
    rawPosts: new Map(),
    profilesById: new Map(),
    reactionsByPost: new Map(),
    realtimeChannel: null,
    notificationChannel: null,
    realtimeRefreshTimer: null,
    initialized: false
};

function fEsc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function fAttr(value) { return fEsc(value); }

function fNorm(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function fRelativeDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    const diff = Date.now() - date.getTime();
    if (!Number.isFinite(diff)) return '—';
    if (diff < 60_000) return 'à l’instant';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `il y a ${days} j`;
    return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

function fFullDate(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

function fInitials(username) {
    const text = String(username || '?').trim();
    return text.slice(0, 2).toUpperCase();
}

function fAvatar(profile, extraClass = '') {
    const username = profile?.username || 'Membre';
    const cls = `member-avatar ${extraClass}`.trim();
    if (profile?.avatar_url) {
        return `<span class="${cls}"><img src="${fAttr(profile.avatar_url)}" alt="Avatar de ${fAttr(username)}" loading="lazy"></span>`;
    }
    return `<span class="${cls}" aria-hidden="true">${fEsc(fInitials(username))}</span>`;
}

function fRoleBadge(role) {
    if (role === 'admin') return '<span class="member-role admin"><i class="fa-solid fa-shield-halved"></i> Admin</span>';
    if (role === 'moderator') return '<span class="member-role moderator"><i class="fa-solid fa-gavel"></i> Modérateur</span>';
    return '<span class="member-role">Membre</span>';
}

function fSafeHttpUrl(value) {
    try {
        const u = new URL(String(value || '').trim());
        return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
    } catch { return ''; }
}

function renderForumText(raw) {
    const escaped = fEsc(raw || '');
    const inline = text => text
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

    const lines = escaped.split(/\r?\n/);
    const out = [];
    let listOpen = false;
    const closeList = () => {
        if (listOpen) { out.push('</ul>'); listOpen = false; }
    };

    for (const line of lines) {
        if (/^-\s+/.test(line)) {
            if (!listOpen) { out.push('<ul class="forum-markdown-list">'); listOpen = true; }
            out.push(`<li>${inline(line.replace(/^-\s+/, ''))}</li>`);
            continue;
        }
        closeList();
        if (/^&gt;\s?/.test(line)) out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`);
        else if (!line.trim()) out.push('<p>&nbsp;</p>');
        else out.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    return out.join('');
}

function renderForumMath(root = document) {
    if (!window.renderMathInElement) return;
    root.querySelectorAll?.('.forum-post-body, .member-profile-bio').forEach(element => {
        try {
            window.renderMathInElement(element, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true }
                ],
                throwOnError: false,
                ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
            });
        } catch (error) { console.warn('KaTeX :', error); }
    });
}

function forumClient() {
    if (!forumState.client) forumState.client = window.getSiteSupabase?.() || null;
    return forumState.client;
}

function forumToast(message) {
    if (typeof showToast === 'function') showToast(message);
    else console.info(message);
}

function isMissingForumRpc(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    return code === 'PGRST202' || /could not find the function|schema cache|function .* does not exist/i.test(message);
}

function forumAdminStatus(message = '', type = 'info') {
    const el = document.getElementById('forum-admin-backend-status');
    if (!el) return;
    el.hidden = !message;
    el.className = `forum-admin-backend-status ${type}`.trim();
    el.innerHTML = message ? `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info'}"></i><span>${fEsc(message)}</span>` : '';
}

const FORUM_ADMIN_DEBUG = true;
function forumAdminDebug(step, details = undefined) {
    if (!FORUM_ADMIN_DEBUG) return;
    const prefix = `[FORUM ADMIN DEBUG] ${step}`;
    if (details === undefined) console.log(prefix);
    else console.log(prefix, details);
}

async function invokeForumAdminAction(action, payload = {}) {
    const client = forumClient();
    forumAdminDebug(`invoke:start:${action}`, payload);
    if (!client) {
        forumAdminDebug(`invoke:no-client:${action}`);
        throw new Error('Client Supabase indisponible.');
    }

    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    forumAdminDebug(`invoke:session:${action}`, {
        hasSession: Boolean(sessionData?.session?.user),
        userId: sessionData?.session?.user?.id || null,
        sessionError: sessionError?.message || null
    });
    if (!sessionData?.session?.user) throw new Error('Session administrateur expirée. Reconnectez-vous.');

    const { data, error } = await client.functions.invoke('forum-admin', {
        body: { action, ...payload }
    });
    forumAdminDebug(`invoke:response:${action}`, { data, error });

    if (error) {
        let detail = error.message || 'Edge Function forum-admin indisponible.';
        try {
            const response = error.context;
            if (response?.clone) {
                const body = await response.clone().json();
                if (body?.error) detail = body.error;
            }
        } catch { /* réponse non JSON */ }
        throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    return data || {};
}

async function checkForumAdminBackend() {
    if (!forumClient() || !forumState.user) return false;
    try {
        const data = await invokeForumAdminAction('health');
        if (!data?.is_admin) {
            forumAdminStatus('Votre session est connectée mais le backend ne reconnaît pas ce compte comme administrateur.', 'error');
            return false;
        }
        forumAdminStatus('Administration serveur Supabase opérationnelle.', 'success');
        return true;
    } catch (error) {
        console.error('Backend forum-admin :', error);
        forumAdminStatus(`Backend administrateur indisponible : ${error.message}. Déployez l’Edge Function « forum-admin » fournie avec la V2.7.`, 'error');
        return false;
    }
}

function openModalById(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('active');
    if (typeof setBodyModalState === 'function') setBodyModalState();
}

function closeModalById(id) {
    document.getElementById(id)?.classList.remove('active');
    if (typeof setBodyModalState === 'function') setBodyModalState();
}

function setMessage(id, message = '', type = '') {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message;
    el.className = `account-message ${type}`.trim();
    el.hidden = !message;
}

function goToForum() {
    if (typeof navigateToSection === 'function') navigateToSection('forum');
    else window.location.hash = '#forum';
}

function setForumBreadcrumb(items = []) {
    const el = document.getElementById('forum-breadcrumb');
    if (!el) return;
    if (!items.length) {
        el.hidden = true;
        el.innerHTML = '';
        return;
    }
    const parts = ['<button type="button" data-forum-home><i class="fa-solid fa-house"></i> Forum</button>'];
    items.forEach(item => {
        parts.push('<i class="fa-solid fa-chevron-right"></i>');
        if (item.action) parts.push(`<button type="button" ${item.action}>${fEsc(item.label)}</button>`);
        else parts.push(`<span>${fEsc(item.label)}</span>`);
    });
    el.innerHTML = parts.join('');
    el.hidden = false;
}

function setForumLoading(label = 'Chargement…') {
    const container = document.getElementById('forum-content');
    if (container) container.innerHTML = `<div class="forum-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><span>${fEsc(label)}</span></div>`;
}

function forumErrorState(message, detail = '') {
    const container = document.getElementById('forum-content');
    if (!container) return;
    container.innerHTML = `<div class="forum-state"><i class="fa-solid fa-triangle-exclamation"></i><h3>${fEsc(message)}</h3><p>${fEsc(detail)}</p></div>`;
}

function forumLoginState(message = 'Connectez-vous pour participer à la discussion.') {
    return `<div class="forum-state"><i class="fa-regular fa-user"></i><h3>Compte requis</h3><p>${fEsc(message)}</p><button type="button" class="primary-btn" data-open-account><i class="fa-solid fa-right-to-bracket"></i> Se connecter</button></div>`;
}

function setForumMainTab(view) {
    forumState.currentView = view;
    document.querySelectorAll('.forum-main-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.forumView === view));
    const search = document.getElementById('forum-search');
    if (search) search.placeholder = view === 'members' ? 'Rechercher un membre…' : 'Rechercher une discussion…';
    const newBtn = document.getElementById('forum-new-topic-btn');
    if (newBtn) newBtn.hidden = view === 'members';
}

/* ==========================================================
   AUTHENTIFICATION / PROFILS
========================================================== */

async function refreshCurrentAccount(session = null) {
    const client = forumClient();
    forumState.user = session?.user || null;
    forumState.profile = null;
    forumState.isAdmin = false;
    forumState.isModerator = false;

    if (forumState.user) {
        const [{ data: profile, error: profileError }, { data: admin }, { data: moderator }] = await Promise.all([
            client.from('profiles').select('*').eq('user_id', forumState.user.id).maybeSingle(),
            client.rpc('is_site_admin'),
            client.rpc('is_forum_moderator')
        ]);
        if (profileError) console.warn('Profil utilisateur indisponible :', profileError);
        forumState.profile = profile || null;
        forumState.isAdmin = admin === true;
        forumState.isModerator = moderator === true;
        if (profile) client.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('user_id', forumState.user.id).then(() => {});
    }

    updateAccountNavigation();
    await setupNotificationRealtime();
}

function updateAccountNavigation() {
    const btn = document.getElementById('account-btn');
    const notifications = document.getElementById('notification-btn');
    const myDiscussions = document.getElementById('my-discussions-btn');
    const privateMessages = document.getElementById('private-messages-btn');
    const adminBridge = document.getElementById('admin-open-btn');
    if (!btn) return;

    if (!forumState.user) {
        btn.classList.remove('has-avatar');
        btn.innerHTML = '<i class="fa-regular fa-user"></i>';
        btn.dataset.tooltip = 'Se connecter ou créer un compte';
        if (notifications) notifications.hidden = true;
        if (myDiscussions) myDiscussions.hidden = true;
        if (privateMessages) privateMessages.hidden = true;
        if (adminBridge) adminBridge.hidden = true;
        closeAccountPopover();
        closeNotificationPopover();
        return;
    }

    const p = forumState.profile || { username: forumState.user.email?.split('@')[0] || 'Membre' };
    btn.classList.toggle('has-avatar', Boolean(p.avatar_url));
    btn.innerHTML = p.avatar_url
        ? `<img src="${fAttr(p.avatar_url)}" alt="">`
        : `<span class="account-initial">${fEsc(fInitials(p.username))}</span>`;
    btn.dataset.tooltip = p.username || 'Mon compte';
    if (notifications) notifications.hidden = false;
    if (myDiscussions) myDiscussions.hidden = false;
    if (privateMessages) privateMessages.hidden = false;
    if (adminBridge) adminBridge.hidden = true;
    loadNotifications().catch(console.warn);
}

function renderAccountPopover() {
    const pop = document.getElementById('account-popover');
    if (!pop || !forumState.user) return;
    const p = forumState.profile || { username: 'Membre' };
    pop.innerHTML = `
        <div class="account-popover-head">
            ${fAvatar(p)}
            <div><strong>${fEsc(p.username || 'Membre')}</strong><small>${fEsc(forumState.user.email || '')}</small></div>
        </div>
        <button type="button" class="account-menu-action" data-account-action="profile"><i class="fa-solid fa-user-pen"></i> Modifier mon profil</button>
        <button type="button" class="account-menu-action" data-account-action="public-profile"><i class="fa-regular fa-id-card"></i> Voir mon profil public</button>
        <button type="button" class="account-menu-action" data-account-action="my-topics"><i class="fa-regular fa-comments"></i> Mes discussions</button>
        ${forumState.isAdmin ? '<div class="account-menu-divider"></div><button type="button" class="account-menu-action" data-account-action="admin"><i class="fa-solid fa-shield-halved"></i> Administration</button>' : ''}
        <div class="account-menu-divider"></div>
        <button type="button" class="account-menu-action danger" data-account-action="logout"><i class="fa-solid fa-arrow-right-from-bracket"></i> Déconnexion</button>
    `;
}

function toggleAccountPopover() {
    if (!forumState.user) {
        openAccountModal('login');
        return;
    }
    const pop = document.getElementById('account-popover');
    if (!pop) return;
    const willOpen = pop.hidden;
    closeNotificationPopover();
    if (willOpen) renderAccountPopover();
    pop.hidden = !willOpen;
}

function closeAccountPopover() {
    const pop = document.getElementById('account-popover');
    if (pop) pop.hidden = true;
}

function openAccountModal(mode = 'login') {
    closeAccountPopover();
    const authView = document.getElementById('account-auth-view');
    const recoveryView = document.getElementById('account-recovery-view');
    const profileView = document.getElementById('account-profile-view');
    if (authView) authView.hidden = false;
    if (recoveryView) recoveryView.hidden = true;
    if (profileView) profileView.hidden = true;
    switchAuthTab(mode);
    setMessage('account-auth-message');
    openModalById('accountModal');
}

function switchAuthTab(tab) {
    const login = tab !== 'register';
    document.getElementById('account-tab-login')?.classList.toggle('active', login);
    document.getElementById('account-tab-register')?.classList.toggle('active', !login);
    const loginForm = document.getElementById('account-login-form');
    const registerForm = document.getElementById('account-register-form');
    const forgotForm = document.getElementById('account-forgot-form');
    if (loginForm) loginForm.hidden = !login;
    if (registerForm) registerForm.hidden = login;
    if (forgotForm) forgotForm.hidden = true;
}

async function handleAccountLogin(event) {
    event.preventDefault();
    const client = forumClient();
    setMessage('account-auth-message', 'Connexion…');
    const email = document.getElementById('account-login-email').value.trim();
    const password = document.getElementById('account-login-password').value;
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
        const msg = error.message?.includes('Invalid login credentials') ? 'E-mail ou mot de passe incorrect.' : error.message;
        setMessage('account-auth-message', msg || 'Connexion impossible.', 'error');
        return;
    }
    await refreshCurrentAccount(data.session);
    closeModalById('accountModal');
    forumToast(`Bienvenue ${forumState.profile?.username || ''}.`);
    refreshForumCurrentView();
}

async function handleAccountRegister(event) {
    event.preventDefault();
    const client = forumClient();
    const username = document.getElementById('account-register-username').value.trim();
    const email = document.getElementById('account-register-email').value.trim();
    const password = document.getElementById('account-register-password').value;
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) {
        setMessage('account-auth-message', 'Le pseudo contient des caractères non autorisés.', 'error');
        return;
    }
    setMessage('account-auth-message', 'Création du compte…');
    const redirectTo = `${window.location.origin}${window.location.pathname}#forum`;
    const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: { username }, emailRedirectTo: redirectTo }
    });
    if (error) {
        setMessage('account-auth-message', error.message || 'Création du compte impossible.', 'error');
        return;
    }
    if (data.session) {
        await refreshCurrentAccount(data.session);
        closeModalById('accountModal');
        forumToast('Compte créé avec succès.');
        refreshForumCurrentView();
    } else {
        setMessage('account-auth-message', 'Compte créé. Consultez votre e-mail pour confirmer votre adresse avant de vous connecter.', 'success');
    }
}

async function handleForgotPassword(event) {
    event.preventDefault();
    const client = forumClient();
    const email = document.getElementById('account-forgot-email').value.trim();
    const redirectTo = `${window.location.origin}${window.location.pathname}#forum`;
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
    setMessage('account-auth-message', error ? (error.message || 'Envoi impossible.') : 'Lien envoyé. Consultez votre boîte mail.', error ? 'error' : 'success');
}

function showPasswordRecovery() {
    const authView = document.getElementById('account-auth-view');
    const recoveryView = document.getElementById('account-recovery-view');
    const profileView = document.getElementById('account-profile-view');
    if (authView) authView.hidden = true;
    if (profileView) profileView.hidden = true;
    if (recoveryView) recoveryView.hidden = false;
    openModalById('accountModal');
    document.getElementById('account-recovery-password')?.focus();
}

async function handlePasswordRecovery(event) {
    event.preventDefault();
    const password = document.getElementById('account-recovery-password').value;
    const { error } = await forumClient().auth.updateUser({ password });
    if (error) setMessage('account-recovery-message', error.message, 'error');
    else {
        setMessage('account-recovery-message', 'Mot de passe modifié.', 'success');
        window.setTimeout(() => closeModalById('accountModal'), 700);
    }
}

function openProfileEditor() {
    if (!forumState.user || !forumState.profile) return;
    closeAccountPopover();
    document.getElementById('account-auth-view').hidden = true;
    document.getElementById('account-recovery-view').hidden = true;
    document.getElementById('account-profile-view').hidden = false;
    document.getElementById('account-profile-title').textContent = forumState.profile.username;
    document.getElementById('account-profile-email').textContent = forumState.user.email || '';
    document.getElementById('account-profile-username').value = forumState.profile.username || '';
    document.getElementById('account-profile-bio').value = forumState.profile.bio || '';
    document.getElementById('account-profile-website').value = forumState.profile.website_url || '';
    document.getElementById('account-profile-avatar').value = '';
    document.getElementById('account-profile-avatar-preview').innerHTML = forumState.profile.avatar_url
        ? `<img src="${fAttr(forumState.profile.avatar_url)}" alt="">`
        : fEsc(fInitials(forumState.profile.username));
    setMessage('account-profile-message');
    openModalById('accountModal');
}

async function handleProfileSave(event) {
    event.preventDefault();
    if (!forumState.user || !forumState.profile) return;
    const client = forumClient();
    const username = document.getElementById('account-profile-username').value.trim();
    const bio = document.getElementById('account-profile-bio').value.trim();
    const websiteInput = document.getElementById('account-profile-website').value.trim();
    const avatar = document.getElementById('account-profile-avatar').files?.[0];
    const website = websiteInput ? fSafeHttpUrl(websiteInput) : '';
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) {
        setMessage('account-profile-message', 'Pseudo invalide.', 'error');
        return;
    }
    if (websiteInput && !website) {
        setMessage('account-profile-message', 'L’adresse du site doit commencer par http:// ou https://.', 'error');
        return;
    }
    if (avatar && (!avatar.type.startsWith('image/') || avatar.size > 5 * 1024 * 1024)) {
        setMessage('account-profile-message', 'Avatar invalide ou supérieur à 5 Mo.', 'error');
        return;
    }

    setMessage('account-profile-message', 'Enregistrement…');
    let avatarUrl = forumState.profile.avatar_url || null;
    let avatarPath = forumState.profile.avatar_path || null;
    let uploadedPath = null;

    try {
        if (avatar) {
            const extension = (avatar.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
            uploadedPath = `${forumState.user.id}/avatar-${Date.now()}.${extension}`;
            const { error: uploadError } = await client.storage.from('avatars').upload(uploadedPath, avatar, { cacheControl: '3600', upsert: false });
            if (uploadError) throw uploadError;
            avatarUrl = client.storage.from('avatars').getPublicUrl(uploadedPath).data.publicUrl;
            avatarPath = uploadedPath;
        }

        const { error } = await client.from('profiles').update({
            username,
            bio,
            website_url: website || null,
            avatar_url: avatarUrl,
            avatar_path: avatarPath
        }).eq('user_id', forumState.user.id);
        if (error) throw error;

        if (uploadedPath && forumState.profile.avatar_path && forumState.profile.avatar_path !== uploadedPath) {
            client.storage.from('avatars').remove([forumState.profile.avatar_path]).then(() => {});
        }
        const { data: updated } = await client.from('profiles').select('*').eq('user_id', forumState.user.id).single();
        forumState.profile = updated;
        updateAccountNavigation();
        setMessage('account-profile-message', 'Profil enregistré.', 'success');
        window.setTimeout(() => closeModalById('accountModal'), 550);
        refreshForumCurrentView();
    } catch (error) {
        if (uploadedPath) client.storage.from('avatars').remove([uploadedPath]).then(() => {});
        const msg = error?.message?.includes('profiles_username_lower_uidx') ? 'Ce pseudo est déjà utilisé.' : (error.message || 'Enregistrement impossible.');
        setMessage('account-profile-message', msg, 'error');
    }
}

async function logoutForumAccount() {
    closeAccountPopover();
    await forumClient().auth.signOut();
    forumState.user = null;
    forumState.profile = null;
    forumState.isAdmin = false;
    forumState.isModerator = false;
    updateAccountNavigation();
    forumToast('Vous êtes déconnecté.');
    refreshForumCurrentView();
}

async function deleteOwnForumAccount() {
    if (!forumState.user) return openAccountModal('login');
    const username = forumState.profile?.username || 'votre compte';
    const accepted = await siteConfirm({
        title: `Supprimer ${username} ?`,
        message: 'Votre compte sera supprimé définitivement et vous serez immédiatement déconnecté.',
        detail: 'Vos sujets et messages publics resteront visibles sous « Utilisateur supprimé ». Votre profil, vos conversations privées, notifications et autres données personnelles seront supprimés. Cette action est irréversible.',
        confirmLabel: 'Supprimer définitivement',
        danger: true,
        icon: 'fa-solid fa-user-xmark'
    });
    if (!accepted) return;

    const button = document.getElementById('account-delete-btn');
    if (button) button.disabled = true;
    setMessage('account-profile-message', 'Suppression du compte…');
    try {
        await invokeForumAdminAction('self_delete');
        try { await forumClient().auth.signOut({ scope: 'local' }); } catch { /* le compte n’existe déjà plus côté serveur */ }
        forumState.user = null;
        forumState.profile = null;
        forumState.isAdmin = false;
        forumState.isModerator = false;
        closeModalById('accountModal');
        closeAccountPopover();
        updateAccountNavigation();
        forumToast('Votre compte a été supprimé.');
        refreshForumCurrentView();
    } catch (error) {
        console.error('Suppression de mon compte :', error);
        setMessage('account-profile-message', error.message || 'Suppression impossible.', 'error');
    } finally {
        if (button && forumState.user) button.disabled = false;
    }
}

/* ==========================================================
   NOTIFICATIONS
========================================================== */

async function loadNotifications() {
    if (!forumState.user) return;
    const { data, error } = await forumClient().from('notifications')
        .select('*')
        .eq('user_id', forumState.user.id)
        .order('created_at', { ascending: false })
        .limit(30);
    if (error) { console.warn(error); return; }
    renderNotifications(data || []);
}

function renderNotifications(items) {
    const badge = document.getElementById('notification-badge');
    const pop = document.getElementById('notification-popover');
    const unread = items.filter(item => !item.is_read).length;
    if (badge) {
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.hidden = unread === 0;
    }
    if (!pop) return;
    const rows = items.length ? items.map(item => `
        <button type="button" class="notification-item ${item.is_read ? '' : 'unread'}" data-notification-id="${item.id}" data-notification-topic="${fAttr(item.topic_id || '')}">
            <span class="notification-item-icon"><i class="${item.type === 'reaction' ? 'fa-regular fa-heart' : 'fa-regular fa-message'}"></i></span>
            <span><strong>${fEsc(item.message || 'Nouvelle notification')}</strong><small>${fRelativeDate(item.created_at)}</small></span>
        </button>
    `).join('') : '<div class="notification-empty">Aucune notification pour le moment.</div>';
    pop.innerHTML = `<div class="notification-head"><strong>Notifications</strong>${unread ? '<button type="button" data-notifications-read-all>Tout marquer comme lu</button>' : ''}</div><div class="notification-list">${rows}</div>`;
}

function toggleNotificationPopover() {
    if (!forumState.user) return;
    const pop = document.getElementById('notification-popover');
    if (!pop) return;
    const willOpen = pop.hidden;
    closeAccountPopover();
    pop.hidden = !willOpen;
    if (willOpen) loadNotifications();
}

function closeNotificationPopover() {
    const pop = document.getElementById('notification-popover');
    if (pop) pop.hidden = true;
}

async function openNotification(button) {
    const id = Number(button.dataset.notificationId || 0);
    const topicId = button.dataset.notificationTopic || '';
    if (id) await forumClient().from('notifications').update({ is_read: true }).eq('id', id);
    closeNotificationPopover();
    loadNotifications();
    if (topicId) {
        goToForum();
        await openForumTopic(topicId);
    }
}

async function markAllNotificationsRead() {
    if (!forumState.user) return;
    await forumClient().from('notifications').update({ is_read: true }).eq('user_id', forumState.user.id).eq('is_read', false);
    loadNotifications();
}

async function setupNotificationRealtime() {
    const client = forumClient();
    if (!client) return;
    if (forumState.notificationChannel) {
        await client.removeChannel(forumState.notificationChannel);
        forumState.notificationChannel = null;
    }
    if (!forumState.user) return;
    forumState.notificationChannel = client.channel(`notifications-${forumState.user.id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${forumState.user.id}` }, () => loadNotifications())
        .subscribe();
}

/* ==========================================================
   STATISTIQUES / CATÉGORIES
========================================================== */

async function loadForumStats() {
    const client = forumClient();
    const [members, topics, posts, categories] = await Promise.all([
        client.from('profiles').select('user_id', { count: 'exact', head: true }),
        client.from('forum_topics').select('id', { count: 'exact', head: true }).is('deleted_at', null),
        client.from('forum_posts').select('id', { count: 'exact', head: true }).is('deleted_at', null),
        client.from('forum_categories').select('id', { count: 'exact', head: true }).eq('is_active', true)
    ]);
    const firstError = [members, topics, posts, categories].find(x => x.error)?.error;
    if (firstError) throw firstError;
    document.getElementById('forum-stat-members').textContent = String(members.count || 0);
    document.getElementById('forum-stat-topics').textContent = String(topics.count || 0);
    document.getElementById('forum-stat-posts').textContent = String(posts.count || 0);
    document.getElementById('forum-stat-categories').textContent = String(categories.count || 0);
    return { members: members.count || 0, topics: topics.count || 0, posts: posts.count || 0, categories: categories.count || 0 };
}

async function loadForumCategories(force = false) {
    if (forumState.categories.length && !force) return forumState.categories;
    const { data, error } = await forumClient().from('forum_category_stats').select('*').order('sort_order').order('name');
    if (error) throw error;
    forumState.categories = data || [];
    return forumState.categories;
}

async function renderForumHome() {
    setForumMainTab('discussions');
    forumState.currentCategoryId = null;
    forumState.currentCategory = null;
    forumState.currentTopicId = null;
    forumState.currentTopic = null;
    forumState.currentAuthorFilter = null;
    forumState.topicPage = 1;
    setForumBreadcrumb([]);
    setForumLoading('Chargement des catégories…');
    try {
        const [categories] = await Promise.all([loadForumCategories(true), loadForumStats()]);
        const container = document.getElementById('forum-content');
        if (!categories.length) {
            container.innerHTML = '<div class="forum-state"><i class="fa-regular fa-comments"></i><h3>Aucune catégorie</h3><p>Le forum est installé, mais aucune catégorie n’est actuellement visible.</p></div>';
            return;
        }
        container.innerHTML = `<div class="forum-category-list">${categories.map(category => `
            <button type="button" class="forum-category-card" data-forum-category="${category.id}">
                <span class="forum-category-icon"><i class="${fAttr(category.icon || 'fa-solid fa-comments')}"></i></span>
                <span class="forum-category-copy"><h3>${fEsc(category.name)}</h3><p>${fEsc(category.description || '')}</p></span>
                <span class="forum-category-stats">
                    <span><strong>${Number(category.topic_count || 0)}</strong>sujets</span>
                    <span><strong>${Number(category.post_count || 0)}</strong>messages</span>
                </span>
            </button>
        `).join('')}</div>`;
    } catch (error) {
        console.error(error);
        forumErrorState('Forum non initialisé', 'Exécutez forum_setup.sql dans Supabase, puis actualisez la page.');
    }
}

/* ==========================================================
   LISTE DES SUJETS
========================================================== */

async function openForumCategory(categoryId) {
    const categories = await loadForumCategories();
    const category = categories.find(c => Number(c.id) === Number(categoryId));
    if (!category) return;
    setForumMainTab('discussions');
    forumState.currentCategoryId = Number(categoryId);
    forumState.currentCategory = category;
    forumState.currentTopicId = null;
    forumState.currentTopic = null;
    forumState.currentAuthorFilter = null;
    forumState.topicPage = 1;
    const search = document.getElementById('forum-search');
    if (search) search.value = forumState.searchTerm = '';
    setForumBreadcrumb([{ label: category.name }]);
    await renderTopicList();
}

async function renderTopicList({ authorId = forumState.currentAuthorFilter } = {}) {
    setForumLoading('Chargement des discussions…');
    const client = forumClient();
    const page = forumState.topicPage;
    const start = (page - 1) * FORUM_PAGE_SIZE;
    const end = start + FORUM_PAGE_SIZE - 1;
    let query = client.from('forum_topic_summaries').select('*', { count: 'exact' });
    if (forumState.currentCategoryId) query = query.eq('category_id', forumState.currentCategoryId);
    if (authorId) query = query.eq('author_id', authorId);
    if (forumState.searchTerm) query = query.ilike('title', `%${forumState.searchTerm.replace(/[%_]/g, '')}%`);
    query = query.order('is_pinned', { ascending: false }).order('last_post_at', { ascending: false }).range(start, end);
    const { data, error, count } = await query;
    if (error) { forumErrorState('Impossible de charger les discussions', error.message); return; }

    const heading = authorId
        ? `<div><h2><i class="fa-regular fa-comments"></i> Mes discussions</h2><p>${count || 0} sujet${count === 1 ? '' : 's'}</p></div>`
        : `<div><h2><i class="${fAttr(forumState.currentCategory?.icon || 'fa-solid fa-comments')}"></i> ${fEsc(forumState.currentCategory?.name || 'Discussions')}</h2><p>${count || 0} sujet${count === 1 ? '' : 's'}</p></div>`;

    const container = document.getElementById('forum-content');
    if (!data?.length) {
        container.innerHTML = `<div class="forum-view-heading">${heading}</div><div class="forum-state"><i class="fa-regular fa-message"></i><h3>Aucune discussion</h3><p>${forumState.searchTerm ? 'Aucun sujet ne correspond à cette recherche.' : 'Soyez le premier à lancer une discussion.'}</p>${forumState.user ? '<button type="button" class="primary-btn" data-new-topic-inline><i class="fa-solid fa-plus"></i> Nouveau sujet</button>' : '<button type="button" class="primary-btn" data-open-account>Se connecter</button>'}</div>`;
        return;
    }

    const totalPages = Math.max(1, Math.ceil((count || 0) / FORUM_PAGE_SIZE));
    container.innerHTML = `
        <div class="forum-view-heading">${heading}</div>
        <div class="topic-list">${data.map(topic => renderTopicCard(topic)).join('')}</div>
        ${renderPagination(page, totalPages, 'topic')}
    `;
}

function renderTopicCard(topic) {
    const replyCount = Math.max(0, Number(topic.post_count || 0) - 1);
    const author = topic.author_id
        ? `<button type="button" data-member-profile="${fAttr(topic.author_id)}">${fEsc(topic.author_username || 'Membre')}</button>`
        : '<span>Utilisateur supprimé</span>';
    return `
        <article class="topic-card" data-forum-topic="${fAttr(topic.id)}" tabindex="0" role="button">
            <div>
                <div class="topic-title-row">
                    ${topic.is_pinned ? '<span class="topic-badge pinned"><i class="fa-solid fa-thumbtack"></i> Épinglé</span>' : ''}
                    ${topic.is_solved ? '<span class="topic-badge solved"><i class="fa-solid fa-check"></i> Résolu</span>' : ''}
                    ${topic.is_locked ? '<span class="topic-badge locked"><i class="fa-solid fa-lock"></i> Verrouillé</span>' : ''}
                    <span class="topic-title">${fEsc(topic.title)}</span>
                </div>
                <div class="topic-meta">
                    <span>par ${author}</span>
                    <span>•</span><span>${fRelativeDate(topic.created_at)}</span>
                    ${forumState.currentCategoryId ? '' : `<span>•</span><span>${fEsc(topic.category_name || '')}</span>`}
                </div>
            </div>
            <div class="topic-side"><strong>${replyCount} réponse${replyCount === 1 ? '' : 's'}</strong><span>activité ${fRelativeDate(topic.last_post_at)}</span></div>
        </article>
    `;
}

function renderPagination(page, totalPages, type) {
    if (totalPages <= 1) return '';
    const min = Math.max(1, page - 2);
    const max = Math.min(totalPages, page + 2);
    let buttons = `<button class="forum-page-btn" data-page-type="${type}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>`;
    for (let p = min; p <= max; p++) buttons += `<button class="forum-page-btn ${p === page ? 'active' : ''}" data-page-type="${type}" data-page="${p}">${p}</button>`;
    buttons += `<button class="forum-page-btn" data-page-type="${type}" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>`;
    return `<div class="forum-pagination">${buttons}</div>`;
}

async function showMyTopics() {
    if (!forumState.user) return openAccountModal('login');
    closeAccountPopover();
    goToForum();
    setForumMainTab('discussions');
    forumState.currentCategoryId = null;
    forumState.currentCategory = null;
    forumState.currentTopicId = null;
    forumState.currentAuthorFilter = forumState.user.id;
    forumState.topicPage = 1;
    setForumBreadcrumb([{ label: 'Mes discussions' }]);
    await renderTopicList({ authorId: forumState.user.id });
}

/* ==========================================================
   DISCUSSION / MESSAGES
========================================================== */

async function openForumTopic(topicId) {
    setForumMainTab('discussions');
    forumState.currentTopicId = topicId;
    setForumLoading('Chargement de la discussion…');
    const client = forumClient();
    const { data: topic, error: topicError } = await client.from('forum_topic_summaries').select('*').eq('id', topicId).maybeSingle();
    if (topicError || !topic) {
        forumErrorState('Discussion introuvable', topicError?.message || 'Ce sujet a peut-être été supprimé.');
        return;
    }

    const { data: posts, error: postsError } = await client.from('forum_posts').select('*').eq('topic_id', topicId).order('created_at', { ascending: true });
    if (postsError) { forumErrorState('Impossible de charger les messages', postsError.message); return; }

    const authorIds = [...new Set((posts || []).map(p => p.author_id).filter(Boolean))];
    let memberRows = [];
    if (authorIds.length) {
        const { data } = await client.from('community_members').select('*').in('user_id', authorIds);
        memberRows = data || [];
    }
    const postIds = (posts || []).map(p => p.id);
    let reactions = [];
    if (postIds.length) {
        const { data } = await client.from('forum_reactions').select('*').in('post_id', postIds);
        reactions = data || [];
    }

    forumState.currentTopic = topic;
    forumState.currentCategoryId = Number(topic.category_id);
    forumState.currentCategory = (await loadForumCategories()).find(c => Number(c.id) === Number(topic.category_id)) || { id: topic.category_id, name: topic.category_name, icon: topic.category_icon };
    forumState.rawPosts = new Map((posts || []).map(p => [Number(p.id), p]));
    forumState.profilesById = new Map(memberRows.map(p => [p.user_id, p]));
    forumState.reactionsByPost = new Map();
    reactions.forEach(r => {
        const id = Number(r.post_id);
        const arr = forumState.reactionsByPost.get(id) || [];
        arr.push(r);
        forumState.reactionsByPost.set(id, arr);
    });

    setForumBreadcrumb([
        { label: topic.category_name || 'Catégorie', action: `data-forum-category="${topic.category_id}"` },
        { label: topic.title }
    ]);
    renderForumTopic();
}

function renderForumTopic() {
    const topic = forumState.currentTopic;
    if (!topic) return;
    const container = document.getElementById('forum-content');
    const canSolve = forumState.user && (forumState.user.id === topic.author_id || forumState.isModerator);
    const canModerate = forumState.isModerator;
    const posts = [...forumState.rawPosts.values()];

    const headerActions = `
        ${canSolve ? `<button type="button" class="forum-mini-btn ${topic.is_solved ? 'active' : ''}" data-topic-action="solved"><i class="fa-solid fa-check"></i> ${topic.is_solved ? 'Résolu' : 'Marquer résolu'}</button>` : ''}
        ${canModerate ? `<button type="button" class="forum-mini-btn ${topic.is_pinned ? 'active' : ''}" data-topic-action="pin"><i class="fa-solid fa-thumbtack"></i> ${topic.is_pinned ? 'Désépingler' : 'Épingler'}</button>` : ''}
        ${canModerate ? `<button type="button" class="forum-mini-btn ${topic.is_locked ? 'active' : ''}" data-topic-action="lock"><i class="fa-solid fa-lock"></i> ${topic.is_locked ? 'Déverrouiller' : 'Verrouiller'}</button>` : ''}
    `;

    container.innerHTML = `
        <article class="forum-topic-header glass-panel">
            <div class="forum-topic-header-top">
                <div>
                    <span class="section-kicker">${fEsc(topic.category_name || '')}</span>
                    <h2>${fEsc(topic.title)}</h2>
                    <div class="topic-meta"><span>créé par ${topic.author_id ? `<button type="button" data-member-profile="${fAttr(topic.author_id)}">${fEsc(topic.author_username || 'Membre')}</button>` : '<span>Utilisateur supprimé</span>'}</span><span>•</span><span>${fFullDate(topic.created_at)}</span></div>
                </div>
                <div class="forum-topic-actions">${headerActions}</div>
            </div>
        </article>
        <div class="forum-posts">${posts.map((post, index) => renderForumPost(post, index + 1)).join('')}</div>
        ${renderReplyPanel(topic)}
    `;
    renderForumMath(container);
    if (typeof window.renderForumReplyComposeContextV2 === 'function') window.renderForumReplyComposeContextV2();
}

function renderForumPost(post, number) {
    const profile = post.author_id
        ? (forumState.profilesById.get(post.author_id) || { user_id: post.author_id, username: 'Membre', role: 'member', created_at: post.created_at })
        : { user_id: null, username: 'Utilisateur supprimé', role: 'member', created_at: post.created_at };
    const reactions = forumState.reactionsByPost.get(Number(post.id)) || [];
    const mine = Boolean(post.author_id && forumState.user?.id === post.author_id);
    const canEdit = !post.deleted_at && forumState.user && (mine || forumState.isModerator) && (!forumState.currentTopic?.is_locked || forumState.isModerator);
    const canReply = !post.deleted_at && forumState.user && !forumState.profile?.is_banned && (!forumState.currentTopic?.is_locked || forumState.isModerator);
    const canReport = !post.deleted_at && forumState.user && !mine && Boolean(post.author_id);
    const role = profile.role || 'member';
    const reactionHtml = post.deleted_at ? '' : Object.entries(FORUM_REACTIONS).map(([key, meta]) => {
        const count = reactions.filter(r => r.reaction === key).length;
        const active = reactions.some(r => r.user_id === forumState.user?.id && r.reaction === key);
        return `<button type="button" class="reaction-btn ${active ? 'active' : ''}" data-reaction-post="${post.id}" data-reaction="${key}" data-tooltip="${fAttr(meta.label)}"><i class="${meta.icon}"></i> ${count}</button>`;
    }).join('');

    const authorHtml = post.author_id ? `
        <button type="button" data-member-profile="${fAttr(profile.user_id)}">
            ${fAvatar(profile)}
            <span><strong>${fEsc(profile.username || 'Membre')}</strong>${fRoleBadge(role)}<small>Membre depuis ${new Date(profile.created_at || post.created_at).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })}</small>${profile.message_count !== undefined ? `<small>${Number(profile.message_count || 0)} message${Number(profile.message_count || 0) === 1 ? '' : 's'}</small>` : ''}</span>
        </button>` : `
        <div class="forum-deleted-member">
            <span class="member-avatar"><i class="fa-solid fa-user-slash"></i></span>
            <strong>Utilisateur supprimé</strong>
            <small>Compte supprimé</small>
        </div>`;

    return `
        <article class="forum-post" id="forum-post-${post.id}">
            <aside class="forum-post-author">${authorHtml}</aside>
            <div class="forum-post-main">
                <div class="forum-post-head"><span>${fFullDate(post.created_at)}${post.updated_at && new Date(post.updated_at).getTime() - new Date(post.created_at).getTime() > 2000 ? ` · modifié ${fRelativeDate(post.updated_at)}` : ''}</span><span class="forum-post-number">#${number}</span></div>
                ${post.reply_to_post_id && typeof window.renderForumReplyReference === 'function' ? window.renderForumReplyReference(post.reply_to_post_id) : ''}
                <div class="forum-post-body ${post.deleted_at ? 'deleted' : ''}" data-post-body="${post.id}">${post.deleted_at ? '<p><i class="fa-regular fa-trash-can"></i> Ce message a été supprimé.</p>' : renderForumText(post.content)}</div>
                <div class="forum-post-foot">
                    <div class="forum-reactions">${reactionHtml}</div>
                    <div class="forum-post-actions">
                        ${canReply ? `<button type="button" class="forum-mini-btn reply-action" data-v2-reply-post="${post.id}" data-tooltip="Répondre à ce message"><i class="fa-solid fa-reply"></i> Répondre</button>` : ''}
                        ${canEdit ? `<button type="button" class="forum-mini-btn" data-edit-post="${post.id}"><i class="fa-regular fa-pen-to-square"></i> Modifier</button><button type="button" class="forum-mini-btn danger" data-delete-post="${post.id}"><i class="fa-regular fa-trash-can"></i> Supprimer</button>` : ''}
                        ${canReport ? `<button type="button" class="forum-mini-btn" data-report-post="${post.id}"><i class="fa-regular fa-flag"></i> Signaler</button>` : ''}
                    </div>
                </div>
            </div>
        </article>
    `;
}

function renderReplyPanel(topic) {
    if (topic.is_locked && !forumState.isModerator) {
        return '<div class="forum-reply-panel glass-panel"><div class="forum-state" style="min-height:150px"><i class="fa-solid fa-lock"></i><h3>Discussion verrouillée</h3><p>Il n’est plus possible de répondre à ce sujet.</p></div></div>';
    }
    if (!forumState.user) return `<div class="forum-reply-panel glass-panel">${forumLoginState('Connectez-vous pour répondre à cette discussion.')}</div>`;
    if (forumState.profile?.is_banned) return '<div class="forum-reply-panel glass-panel"><div class="forum-state" style="min-height:150px"><i class="fa-solid fa-ban"></i><h3>Compte suspendu</h3><p>Votre compte ne peut pas publier de nouveaux messages.</p></div></div>';
    return `
        <form id="forum-reply-form" class="forum-reply-panel glass-panel">
            <h3><i class="fa-solid fa-reply"></i> Répondre</h3>
            <div class="forum-editor-toolbar" data-editor-target="forum-reply-content">
                <button type="button" data-format="bold" data-tooltip="Gras"><i class="fa-solid fa-bold"></i></button>
                <button type="button" data-format="italic" data-tooltip="Italique"><i class="fa-solid fa-italic"></i></button>
                <button type="button" data-format="code" data-tooltip="Code"><i class="fa-solid fa-code"></i></button>
                <button type="button" data-format="math" data-tooltip="Formule mathématique"><i class="fa-solid fa-square-root-variable"></i></button>
                <button type="button" data-format="quote" data-tooltip="Citation"><i class="fa-solid fa-quote-left"></i></button>
                <button type="button" data-format="list" data-tooltip="Liste"><i class="fa-solid fa-list"></i></button>
            </div>
            <div id="forum-reply-context" class="forum-reply-compose-context" hidden></div>
            <textarea id="forum-reply-content" required rows="6" maxlength="10000" placeholder="Écrivez votre réponse…"></textarea>
            <div class="forum-reply-actions"><span class="forum-char-count"><span id="forum-reply-count">0</span> / 10000</span><button type="submit" class="primary-btn compact-btn"><i class="fa-solid fa-paper-plane"></i> Publier</button></div>
            <p id="forum-reply-message" class="account-message" hidden></p>
        </form>
    `;
}

async function handleReplySubmit(event) {
    event.preventDefault();
    if (!forumState.user || !forumState.currentTopicId) return openAccountModal('login');
    const textarea = document.getElementById('forum-reply-content');
    const content = textarea?.value.trim() || '';
    if (!content) return;
    setMessage('forum-reply-message', 'Publication…');
    const payload = { topic_id: forumState.currentTopicId, author_id: forumState.user.id, content };
    const replyContext = typeof window.getForumV2ReplyContext === 'function' ? window.getForumV2ReplyContext() : null;
    if (replyContext?.postId) payload.reply_to_post_id = Number(replyContext.postId);
    const { error } = await forumClient().from('forum_posts').insert(payload);
    if (error) {
        setMessage('forum-reply-message', error.message || 'Publication impossible.', 'error');
        return;
    }
    textarea.value = '';
    if (typeof window.clearForumV2ReplyContext === 'function') window.clearForumV2ReplyContext();
    await openForumTopic(forumState.currentTopicId);
    document.getElementById(`forum-post-${Math.max(...forumState.rawPosts.keys())}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function startEditPost(postId) {
    const post = forumState.rawPosts.get(Number(postId));
    const body = document.querySelector(`[data-post-body="${postId}"]`);
    if (!post || !body || post.deleted_at) return;
    body.innerHTML = `
        <div class="forum-post-edit">
            <div class="forum-editor-toolbar" data-editor-target="forum-edit-${postId}">
                <button type="button" data-format="bold"><i class="fa-solid fa-bold"></i></button>
                <button type="button" data-format="italic"><i class="fa-solid fa-italic"></i></button>
                <button type="button" data-format="code"><i class="fa-solid fa-code"></i></button>
                <button type="button" data-format="math"><i class="fa-solid fa-square-root-variable"></i></button>
            </div>
            <textarea id="forum-edit-${postId}" maxlength="10000">${fEsc(post.content)}</textarea>
            <div class="forum-post-edit-actions"><button type="button" class="secondary-btn compact-btn" data-cancel-edit-post="${postId}">Annuler</button><button type="button" class="primary-btn compact-btn" data-save-edit-post="${postId}"><i class="fa-solid fa-floppy-disk"></i> Enregistrer</button></div>
        </div>`;
    document.getElementById(`forum-edit-${postId}`)?.focus();
}

function cancelEditPost(postId) {
    const post = forumState.rawPosts.get(Number(postId));
    const body = document.querySelector(`[data-post-body="${postId}"]`);
    if (post && body) { body.innerHTML = renderForumText(post.content); renderForumMath(body.parentElement); }
}

async function saveEditPost(postId) {
    const textarea = document.getElementById(`forum-edit-${postId}`);
    const content = textarea?.value.trim() || '';
    if (!content) return forumToast('Le message ne peut pas être vide.');
    const { error } = await forumClient().from('forum_posts').update({ content }).eq('id', Number(postId));
    if (error) return forumToast(error.message || 'Modification impossible.');
    await openForumTopic(forumState.currentTopicId);
}

async function deleteForumPost(postId) {
    if (!(await siteConfirm({ title: 'Supprimer ce message ?', message: 'Le contenu sera masqué de la discussion.', detail: 'Le message restera indiqué comme supprimé et pourra être restauré par la modération.', confirmLabel: 'Supprimer', danger: true }))) return;
    const { error } = await forumClient().from('forum_posts').update({ deleted_at: new Date().toISOString() }).eq('id', Number(postId));
    if (error) return forumToast(error.message || 'Suppression impossible.');
    await openForumTopic(forumState.currentTopicId);
}

async function toggleReaction(postId, reaction) {
    if (!forumState.user) return openAccountModal('login');
    const current = (forumState.reactionsByPost.get(Number(postId)) || []).find(r => r.user_id === forumState.user.id);
    let result;
    if (current?.reaction === reaction) {
        result = await forumClient().from('forum_reactions').delete().eq('post_id', Number(postId)).eq('user_id', forumState.user.id);
    } else {
        result = await forumClient().from('forum_reactions').upsert({ post_id: Number(postId), user_id: forumState.user.id, reaction }, { onConflict: 'post_id,user_id' });
    }
    if (result.error) return forumToast(result.error.message || 'Réaction impossible.');
    await openForumTopic(forumState.currentTopicId);
}

async function toggleTopicAction(action) {
    const topic = forumState.currentTopic;
    if (!topic || !forumState.user) return;
    let payload = {};
    if (action === 'solved' && (forumState.user.id === topic.author_id || forumState.isModerator)) payload.is_solved = !topic.is_solved;
    if (action === 'pin' && forumState.isModerator) payload.is_pinned = !topic.is_pinned;
    if (action === 'lock' && forumState.isModerator) payload.is_locked = !topic.is_locked;
    if (!Object.keys(payload).length) return;
    const { error } = await forumClient().from('forum_topics').update(payload).eq('id', topic.id);
    if (error) return forumToast(error.message || 'Modification impossible.');
    await openForumTopic(topic.id);
}

/* ==========================================================
   CRÉATION DE SUJET / ÉDITEUR
========================================================== */

async function openTopicComposer() {
    if (!forumState.user) return openAccountModal('login');
    if (forumState.profile?.is_banned) return forumToast('Votre compte est suspendu.');
    const categories = await loadForumCategories(true);
    const select = document.getElementById('forum-topic-category');
    select.innerHTML = categories.filter(c => c.is_active !== false).map(c => `<option value="${c.id}">${fEsc(c.name)}</option>`).join('');
    if (forumState.currentCategoryId) select.value = String(forumState.currentCategoryId);
    document.getElementById('forum-topic-title').value = '';
    document.getElementById('forum-topic-content').value = '';
    setMessage('forum-topic-message');
    openModalById('forumComposerModal');
    setTimeout(() => document.getElementById('forum-topic-title')?.focus(), 40);
}

async function handleNewTopic(event) {
    event.preventDefault();
    if (!forumState.user) return openAccountModal('login');
    const categoryId = Number(document.getElementById('forum-topic-category').value);
    const title = document.getElementById('forum-topic-title').value.trim();
    const content = document.getElementById('forum-topic-content').value.trim();
    setMessage('forum-topic-message', 'Publication…');
    const { data, error } = await forumClient().rpc('create_forum_topic', { p_category_id: categoryId, p_title: title, p_content: content });
    if (error) {
        setMessage('forum-topic-message', error.message || 'Création impossible.', 'error');
        return;
    }
    closeModalById('forumComposerModal');
    await loadForumCategories(true);
    await loadForumStats().catch(() => {});
    await openForumTopic(data);
}

function applyEditorFormat(button) {
    const toolbar = button.closest('.forum-editor-toolbar');
    const target = document.getElementById(toolbar?.dataset.editorTarget || '');
    if (!target) return;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const selection = target.value.slice(start, end) || '';
    let replacement = selection;
    const format = button.dataset.format;
    if (format === 'bold') replacement = `**${selection || 'texte'}**`;
    if (format === 'italic') replacement = `*${selection || 'texte'}*`;
    if (format === 'code') replacement = `\`${selection || 'code'}\``;
    if (format === 'math') replacement = `$${selection || 'x^2'}$`;
    if (format === 'quote') replacement = (selection || 'citation').split('\n').map(line => `> ${line}`).join('\n');
    if (format === 'list') replacement = (selection || 'élément').split('\n').map(line => `- ${line}`).join('\n');
    target.setRangeText(replacement, start, end, 'end');
    target.focus();
    target.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ==========================================================
   SIGNALEMENTS
========================================================== */

function openReportModal(postId) {
    if (!forumState.user) return openAccountModal('login');
    document.getElementById('forum-report-post-id').value = String(postId);
    document.getElementById('forum-report-reason').value = 'spam';
    document.getElementById('forum-report-details').value = '';
    setMessage('forum-report-message');
    openModalById('forumReportModal');
}

async function handleReportSubmit(event) {
    event.preventDefault();
    const postId = Number(document.getElementById('forum-report-post-id').value);
    const reason = document.getElementById('forum-report-reason').value;
    const details = document.getElementById('forum-report-details').value.trim();
    const { error } = await forumClient().from('forum_reports').insert({ post_id: postId, reporter_id: forumState.user.id, reason, details });
    if (error) {
        const duplicate = error.code === '23505';
        setMessage('forum-report-message', duplicate ? 'Vous avez déjà signalé ce message.' : (error.message || 'Signalement impossible.'), 'error');
        return;
    }
    setMessage('forum-report-message', 'Signalement envoyé. Merci.', 'success');
    setTimeout(() => closeModalById('forumReportModal'), 650);
}

/* ==========================================================
   COMMUNAUTÉ / PROFILS PUBLICS
========================================================== */

async function renderCommunityMembers() {
    setForumMainTab('members');
    forumState.currentCategoryId = null;
    forumState.currentTopicId = null;
    forumState.currentAuthorFilter = null;
    setForumBreadcrumb([{ label: 'Membres' }]);
    setForumLoading('Chargement des membres…');
    let query = forumClient().from('community_members').select('*', { count: 'exact' });
    if (forumState.searchTerm) query = query.ilike('username', `%${forumState.searchTerm.replace(/[%_]/g, '')}%`);
    const start = (forumState.memberPage - 1) * MEMBER_PAGE_SIZE;
    const { data, error, count } = await query.order('message_count', { ascending: false }).order('created_at', { ascending: true }).range(start, start + MEMBER_PAGE_SIZE - 1);
    if (error) { forumErrorState('Impossible de charger les membres', error.message); return; }
    const totalPages = Math.max(1, Math.ceil((count || 0) / MEMBER_PAGE_SIZE));
    const container = document.getElementById('forum-content');
    if (!data?.length) {
        container.innerHTML = '<div class="forum-state"><i class="fa-solid fa-users"></i><h3>Aucun membre trouvé</h3><p>Essayez une autre recherche.</p></div>';
        return;
    }
    container.innerHTML = `
        <div class="community-heading"><div><h2>Communauté</h2><p>${count || 0} membre${count === 1 ? '' : 's'} inscrit${count === 1 ? '' : 's'}</p></div></div>
        <div class="community-list">${data.map(member => `
            <article class="community-member clickable" data-member-profile="${fAttr(member.user_id)}" tabindex="0" role="button">
                <div class="community-member-main">${fAvatar(member)}<div><strong>${fEsc(member.username)}</strong>${fRoleBadge(member.role)}<small>Inscrit ${fRelativeDate(member.created_at)}</small></div></div>
                <div class="community-stat"><strong>${Number(member.message_count || 0)}</strong><span>Messages</span></div>
                <div class="community-stat"><strong>${Number(member.topic_count || 0)}</strong><span>Sujets</span></div>
                <div class="community-stat"><strong>${Number(member.document_count || 0)}</strong><span>Documents</span></div>
                <div class="community-stat"><strong>${Number(member.reaction_count || 0)}</strong><span>Réactions</span></div>
            </article>`).join('')}</div>
        ${renderPagination(forumState.memberPage, totalPages, 'member')}
    `;
}

async function openMemberProfile(userId) {
    const client = forumClient();
    const [{ data: member, error }, { data: topics }] = await Promise.all([
        client.from('community_members').select('*').eq('user_id', userId).maybeSingle(),
        client.from('forum_topic_summaries').select('id,title,created_at,is_solved').eq('author_id', userId).order('created_at', { ascending: false }).limit(5)
    ]);
    if (error || !member) return forumToast('Profil indisponible.');
    const website = fSafeHttpUrl(member.website_url);
    const content = document.getElementById('member-profile-content');
    content.innerHTML = `
        <div class="member-profile-hero">
            ${fAvatar(member, 'large')}
            <div><h2 id="member-profile-title">${fEsc(member.username)}</h2>${fRoleBadge(member.role)}<p>Membre depuis ${new Date(member.created_at).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</p></div>
        </div>
        ${member.bio ? `<div class="member-profile-bio">${renderForumText(member.bio)}</div>` : '<div class="member-profile-bio"><p>Aucune biographie renseignée.</p></div>'}
        ${website ? `<p style="margin-top:.7rem"><a class="text-link" href="${fAttr(website)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-link"></i> Site / profil externe</a></p>` : ''}
        <div class="member-profile-stats">
            <div><strong>${Number(member.message_count || 0)}</strong><span>Messages</span></div>
            <div><strong>${Number(member.topic_count || 0)}</strong><span>Sujets</span></div>
            <div><strong>${Number(member.document_count || 0)}</strong><span>Documents distincts</span></div>
            <div><strong>${Number(member.reaction_count || 0)}</strong><span>Réactions reçues</span></div>
        </div>
        <div class="member-profile-recent"><h3>Dernières discussions</h3>${topics?.length ? topics.map(t => `<button type="button" class="member-profile-topic" data-profile-topic="${fAttr(t.id)}"><span>${t.is_solved ? '<i class="fa-solid fa-check" style="color:var(--success)"></i> ' : ''}${fEsc(t.title)}</span><small>${fRelativeDate(t.created_at)}</small></button>`).join('') : '<p class="form-help">Aucune discussion publiée.</p>'}</div>
    `;
    openModalById('memberProfileModal');
    renderForumMath(content);
}

/* ==========================================================
   ADMINISTRATION DU FORUM
========================================================== */

async function ensureForumAdminAccess() {
    const client = forumClient();
    if (!client) return false;
    try {
        const { data: sessionData } = await client.auth.getSession();
        const session = sessionData?.session || null;
        if (!session?.user) {
            forumToast('Session administrateur expirée. Reconnectez-vous.');
            return false;
        }
        const health = await invokeForumAdminAction('health');
        if (!health?.is_admin) {
            forumToast('Accès administrateur requis.');
            return false;
        }
        forumState.user = session.user;
        forumState.isAdmin = true;
        forumState.isModerator = true;
        return true;
    } catch (error) {
        console.error('Vérification administrateur serveur :', error);
        forumAdminStatus(`Backend administrateur indisponible : ${error.message}`, 'error');
        forumToast(error.message || 'Impossible de vérifier la session administrateur.');
        return false;
    }
}

async function loadForumAdmin() {
    if (!(await ensureForumAdminAccess())) return;
    const client = forumClient();
    await checkForumAdminBackend();
    const [categories, reports, stats] = await Promise.all([
        client.from('forum_categories').select('*').order('sort_order').order('name'),
        client.from('forum_reports').select('*').eq('status', 'open').order('created_at', { ascending: false }).limit(50),
        loadForumStats().catch(() => ({ members: 0, topics: 0, posts: 0, categories: 0 }))
    ]);
    if (categories.error) return;
    renderAdminForumStats(stats);
    renderAdminForumCategories(categories.data || []);
    await renderAdminReports(reports.data || []);
}

function renderAdminForumStats(stats) {
    const el = document.getElementById('admin-forum-stats');
    if (!el) return;
    el.innerHTML = `<div><strong>${stats.members || 0}</strong><span>Membres</span></div><div><strong>${stats.topics || 0}</strong><span>Sujets</span></div><div><strong>${stats.posts || 0}</strong><span>Messages</span></div><div><strong>${stats.categories || 0}</strong><span>Catégories</span></div>`;
}

function renderAdminForumCategories(categories) {
    forumState.adminCategories = Array.isArray(categories) ? categories : [];
    const el = document.getElementById('admin-forum-category-list');
    if (!el) return;
    el.innerHTML = categories.length ? categories.map(c => `
        <div class="admin-list-item">
            <div class="admin-item-main"><span class="admin-item-icon"><i class="${fAttr(c.icon)}"></i></span><div><strong>${fEsc(c.name)}</strong><small>${fEsc(c.slug)} · ordre ${Number(c.sort_order || 0)}</small></div></div>
            <div class="admin-item-actions">${c.is_active ? '<span class="admin-badge published">Visible</span>' : '<span class="admin-badge draft">Masquée</span>'}<button type="button" class="admin-icon-action" data-admin-edit-category="${c.id}" data-tooltip="Modifier"><i class="fa-solid fa-pen"></i></button><button type="button" class="admin-icon-action danger" data-admin-delete-category="${c.id}" data-tooltip="Supprimer"><i class="fa-solid fa-trash"></i></button></div>
        </div>`).join('') : '<div class="admin-empty">Aucune catégorie.</div>';
}

async function renderAdminReports(reports) {
    const el = document.getElementById('admin-forum-report-list');
    if (!el) return;
    if (!reports.length) { el.innerHTML = '<div class="admin-empty">Aucun signalement ouvert.</div>'; return; }
    const postIds = [...new Set(reports.map(r => r.post_id))];
    const reporterIds = [...new Set(reports.map(r => r.reporter_id))];
    const [{ data: posts }, { data: profiles }] = await Promise.all([
        forumClient().from('forum_posts').select('id,topic_id,content,deleted_at').in('id', postIds),
        forumClient().from('profiles').select('user_id,username').in('user_id', reporterIds)
    ]);
    const postMap = new Map((posts || []).map(p => [Number(p.id), p]));
    const profileMap = new Map((profiles || []).map(p => [p.user_id, p]));
    const labels = { spam: 'Spam', abuse: 'Comportement inapproprié', illegal: 'Contenu illégal', offtopic: 'Hors sujet', other: 'Autre' };
    el.innerHTML = reports.map(r => {
        const post = postMap.get(Number(r.post_id));
        return `<div class="admin-report-card"><strong>${fEsc(labels[r.reason] || r.reason)}</strong><p>Signalé par ${fEsc(profileMap.get(r.reporter_id)?.username || 'Membre')} · ${fRelativeDate(r.created_at)}</p><p>${fEsc((post?.content || '').slice(0, 180))}${(post?.content || '').length > 180 ? '…' : ''}</p>${r.details ? `<p><em>${fEsc(r.details)}</em></p>` : ''}<div class="admin-report-actions"><button class="secondary-btn compact-btn" type="button" data-admin-report-view="${fAttr(post?.topic_id || '')}">Voir</button>${post && !post.deleted_at ? `<button class="secondary-btn compact-btn" type="button" data-admin-report-hide="${r.id}" data-post-id="${r.post_id}">Masquer le message</button>` : ''}<button class="primary-btn compact-btn" type="button" data-admin-report-resolve="${r.id}">Résoudre</button><button class="secondary-btn compact-btn" type="button" data-admin-report-dismiss="${r.id}">Ignorer</button></div></div>`;
    }).join('');
}

function openAdminCategoryEditor(category = null) {
    const form = document.getElementById('admin-forum-category-form');
    form.hidden = false;
    document.getElementById('admin-forum-category-id').value = category?.id || '';
    document.getElementById('admin-forum-category-title').textContent = category ? 'Modifier la catégorie' : 'Nouvelle catégorie';
    document.getElementById('admin-forum-category-slug').value = category?.slug || '';
    document.getElementById('admin-forum-category-name').value = category?.name || '';
    document.getElementById('admin-forum-category-icon').value = category?.icon || 'fa-solid fa-comments';
    document.getElementById('admin-forum-category-order').value = Number(category?.sort_order || 0);
    document.getElementById('admin-forum-category-active').checked = category?.is_active !== false;
    document.getElementById('admin-forum-category-description').value = category?.description || '';
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveAdminCategory(event) {
    event.preventDefault();
    forumAdminDebug('category:submit-click');
    if (!(await ensureForumAdminAccess())) {
        forumAdminDebug('category:access-denied');
        return;
    }
    const id = Number(document.getElementById('admin-forum-category-id').value || 0);
    const category = {
        id: id || null,
        slug: document.getElementById('admin-forum-category-slug').value.trim().toLowerCase(),
        name: document.getElementById('admin-forum-category-name').value.trim(),
        icon: document.getElementById('admin-forum-category-icon').value.trim() || 'fa-solid fa-comments',
        sort_order: Number(document.getElementById('admin-forum-category-order').value || 0),
        is_active: document.getElementById('admin-forum-category-active').checked,
        description: document.getElementById('admin-forum-category-description').value.trim()
    };
    if (!category.slug || !category.name) return forumToast('Le nom et l’identifiant de la catégorie sont obligatoires.');

    try {
        await invokeForumAdminAction('category_save', { category });
    } catch (error) {
        console.error('Catégorie forum :', error);
        forumAdminStatus(`Catégorie non enregistrée : ${error.message}`, 'error');
        return forumToast(error.message || 'Enregistrement impossible.');
    }

    document.getElementById('admin-forum-category-form').hidden = true;
    forumState.categories = [];
    await loadForumAdmin();
    if (forumState.currentView === 'discussions' && !forumState.currentTopicId) await renderForumHome();
    forumToast(id ? 'Catégorie modifiée.' : 'Catégorie créée.');
}

async function deleteAdminCategory(id) {
    forumAdminDebug('category:delete-click', { id });
    if (!(await ensureForumAdminAccess())) {
        forumAdminDebug('category:delete-access-denied', { id });
        return;
    }
    const category = forumState.adminCategories.find(c => Number(c.id) === Number(id));
    const accepted = await siteConfirm({
        title: `Supprimer ${category?.name || 'cette catégorie'} ?`,
        message: 'La catégorie sera supprimée définitivement.',
        detail: 'Si elle contient des discussions, elles seront déplacées automatiquement vers une autre catégorie. La suppression est refusée uniquement s’il n’existe aucune autre catégorie.',
        confirmLabel: 'Supprimer la catégorie',
        danger: true,
        icon: 'fa-solid fa-folder-minus'
    });
    if (!accepted) return;

    let data;
    try {
        data = await invokeForumAdminAction('category_delete', { category_id: Number(id) });
    } catch (error) {
        console.error('Suppression catégorie forum :', error);
        forumAdminStatus(`Catégorie non supprimée : ${error.message}`, 'error');
        return forumToast(error.message || 'Suppression impossible.');
    }

    forumState.categories = [];
    await loadForumAdmin();
    if (forumState.currentView === 'discussions' && !forumState.currentTopicId) await renderForumHome();
    const moved = Number(data?.moved_topics || 0);
    forumToast(moved ? `Catégorie supprimée · ${moved} discussion${moved > 1 ? 's' : ''} déplacée${moved > 1 ? 's' : ''}.` : 'Catégorie supprimée.');
}

async function handleAdminReport(action, reportId, postId = null) {
    if (!forumState.isAdmin) return;
    if (action === 'hide' && postId) {
        const { error } = await forumClient().from('forum_posts').update({ deleted_at: new Date().toISOString() }).eq('id', Number(postId));
        if (error) return forumToast(error.message);
    }
    const status = action === 'dismiss' ? 'dismissed' : 'resolved';
    const { error } = await forumClient().from('forum_reports').update({ status, reviewed_by: forumState.user.id, resolved_at: new Date().toISOString() }).eq('id', Number(reportId));
    if (error) return forumToast(error.message);
    await loadForumAdmin();
}

async function loadAdminUsers() {
    if (!(await ensureForumAdminAccess())) return;
    await checkForumAdminBackend();
    const term = fNorm(document.getElementById('admin-user-search')?.value || '');
    const [{ data: profiles, error }, { data: stats }] = await Promise.all([
        forumClient().from('profiles').select('*').order('created_at', { ascending: false }),
        forumClient().from('community_members').select('*')
    ]);
    if (error) return forumToast(error.message || 'Impossible de charger les utilisateurs.');
    const statMap = new Map((stats || []).map(s => [s.user_id, s]));
    const users = (profiles || []).filter(p => !term || fNorm(p.username).includes(term));
    const el = document.getElementById('admin-user-list');
    el.innerHTML = users.length ? users.map(p => {
        const s = statMap.get(p.user_id) || {};
        const self = p.user_id === forumState.user?.id;
        return `<div class="admin-list-item admin-user-row">
            <div class="admin-item-main">${fAvatar(p)}<div><strong>${fEsc(p.username)}</strong><small>Inscrit ${fRelativeDate(p.created_at)}${p.is_banned ? ' · SUSPENDU' : ''}</small></div></div>
            <span class="admin-user-activity">${Number(s.message_count || 0)} msg · ${Number(s.topic_count || 0)} sujets · ${Number(s.document_count || 0)} docs</span>
            <select data-admin-user-role="${fAttr(p.user_id)}" ${self ? 'data-tooltip="Votre propre rôle ne devrait être modifié qu’avec précaution"' : ''}><option value="member" ${p.role === 'member' ? 'selected' : ''}>Membre</option><option value="moderator" ${p.role === 'moderator' ? 'selected' : ''}>Modérateur</option><option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Admin</option></select>
            <div class="admin-user-actions">
                <button type="button" class="${p.is_banned ? 'primary-btn' : 'secondary-btn'} compact-btn" data-admin-user-ban="${fAttr(p.user_id)}" data-user-name="${fAttr(p.username)}" data-banned="${p.is_banned ? '1' : '0'}" ${self ? 'disabled data-tooltip="Vous ne pouvez pas suspendre votre propre compte"' : ''}><i class="fa-solid ${p.is_banned ? 'fa-user-check' : 'fa-user-slash'}"></i> ${p.is_banned ? 'Réactiver' : 'Suspendre'}</button>
                <button type="button" class="admin-icon-action danger hard" data-admin-user-delete="${fAttr(p.user_id)}" data-user-name="${fAttr(p.username)}" data-avatar-path="${fAttr(p.avatar_path || '')}" ${self ? 'disabled data-tooltip="Vous ne pouvez pas supprimer votre propre compte"' : 'data-tooltip="Supprimer définitivement ce compte"'}><i class="fa-solid fa-user-xmark"></i></button>
            </div>
        </div>`;
    }).join('') : '<div class="admin-empty">Aucun utilisateur.</div>';
}

async function updateAdminUserRole(userId, role) {
    if (!(await ensureForumAdminAccess())) return;
    try {
        await invokeForumAdminAction('user_role', { user_id: userId, role });
        forumToast('Rôle mis à jour.');
        await loadAdminUsers();
    } catch (error) {
        console.error('Rôle utilisateur :', error);
        forumAdminStatus(`Rôle non modifié : ${error.message}`, 'error');
        forumToast(error.message || 'Modification impossible.');
        await loadAdminUsers();
    }
}

async function toggleAdminUserBan(button) {
    forumAdminDebug('user:suspend-click', {
        userId: button?.dataset?.adminUserBan || null,
        username: button?.dataset?.userName || null,
        currentlyBanned: button?.dataset?.banned || null
    });
    if (!(await ensureForumAdminAccess())) {
        forumAdminDebug('user:suspend-access-denied');
        return;
    }
    const userId = button.dataset.adminUserBan;
    const username = button.dataset.userName || 'ce membre';
    const banned = button.dataset.banned === '1';
    if (!banned) {
        const accepted = await siteConfirm({
            title: `Suspendre ${username} ?`,
            message: 'Le compte sera réellement bloqué dans Supabase Auth et ne pourra plus se reconnecter pendant la suspension.',
            detail: 'Ses données restent conservées. Vous pourrez le réactiver depuis cette page.',
            confirmLabel: 'Suspendre',
            danger: true,
            icon: 'fa-solid fa-user-slash'
        });
        if (!accepted) return;
    }

    button.disabled = true;
    try {
        await invokeForumAdminAction('user_suspend', { user_id: userId, suspended: !banned });
        forumToast(banned ? 'Compte réactivé.' : 'Compte suspendu.');
        await loadAdminUsers();
    } catch (error) {
        console.error('Suspension utilisateur :', error);
        forumAdminStatus(`Suspension non appliquée : ${error.message}`, 'error');
        forumToast(error.message || 'Modification impossible.');
    } finally {
        button.disabled = false;
    }
}

async function deleteAdminUser(button) {
    forumAdminDebug('user:delete-click', {
        userId: button?.dataset?.adminUserDelete || null,
        username: button?.dataset?.userName || null
    });
    if (!(await ensureForumAdminAccess())) {
        forumAdminDebug('user:delete-access-denied');
        return;
    }
    const userId = button.dataset.adminUserDelete;
    const username = button.dataset.userName || 'cet utilisateur';
    const accepted = await siteConfirm({
        title: `Supprimer ${username} ?`,
        message: 'Le compte Supabase Auth sera supprimé définitivement.',
        detail: 'Ses sujets et messages publics seront conservés sous « Utilisateur supprimé ». Ses données privées seront supprimées. Cette action est irréversible.',
        confirmLabel: 'Supprimer le compte',
        danger: true,
        icon: 'fa-solid fa-user-xmark'
    });
    if (!accepted) return;

    button.disabled = true;
    try {
        await invokeForumAdminAction('user_delete', { user_id: userId });
        forumToast(`Compte ${username} supprimé.`);
        await loadAdminUsers();
        await loadForumAdmin();
    } catch (error) {
        console.error('Suppression utilisateur :', error);
        forumAdminStatus(`Suppression impossible : ${error.message}`, 'error');
        forumToast(error.message || 'Suppression impossible.');
    } finally {
        button.disabled = false;
    }
}


/* ==========================================================
   TÉLÉCHARGEMENTS DE DOCUMENTS
========================================================== */

function recordDocumentDownload(documentId) {
    if (!forumState.user || !documentId) return;
    forumClient().rpc('record_document_download', { p_document_id: Number(documentId) }).then(({ error }) => {
        if (error) console.warn('Statistique de téléchargement :', error);
    });
}

/* ==========================================================
   REALTIME
========================================================== */

async function setupForumRealtime() {
    const client = forumClient();
    if (!client) return;
    if (forumState.realtimeChannel) await client.removeChannel(forumState.realtimeChannel);
    forumState.realtimeChannel = client.channel('forum-public-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_topics' }, scheduleForumRealtimeRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_posts' }, scheduleForumRealtimeRefresh)
        .subscribe();
}

function scheduleForumRealtimeRefresh() {
    clearTimeout(forumState.realtimeRefreshTimer);
    forumState.realtimeRefreshTimer = setTimeout(() => {
        const reply = document.getElementById('forum-reply-content');
        if (reply && reply.value.trim()) {
            forumToast('Nouveau message sur le forum. Votre brouillon a été conservé.');
            return;
        }
        refreshForumCurrentView();
    }, 450);
}

async function refreshForumCurrentView() {
    if (!document.getElementById('forum')?.classList.contains('active')) return;
    if (forumState.currentTopicId) return openForumTopic(forumState.currentTopicId);
    if (forumState.currentView === 'members') return renderCommunityMembers();
    if (forumState.currentAuthorFilter) return renderTopicList({ authorId: forumState.currentAuthorFilter });
    if (forumState.currentCategoryId) return renderTopicList();
    return renderForumHome();
}

/* ==========================================================
   ÉVÉNEMENTS
========================================================== */

function bindForumEvents() {
    forumAdminDebug('bindForumEvents:attached', {
        adminModal: Boolean(document.getElementById('adminModal')),
        adminDashboard: Boolean(document.getElementById('admin-dashboard'))
    });
    document.getElementById('account-btn')?.addEventListener('click', toggleAccountPopover);
    document.getElementById('notification-btn')?.addEventListener('click', toggleNotificationPopover);
    document.getElementById('account-close-btn')?.addEventListener('click', () => closeModalById('accountModal'));
    document.getElementById('member-profile-close')?.addEventListener('click', () => closeModalById('memberProfileModal'));
    document.getElementById('forum-composer-close')?.addEventListener('click', () => closeModalById('forumComposerModal'));
    document.getElementById('forum-topic-cancel')?.addEventListener('click', () => closeModalById('forumComposerModal'));
    document.getElementById('forum-report-close')?.addEventListener('click', () => closeModalById('forumReportModal'));
    document.getElementById('forum-report-cancel')?.addEventListener('click', () => closeModalById('forumReportModal'));
    document.getElementById('account-profile-cancel')?.addEventListener('click', () => closeModalById('accountModal'));
    document.getElementById('account-delete-btn')?.addEventListener('click', deleteOwnForumAccount);
    document.getElementById('my-discussions-btn')?.addEventListener('click', showMyTopics);

    document.querySelectorAll('[data-auth-tab]').forEach(btn => btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab)));
    document.getElementById('account-login-form')?.addEventListener('submit', handleAccountLogin);
    document.getElementById('account-register-form')?.addEventListener('submit', handleAccountRegister);
    document.getElementById('account-forgot-form')?.addEventListener('submit', handleForgotPassword);
    document.getElementById('account-recovery-form')?.addEventListener('submit', handlePasswordRecovery);
    document.getElementById('account-profile-form')?.addEventListener('submit', handleProfileSave);
    document.getElementById('account-forgot-btn')?.addEventListener('click', () => {
        document.getElementById('account-login-form').hidden = true;
        document.getElementById('account-register-form').hidden = true;
        document.getElementById('account-forgot-form').hidden = false;
        document.getElementById('account-forgot-email').value = document.getElementById('account-login-email').value || '';
    });
    document.getElementById('account-forgot-back')?.addEventListener('click', () => switchAuthTab('login'));

    document.getElementById('forum-new-topic-btn')?.addEventListener('click', openTopicComposer);
    document.getElementById('forum-topic-form')?.addEventListener('submit', handleNewTopic);
    document.getElementById('forum-report-form')?.addEventListener('submit', handleReportSubmit);

    document.querySelectorAll('[data-forum-view]').forEach(btn => btn.addEventListener('click', async () => {
        forumState.searchTerm = '';
        const search = document.getElementById('forum-search');
        if (search) search.value = '';
        if (btn.dataset.forumView === 'members') {
            forumState.memberPage = 1;
            await renderCommunityMembers();
        } else await renderForumHome();
    }));

    let searchTimer = null;
    document.getElementById('forum-search')?.addEventListener('input', event => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
            forumState.searchTerm = event.target.value.trim();
            if (forumState.currentView === 'members') {
                forumState.memberPage = 1;
                await renderCommunityMembers();
            } else {
                forumState.topicPage = 1;
                if (!forumState.currentCategoryId && !forumState.currentAuthorFilter && forumState.searchTerm) {
                    setForumBreadcrumb([{ label: 'Recherche' }]);
                    await renderTopicList();
                } else if (forumState.currentCategoryId || forumState.currentAuthorFilter || forumState.searchTerm) await renderTopicList();
                else await renderForumHome();
            }
        }, 260);
    });

    document.getElementById('admin-forum-category-form')?.addEventListener('submit', saveAdminCategory);
    document.getElementById('admin-forum-new-category')?.addEventListener('click', () => openAdminCategoryEditor());
    document.getElementById('admin-forum-category-cancel')?.addEventListener('click', () => document.getElementById('admin-forum-category-form').hidden = true);
    document.getElementById('admin-forum-category-cancel-x')?.addEventListener('click', () => document.getElementById('admin-forum-category-form').hidden = true);
    document.getElementById('admin-user-search')?.addEventListener('input', () => loadAdminUsers());
    document.querySelectorAll('.admin-tab').forEach(btn => btn.addEventListener('click', () => {
        if (btn.dataset.adminTab === 'forum') loadForumAdmin();
        if (btn.dataset.adminTab === 'users') loadAdminUsers();
    }));

    // Délégation pour les éléments dynamiques du forum.
    document.addEventListener('click', async event => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const accountAction = target.closest('[data-account-action]');
        if (accountAction) {
            const action = accountAction.dataset.accountAction;
            if (action === 'profile') openProfileEditor();
            if (action === 'public-profile') { closeAccountPopover(); openMemberProfile(forumState.user.id); }
            if (action === 'my-topics') showMyTopics();
            if (action === 'admin') { closeAccountPopover(); document.getElementById('admin-open-btn')?.click(); }
            if (action === 'logout') logoutForumAccount();
            return;
        }

        if (target.closest('[data-open-account]')) { openAccountModal('login'); return; }
        if (target.closest('[data-forum-home]')) { await renderForumHome(); return; }
        if (target.closest('[data-new-topic-inline]')) { await openTopicComposer(); return; }

        const category = target.closest('[data-forum-category]');
        if (category) { await openForumCategory(category.dataset.forumCategory); return; }

        const profile = target.closest('[data-member-profile]');
        if (profile) { event.stopPropagation(); await openMemberProfile(profile.dataset.memberProfile); return; }

        const topic = target.closest('[data-forum-topic]');
        if (topic) { await openForumTopic(topic.dataset.forumTopic); return; }

        const profileTopic = target.closest('[data-profile-topic]');
        if (profileTopic) { closeModalById('memberProfileModal'); goToForum(); await openForumTopic(profileTopic.dataset.profileTopic); return; }

        const page = target.closest('[data-page-type]');
        if (page && !page.disabled) {
            if (page.dataset.pageType === 'topic') { forumState.topicPage = Number(page.dataset.page); await renderTopicList(); }
            else { forumState.memberPage = Number(page.dataset.page); await renderCommunityMembers(); }
            document.getElementById('forum-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }

        const format = target.closest('.forum-editor-toolbar [data-format]');
        if (format) { applyEditorFormat(format); return; }

        const reaction = target.closest('[data-reaction-post]');
        if (reaction) { await toggleReaction(reaction.dataset.reactionPost, reaction.dataset.reaction); return; }

        const edit = target.closest('[data-edit-post]');
        if (edit) { startEditPost(edit.dataset.editPost); return; }
        const cancelEdit = target.closest('[data-cancel-edit-post]');
        if (cancelEdit) { cancelEditPost(cancelEdit.dataset.cancelEditPost); return; }
        const saveEdit = target.closest('[data-save-edit-post]');
        if (saveEdit) { await saveEditPost(saveEdit.dataset.saveEditPost); return; }
        const del = target.closest('[data-delete-post]');
        if (del) { await deleteForumPost(del.dataset.deletePost); return; }
        const report = target.closest('[data-report-post]');
        if (report) { openReportModal(report.dataset.reportPost); return; }
        const topicAction = target.closest('[data-topic-action]');
        if (topicAction) { await toggleTopicAction(topicAction.dataset.topicAction); return; }

        const notif = target.closest('[data-notification-id]');
        if (notif) { await openNotification(notif); return; }
        if (target.closest('[data-notifications-read-all]')) { await markAllNotificationsRead(); return; }

        const editCat = target.closest('[data-admin-edit-category]');
        if (editCat) {
            forumAdminDebug('event:edit-category', { id: editCat.dataset.adminEditCategory });
            const category = forumState.adminCategories.find(c => Number(c.id) === Number(editCat.dataset.adminEditCategory)) || null;
            if (!category) { forumToast('Catégorie introuvable. Rechargez l’administration.'); return; }
            openAdminCategoryEditor(category);
            return;
        }
        const deleteCat = target.closest('[data-admin-delete-category]');
        if (deleteCat) {
            forumAdminDebug('event:delete-category', { id: deleteCat.dataset.adminDeleteCategory });
            await deleteAdminCategory(deleteCat.dataset.adminDeleteCategory);
            return;
        }
        const reportView = target.closest('[data-admin-report-view]');
        if (reportView?.dataset.adminReportView) { closeModalById('adminModal'); goToForum(); await openForumTopic(reportView.dataset.adminReportView); return; }
        const reportHide = target.closest('[data-admin-report-hide]');
        if (reportHide) { await handleAdminReport('hide', reportHide.dataset.adminReportHide, reportHide.dataset.postId); return; }
        const reportResolve = target.closest('[data-admin-report-resolve]');
        if (reportResolve) { await handleAdminReport('resolve', reportResolve.dataset.adminReportResolve); return; }
        const reportDismiss = target.closest('[data-admin-report-dismiss]');
        if (reportDismiss) { await handleAdminReport('dismiss', reportDismiss.dataset.adminReportDismiss); return; }
        const ban = target.closest('[data-admin-user-ban]');
        if (ban) {
            forumAdminDebug('event:user-suspend', { userId: ban.dataset.adminUserBan, username: ban.dataset.userName });
            await toggleAdminUserBan(ban);
            return;
        }
        const deleteUser = target.closest('[data-admin-user-delete]');
        if (deleteUser) {
            forumAdminDebug('event:user-delete', { userId: deleteUser.dataset.adminUserDelete, username: deleteUser.dataset.userName });
            await deleteAdminUser(deleteUser);
            return;
        }
    });

    document.addEventListener('change', event => {
        const select = event.target.closest?.('[data-admin-user-role]');
        if (select) updateAdminUserRole(select.dataset.adminUserRole, select.value);
    });

    document.addEventListener('submit', event => {
        if (event.target?.id === 'forum-reply-form') handleReplySubmit(event);
    });

    document.addEventListener('input', event => {
        if (event.target?.id === 'forum-reply-content') {
            const count = document.getElementById('forum-reply-count');
            if (count) count.textContent = String(event.target.value.length);
        }
    });

    document.addEventListener('click', event => {
        const external = event.target.closest?.('#pdf-external-link, #odt-download-link, #resource-pdf-external-link, #resource-odt-download-link');
        if (external?.dataset.documentId) recordDocumentDownload(external.dataset.documentId);
    }, true);

    document.addEventListener('click', event => {
        if (!event.target.closest?.('.account-wrapper')) closeAccountPopover();
        if (!event.target.closest?.('.notification-wrapper')) closeNotificationPopover();
    });

    ['accountModal', 'forumComposerModal', 'memberProfileModal', 'forumReportModal'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', event => {
            if (event.target === event.currentTarget) closeModalById(id);
        });
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        closeAccountPopover();
        closeNotificationPopover();
        ['accountModal', 'forumComposerModal', 'memberProfileModal', 'forumReportModal'].forEach(closeModalById);
    });
}

/* ==========================================================
   INITIALISATION
========================================================== */

async function initForumModule() {
    if (forumState.initialized) return;
    forumState.initialized = true;
    const client = forumClient();
    if (!client) {
        forumErrorState('Supabase indisponible', 'Le forum nécessite la configuration Supabase du site.');
        return;
    }
    bindForumEvents();

    const { data: { session } } = await client.auth.getSession();
    await refreshCurrentAccount(session);

    client.auth.onAuthStateChange((event, newSession) => {
        // Évite de lancer des requêtes imbriquées directement dans le callback GoTrue.
        setTimeout(async () => {
            await refreshCurrentAccount(newSession);
            if (event === 'PASSWORD_RECOVERY') showPasswordRecovery();
            if (event === 'SIGNED_OUT') refreshForumCurrentView();
        }, 0);
    });

    await setupForumRealtime();
    await renderForumHome();
}

document.addEventListener('DOMContentLoaded', initForumModule);
