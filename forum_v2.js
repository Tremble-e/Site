'use strict';

/* ==========================================================
   FORUM V2
   - Références internes au site
   - Pièces jointes externes (URL uniquement)
   - Présence en ligne
   - Abonnements aux sujets
   - Historique des modifications
   - Badges
   - Messages privés
   - Administration complète des sujets/messages
========================================================== */

const forumV2State = {
    presenceChannel: null,
    privateChannel: null,
    onlineUsers: new Map(),
    referenceTargetId: '',
    referenceMode: 'all',
    referenceItems: [],
    referenceFilter: 'all',
    currentPrivateThreadId: null,
    currentPrivateOtherUser: null,
    adminTopicFilter: 'active',
    adminMessageFilter: 'visible',
    adminTopicSearch: '',
    adminMessageSearch: '',
    deepLinkHandled: false
};

function v2Esc(value) { return typeof fEsc === 'function' ? fEsc(value) : String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function v2Attr(value) { return v2Esc(value); }
function v2SafeUrl(value) { return typeof fSafeHttpUrl === 'function' ? fSafeHttpUrl(value) : ''; }
function v2Toast(message) { if (typeof forumToast === 'function') forumToast(message); else console.info(message); }
function v2Client() { return typeof forumClient === 'function' ? forumClient() : window.getSiteSupabase?.(); }

function v2RenderMath(root) {
    if (!window.renderMathInElement || !root) return;
    try {
        window.renderMathInElement(root, {
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\(', right: '\\)', display: false },
                { left: '\\[', right: '\\]', display: true }
            ],
            throwOnError: false,
            ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
        });
    } catch (error) { console.warn('KaTeX V2 :', error); }
}

function v2InsertAtCursor(textarea, text) {
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const padBefore = before && !/\s$/.test(before) ? ' ' : '';
    const padAfter = after && !/^\s/.test(after) ? ' ' : '';
    textarea.value = `${before}${padBefore}${text}${padAfter}${after}`;
    const cursor = (before + padBefore + text + padAfter).length;
    textarea.setSelectionRange(cursor, cursor);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
}

function v2IconForReference(kind) {
    return {
        project: 'fa-solid fa-laptop-code',
        document: 'fa-solid fa-file-lines',
        subject: 'fa-solid fa-graduation-cap',
        info: 'fa-solid fa-circle-info',
        topic: 'fa-solid fa-comments',
        post: 'fa-regular fa-message',
        member: 'fa-regular fa-user'
    }[kind] || 'fa-solid fa-link';
}

function v2LabelForReference(kind) {
    return {
        project: 'Application', document: 'Document', subject: 'Matière', info: 'Information',
        topic: 'Discussion', post: 'Message', member: 'Membre'
    }[kind] || 'Lien interne';
}

function v2RenderSpecialToken(token) {
    const refMatch = token.match(/^\[\[ref:(project|document|subject|info|topic|post|member):([^|\]]+)\|([^\]]+)\]\]$/i);
    if (refMatch) {
        const [, kind, id, label] = refMatch;
        return `<button type="button" class="forum-site-reference" data-site-ref-kind="${v2Attr(kind.toLowerCase())}" data-site-ref-id="${v2Attr(id)}" data-site-ref-label="${v2Attr(label)}"><span class="forum-site-reference-icon"><i class="${v2IconForReference(kind.toLowerCase())}"></i></span><span><small>${v2LabelForReference(kind.toLowerCase())}</small><strong>${v2Esc(label)}</strong></span><i class="fa-solid fa-arrow-up-right-from-square"></i></button>`;
    }

    const mediaMatch = token.match(/^\[\[media:(image|file):(https?:\/\/[^|\]]+)\|([^\]]+)\]\]$/i);
    if (mediaMatch) {
        const [, kind, urlRaw, label] = mediaMatch;
        const url = v2SafeUrl(urlRaw);
        if (!url) return '<span class="forum-broken-reference">Pièce jointe invalide</span>';
        if (kind.toLowerCase() === 'image') {
            return `<a class="forum-external-attachment image" href="${v2Attr(url)}" target="_blank" rel="noopener noreferrer"><img src="${v2Attr(url)}" alt="${v2Attr(label)}" loading="lazy"><span><i class="fa-regular fa-image"></i>${v2Esc(label)}<small>Image hébergée à l’extérieur</small></span></a>`;
        }
        return `<a class="forum-external-attachment file" href="${v2Attr(url)}" target="_blank" rel="noopener noreferrer"><span class="attachment-file-icon"><i class="fa-solid fa-paperclip"></i></span><span><strong>${v2Esc(label)}</strong><small>Document externe · ouvrir dans un nouvel onglet</small></span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>`;
    }
    return v2Esc(token);
}

// Étend le rendu V1 sans introduire de HTML utilisateur non échappé.
const forumV1RenderForumText = renderForumText;
renderForumText = function forumV2RenderForumText(raw) {
    const tokens = [];
    const protectedText = String(raw || '').replace(/\[\[(?:ref:(?:project|document|subject|info|topic|post|member):[^\]]+|media:(?:image|file):https?:\/\/[^\]]+)\]\]/gi, match => {
        const index = tokens.push(v2RenderSpecialToken(match)) - 1;
        return `FORUMV2TOKEN${index}ENDTOKEN`;
    });
    let html = forumV1RenderForumText(protectedText);
    tokens.forEach((tokenHtml, index) => {
        html = html.replaceAll(`FORUMV2TOKEN${index}ENDTOKEN`, tokenHtml);
    });
    return html;
};

/* ==========================================================
   ÉDITEUR : références, mentions et pièces jointes externes
========================================================== */

function enhanceForumEditorToolbars(root = document) {
    root.querySelectorAll?.('.forum-editor-toolbar').forEach(toolbar => {
        if (toolbar.querySelector('[data-v2-reference]')) return;
        const reference = document.createElement('button');
        reference.type = 'button';
        reference.dataset.v2Reference = '1';
        reference.dataset.tooltip = 'Insérer un lien vers le site';
        reference.innerHTML = '<i class="fa-solid fa-link"></i>';
        const mention = document.createElement('button');
        mention.type = 'button';
        mention.dataset.v2Mention = '1';
        mention.dataset.tooltip = 'Mentionner un membre';
        mention.innerHTML = '<i class="fa-solid fa-at"></i>';
        const attachment = document.createElement('button');
        attachment.type = 'button';
        attachment.dataset.v2Attachment = '1';
        attachment.dataset.tooltip = 'Partager une image ou un document externe';
        attachment.innerHTML = '<i class="fa-solid fa-paperclip"></i>';
        toolbar.append(reference, mention, attachment);
    });
}

async function buildReferenceItems() {
    const items = [];
    (window.myProjects || myProjects || []).forEach(project => {
        if (project?._dbId != null) items.push({ kind: 'project', id: String(project._dbId), label: project.name, detail: project.description || '' });
    });
    (window.myCourses || myCourses || []).forEach(subject => {
        items.push({ kind: 'subject', id: String(subject._dbId ?? subject.id), label: subject.name, detail: 'Matière' });
        ['lessons', 'exercises', 'sheets'].forEach(type => (subject[type] || []).forEach(doc => {
            if (doc?._dbId != null) items.push({ kind: 'document', id: String(doc._dbId), label: doc.title, detail: subject.name });
        }));
    });
    (window.generalInfo || generalInfo || []).forEach(info => {
        if (info?._dbId != null) items.push({ kind: 'info', id: String(info._dbId), label: info.title, detail: (info.text || '').slice(0, 100) });
    });

    const client = v2Client();
    if (client) {
        const [topics, members, recentPosts] = await Promise.all([
            client.from('forum_topic_summaries').select('id,title,category_name').order('last_post_at', { ascending: false }).limit(150),
            client.from('community_members').select('user_id,username,role').order('username').limit(150),
            client.from('forum_posts').select('id,topic_id,content,created_at').is('deleted_at', null).order('created_at', { ascending: false }).limit(150)
        ]);
        const topicMap = new Map((topics.data || []).map(topic => [topic.id, topic]));
        (topics.data || []).forEach(topic => items.push({ kind: 'topic', id: topic.id, label: topic.title, detail: topic.category_name || 'Forum' }));
        (recentPosts.data || []).forEach(post => {
            const topic = topicMap.get(post.topic_id);
            const excerpt = String(post.content || '').replace(/\s+/g, ' ').slice(0, 70);
            items.push({ kind: 'post', id: String(post.id), label: `${topic?.title || 'Discussion'} · ${excerpt || 'message'}`, detail: 'Message du forum' });
        });
        (members.data || []).forEach(member => items.push({ kind: 'member', id: member.user_id, label: member.username, detail: member.role === 'admin' ? 'Admin' : member.role === 'moderator' ? 'Modérateur' : 'Membre' }));
    }
    return items;
}

function renderReferencePicker() {
    const list = document.getElementById('forum-reference-results');
    if (!list) return;
    const term = String(document.getElementById('forum-reference-search')?.value || '').trim().toLowerCase();
    const filter = forumV2State.referenceFilter;
    const rows = forumV2State.referenceItems.filter(item => {
        const filterMatch = filter === 'all' || item.kind === filter;
        const termMatch = !term || `${item.label} ${item.detail} ${v2LabelForReference(item.kind)}`.toLowerCase().includes(term);
        return filterMatch && termMatch;
    }).slice(0, 100);

    list.innerHTML = rows.length ? rows.map(item => `
        <button type="button" class="forum-reference-result" data-reference-kind="${v2Attr(item.kind)}" data-reference-id="${v2Attr(item.id)}" data-reference-label="${v2Attr(item.label)}">
            <span class="forum-reference-result-icon"><i class="${v2IconForReference(item.kind)}"></i></span>
            <span><strong>${v2Esc(item.label)}</strong><small>${v2Esc(item.detail || v2LabelForReference(item.kind))}</small></span>
            <span class="reference-type">${v2LabelForReference(item.kind)}</span>
        </button>`).join('') : '<div class="forum-state compact"><i class="fa-regular fa-folder-open"></i><p>Aucun élément correspondant.</p></div>';
}

async function openReferencePicker(targetId, mode = 'all') {
    forumV2State.referenceTargetId = targetId;
    forumV2State.referenceMode = mode;
    forumV2State.referenceFilter = mode === 'mention' ? 'member' : 'all';
    const search = document.getElementById('forum-reference-search');
    if (search) search.value = '';
    document.querySelectorAll('[data-reference-filter]').forEach(btn => btn.classList.toggle('active', btn.dataset.referenceFilter === forumV2State.referenceFilter));
    const list = document.getElementById('forum-reference-results');
    if (list) list.innerHTML = '<div class="forum-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><span>Chargement…</span></div>';
    openModalById('forumReferenceModal');
    forumV2State.referenceItems = await buildReferenceItems();
    renderReferencePicker();
    setTimeout(() => search?.focus(), 30);
}

function openExternalAttachmentModal(targetId) {
    forumV2State.referenceTargetId = targetId;
    document.getElementById('forum-attachment-form')?.reset();
    const message = document.getElementById('forum-attachment-message');
    if (message) message.hidden = true;
    openModalById('forumAttachmentModal');
}

function submitExternalAttachment(event) {
    event.preventDefault();
    const type = document.getElementById('forum-attachment-type').value;
    const rawUrl = document.getElementById('forum-attachment-url').value.trim();
    const label = document.getElementById('forum-attachment-label').value.trim() || (type === 'image' ? 'Image partagée' : 'Document partagé');
    const url = v2SafeUrl(rawUrl);
    const message = document.getElementById('forum-attachment-message');
    if (!url) {
        if (message) { message.textContent = 'Le lien doit commencer par http:// ou https://.'; message.className = 'account-message error'; message.hidden = false; }
        return;
    }
    const textarea = document.getElementById(forumV2State.referenceTargetId);
    v2InsertAtCursor(textarea, `[[media:${type}:${url}|${label.replace(/[|\]]/g, '')}]]`);
    closeModalById('forumAttachmentModal');
}

/* ==========================================================
   NAVIGATION DES RÉFÉRENCES INTERNES
========================================================== */

async function openSiteReference(kind, id, label = '') {
    if (kind === 'project') {
        const index = myProjects.findIndex(p => String(p._dbId) === String(id));
        if (index >= 0) { navigateToSection('projects'); setTimeout(() => openProjectModal(index), 80); return; }
    }
    if (kind === 'subject') {
        const index = myCourses.findIndex(s => String(s._dbId ?? s.id) === String(id));
        if (index >= 0) { navigateToSection('courses'); switchMainCourseTab('courses-content'); selectSubject(index); return; }
    }
    if (kind === 'document') {
        for (let subjectIndex = 0; subjectIndex < myCourses.length; subjectIndex += 1) {
            const subject = myCourses[subjectIndex];
            for (const type of ['lessons', 'exercises', 'sheets']) {
                const itemIndex = (subject[type] || []).findIndex(d => String(d._dbId) === String(id));
                if (itemIndex >= 0) {
                    navigateToSection('courses');
                    switchMainCourseTab('courses-content');
                    selectSubject(subjectIndex, type);
                    const doc = subject[type][itemIndex];
                    setTimeout(() => openPdf(doc.title, doc.url, doc._dbId || ''), 100);
                    return;
                }
            }
        }
    }
    if (kind === 'info') {
        navigateToSection('courses');
        switchMainCourseTab('global-info-content');
        setTimeout(() => {
            const target = [...document.querySelectorAll('#general-info-container .info-block')].find(el => el.textContent?.includes(label));
            target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target?.classList.add('forum-reference-highlight');
            setTimeout(() => target?.classList.remove('forum-reference-highlight'), 1800);
        }, 100);
        return;
    }
    if (kind === 'topic') { goToForum(); await openForumTopic(id); return; }
    if (kind === 'post') {
        const { data } = await v2Client().from('forum_posts').select('topic_id').eq('id', Number(id)).maybeSingle();
        if (data?.topic_id) {
            goToForum(); await openForumTopic(data.topic_id);
            setTimeout(() => document.getElementById(`forum-post-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 90);
            return;
        }
    }
    if (kind === 'member') { await openMemberProfile(id); return; }
    v2Toast('Cette référence n’est plus disponible.');
}

/* ==========================================================
   ABONNEMENTS AUX SUJETS + LIENS DIRECTS
========================================================== */

async function enhanceCurrentTopicV2() {
    enhanceForumEditorToolbars(document);
    const topic = forumState.currentTopic;
    if (!topic) return;
    const actions = document.querySelector('.forum-topic-actions');
    if (actions && forumState.user && !actions.querySelector('[data-v2-subscribe-topic]')) {
        const { data } = await v2Client().from('forum_topic_subscriptions').select('topic_id').eq('topic_id', topic.id).eq('user_id', forumState.user.id).maybeSingle();
        const subscribed = Boolean(data);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `forum-mini-btn ${subscribed ? 'active' : ''}`;
        button.dataset.v2SubscribeTopic = topic.id;
        button.dataset.subscribed = subscribed ? '1' : '0';
        button.innerHTML = `<i class="fa-${subscribed ? 'solid' : 'regular'} fa-bell"></i> ${subscribed ? 'Abonné' : 'Suivre'}`;
        actions.append(button);
    }

    document.querySelectorAll('.forum-post').forEach(postEl => {
        const postId = Number(postEl.id.replace('forum-post-', ''));
        const raw = forumState.rawPosts.get(postId);
        const actionsEl = postEl.querySelector('.forum-post-actions');
        if (!actionsEl || !raw) return;
        if (!actionsEl.querySelector('[data-v2-copy-post-link]')) {
            actionsEl.insertAdjacentHTML('beforeend', `<button type="button" class="forum-mini-btn" data-v2-copy-post-link="${postId}" data-tooltip="Copier un lien direct vers ce message"><i class="fa-solid fa-link"></i></button>`);
        }
        const edited = raw.updated_at && new Date(raw.updated_at).getTime() - new Date(raw.created_at).getTime() > 2000;
        const maySeeHistory = forumState.user && (forumState.user.id === raw.author_id || forumState.isModerator);
        if (edited && maySeeHistory && !actionsEl.querySelector('[data-v2-post-history]')) {
            actionsEl.insertAdjacentHTML('beforeend', `<button type="button" class="forum-mini-btn" data-v2-post-history="${postId}"><i class="fa-solid fa-clock-rotate-left"></i> Historique</button>`);
        }
    });

    const url = new URL(location.href);
    url.searchParams.set('topic', topic.id);
    url.searchParams.delete('post');
    history.replaceState(null, '', `${url.pathname}${url.search}#forum`);
}

const forumV1OpenForumTopic = openForumTopic;
openForumTopic = async function forumV2OpenForumTopic(topicId) {
    await forumV1OpenForumTopic(topicId);
    await enhanceCurrentTopicV2();
};

async function toggleTopicSubscription(button) {
    if (!forumState.user) return openAccountModal('login');
    const topicId = button.dataset.v2SubscribeTopic;
    const subscribed = button.dataset.subscribed === '1';
    const query = subscribed
        ? v2Client().from('forum_topic_subscriptions').delete().eq('topic_id', topicId).eq('user_id', forumState.user.id)
        : v2Client().from('forum_topic_subscriptions').insert({ topic_id: topicId, user_id: forumState.user.id });
    const { error } = await query;
    if (error) return v2Toast(error.message || 'Modification impossible.');
    await enhanceCurrentTopicV2AfterSubscription(button, !subscribed);
}

function enhanceCurrentTopicV2AfterSubscription(button, subscribed) {
    button.dataset.subscribed = subscribed ? '1' : '0';
    button.classList.toggle('active', subscribed);
    button.innerHTML = `<i class="fa-${subscribed ? 'solid' : 'regular'} fa-bell"></i> ${subscribed ? 'Abonné' : 'Suivre'}`;
    v2Toast(subscribed ? 'Vous suivez maintenant cette discussion.' : 'Abonnement retiré.');
}

function copyDirectPostLink(postId) {
    const topicId = forumState.currentTopicId;
    if (!topicId) return;
    const url = new URL(location.href);
    url.searchParams.set('topic', topicId);
    url.searchParams.set('post', String(postId));
    url.hash = 'forum';
    navigator.clipboard?.writeText(url.href).then(() => v2Toast('Lien du message copié.')).catch(() => v2Toast(url.href));
}

/* ==========================================================
   HISTORIQUE DES MESSAGES
========================================================== */

async function openPostHistory(postId) {
    const client = v2Client();
    const { data: revisions, error } = await client.from('forum_post_revisions').select('*').eq('post_id', Number(postId)).order('created_at', { ascending: false });
    if (error) return v2Toast(error.message || 'Historique indisponible.');
    const editorIds = [...new Set((revisions || []).map(r => r.editor_id).filter(Boolean))];
    let profiles = [];
    if (editorIds.length) profiles = (await client.from('profiles').select('user_id,username').in('user_id', editorIds)).data || [];
    const map = new Map(profiles.map(p => [p.user_id, p.username]));
    const list = document.getElementById('forum-history-list');
    const currentPost = forumState.rawPosts.get(Number(postId));
    const canRestore = forumState.isModerator || !currentPost?.deleted_at;
    list.innerHTML = revisions?.length ? revisions.map((r, index) => `
        <article class="forum-history-entry">
            <div><strong>Version précédente ${revisions.length - index}</strong><small>${fFullDate(r.created_at)} · ${v2Esc(map.get(r.editor_id) || 'Système')}</small></div>
            <div class="forum-history-content">${renderForumText(r.old_content)}</div>
            ${canRestore ? `<button type="button" class="secondary-btn compact-btn" data-v2-restore-revision="${r.id}" data-post-id="${postId}"><i class="fa-solid fa-clock-rotate-left"></i> Restaurer cette version</button>` : ''}
        </article>`).join('') : '<div class="forum-state compact"><p>Aucune ancienne version disponible.</p></div>';
    openModalById('forumHistoryModal');
    v2RenderMath(list);
}

async function restorePostRevision(revisionId, postId) {
    const { data: revision, error } = await v2Client().from('forum_post_revisions').select('old_content').eq('id', Number(revisionId)).maybeSingle();
    if (error || !revision) return v2Toast('Version introuvable.');
    if (!confirm('Restaurer cette ancienne version du message ? La version actuelle sera conservée dans l’historique.')) return;
    const { error: updateError } = await v2Client().from('forum_posts').update({ content: revision.old_content }).eq('id', Number(postId));
    if (updateError) return v2Toast(updateError.message || 'Restauration impossible.');
    closeModalById('forumHistoryModal');
    await openForumTopic(forumState.currentTopicId);
}

/* ==========================================================
   PRÉSENCE EN LIGNE
========================================================== */

async function setupForumPresenceV2() {
    const client = v2Client();
    if (!client) return;
    if (forumV2State.presenceChannel) {
        await client.removeChannel(forumV2State.presenceChannel);
        forumV2State.presenceChannel = null;
    }
    forumV2State.onlineUsers.clear();
    renderOnlineMembersV2();
    if (!forumState.user || !forumState.profile) return;

    const channel = client.channel('forum-community-presence', { config: { presence: { key: forumState.user.id } } });
    forumV2State.presenceChannel = channel;
    channel
        .on('presence', { event: 'sync' }, () => {
            const state = channel.presenceState();
            forumV2State.onlineUsers.clear();
            Object.values(state).flat().forEach(entry => {
                if (entry?.user_id) forumV2State.onlineUsers.set(entry.user_id, entry);
            });
            renderOnlineMembersV2();
        })
        .subscribe(async status => {
            if (status === 'SUBSCRIBED') {
                await channel.track({
                    user_id: forumState.user.id,
                    username: forumState.profile.username,
                    avatar_url: forumState.profile.avatar_url || '',
                    online_at: new Date().toISOString()
                });
            }
        });
}

function renderOnlineMembersV2() {
    const count = forumV2State.onlineUsers.size;
    const stat = document.getElementById('forum-stat-online');
    if (stat) stat.textContent = String(count);
    const strip = document.getElementById('forum-online-members');
    if (!strip) return;
    const users = [...forumV2State.onlineUsers.values()].slice(0, 10);
    strip.innerHTML = users.length ? `<span class="online-label"><span class="online-dot"></span>${count} en ligne</span><div class="online-avatars">${users.map(u => u.avatar_url ? `<button type="button" data-member-profile="${v2Attr(u.user_id)}" data-tooltip="${v2Attr(u.username)}"><img src="${v2Attr(u.avatar_url)}" alt=""></button>` : `<button type="button" data-member-profile="${v2Attr(u.user_id)}" data-tooltip="${v2Attr(u.username)}">${v2Esc(String(u.username || '?').slice(0, 2).toUpperCase())}</button>`).join('')}</div>` : '<span class="online-label muted"><span class="online-dot"></span>Aucun membre connecté actuellement</span>';
}

/* ==========================================================
   BADGES + PROFIL PUBLIC
========================================================== */

const forumV1OpenMemberProfile = openMemberProfile;
openMemberProfile = async function forumV2OpenMemberProfile(userId) {
    await forumV1OpenMemberProfile(userId);
    const content = document.getElementById('member-profile-content');
    if (!content) return;
    const [earned, badges] = await Promise.all([
        v2Client().from('forum_user_badges').select('badge_code,awarded_at').eq('user_id', userId),
        v2Client().from('forum_badges').select('*').order('sort_order')
    ]);
    const earnedMap = new Map((earned.data || []).map(x => [x.badge_code, x.awarded_at]));
    const earnedBadges = (badges.data || []).filter(b => earnedMap.has(b.code));
    const target = content.querySelector('.member-profile-stats');
    if (target && !content.querySelector('.member-badges-section')) {
        target.insertAdjacentHTML('afterend', `<section class="member-badges-section"><h3><i class="fa-solid fa-award"></i> Badges</h3><div class="member-badges">${earnedBadges.length ? earnedBadges.map(b => `<span class="member-badge" data-tooltip="${v2Attr(b.description)}"><i class="${v2Attr(b.icon)}"></i><span>${v2Esc(b.name)}</span></span>`).join('') : '<span class="form-help">Aucun badge pour le moment.</span>'}</div></section>`);
    }
    if (forumState.user && forumState.user.id !== userId && !content.querySelector('[data-v2-private-user]')) {
        const hero = content.querySelector('.member-profile-hero > div:last-child');
        hero?.insertAdjacentHTML('beforeend', `<button type="button" class="secondary-btn compact-btn member-private-btn" data-v2-private-user="${v2Attr(userId)}"><i class="fa-regular fa-paper-plane"></i> Message privé</button>`);
    }
};

/* ==========================================================
   MESSAGES PRIVÉS
========================================================== */

const forumV1RenderAccountPopover = renderAccountPopover;
renderAccountPopover = function forumV2RenderAccountPopover() {
    forumV1RenderAccountPopover();
    const pop = document.getElementById('account-popover');
    if (!pop || !forumState.user || pop.querySelector('[data-account-action="messages"]')) return;
    const myTopics = pop.querySelector('[data-account-action="my-topics"]');
    myTopics?.insertAdjacentHTML('afterend', '<button type="button" class="account-menu-action" data-account-action="messages"><i class="fa-regular fa-paper-plane"></i> Messages privés</button>');
};

async function openPrivateMessages(otherUserId = null) {
    if (!forumState.user) return openAccountModal('login');
    closeAccountPopover();
    openModalById('privateMessagesModal');
    if (otherUserId && otherUserId !== forumState.user.id) {
        const [{ data, error }, profileResult] = await Promise.all([
            v2Client().rpc('get_or_create_private_thread', { p_other_user: otherUserId }),
            v2Client().from('profiles').select('user_id,username,avatar_url').eq('user_id', otherUserId).maybeSingle()
        ]);
        if (error) return v2Toast(error.message || 'Impossible de créer la conversation.');
        forumV2State.currentPrivateThreadId = data;
        forumV2State.currentPrivateOtherUser = profileResult.data || null;
    }
    await loadPrivateThreads();
    if (forumV2State.currentPrivateThreadId) await openPrivateThread(forumV2State.currentPrivateThreadId);
}

async function loadPrivateThreads() {
    const list = document.getElementById('private-thread-list');
    if (!list) return;
    list.innerHTML = '<div class="forum-loading compact"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
    const { data, error } = await v2Client().from('private_thread_summaries').select('*').order('updated_at', { ascending: false });
    if (error) { list.innerHTML = `<div class="admin-empty">${v2Esc(error.message)}</div>`; return; }
    list.innerHTML = data?.length ? data.map(t => `
        <button type="button" class="private-thread-item ${String(t.id) === String(forumV2State.currentPrivateThreadId) ? 'active' : ''}" data-private-thread="${v2Attr(t.id)}" data-private-other="${v2Attr(t.other_user_id)}" data-private-name="${v2Attr(t.other_username)}">
            ${t.other_avatar_url ? `<span class="member-avatar"><img src="${v2Attr(t.other_avatar_url)}" alt=""></span>` : `<span class="member-avatar">${v2Esc(String(t.other_username || '?').slice(0, 2).toUpperCase())}</span>`}
            <span><strong>${v2Esc(t.other_username)}</strong><small>${v2Esc((t.last_message || 'Nouvelle conversation').slice(0, 80))}</small></span>
            ${Number(t.unread_count || 0) ? `<span class="private-unread">${Number(t.unread_count)}</span>` : ''}
        </button>`).join('') : '<div class="admin-empty"><i class="fa-regular fa-paper-plane"></i><p>Aucune conversation privée.</p><small>Ouvrez le profil d’un membre pour lui écrire.</small></div>';
}

async function openPrivateThread(threadId, otherInfo = null) {
    forumV2State.currentPrivateThreadId = threadId;
    if (otherInfo) forumV2State.currentPrivateOtherUser = otherInfo;
    const client = v2Client();
    const { data: messages, error } = await client.from('private_messages').select('*').eq('thread_id', threadId).order('created_at');
    if (error) return v2Toast(error.message || 'Conversation indisponible.');
    const authorIds = [...new Set((messages || []).map(m => m.author_id))];
    let profiles = [];
    if (authorIds.length) profiles = (await client.from('profiles').select('user_id,username,avatar_url').in('user_id', authorIds)).data || [];
    const profileMap = new Map(profiles.map(p => [p.user_id, p]));
    const pane = document.getElementById('private-message-pane');
    const other = forumV2State.currentPrivateOtherUser || profiles.find(p => p.user_id !== forumState.user.id) || { username: 'Conversation' };
    forumV2State.currentPrivateOtherUser = other;
    pane.innerHTML = `
        <div class="private-chat-head"><div><strong>${v2Esc(other.username || 'Conversation')}</strong><small>Conversation privée</small></div></div>
        <div id="private-message-list" class="private-message-list">${messages?.length ? messages.map(m => {
            const mine = m.author_id === forumState.user.id;
            const author = profileMap.get(m.author_id) || { username: mine ? forumState.profile?.username : 'Membre' };
            return `<article class="private-message ${mine ? 'mine' : ''}"><div class="private-message-meta"><strong>${v2Esc(author.username)}</strong><span>${fRelativeDate(m.created_at)}</span></div><div class="private-message-body">${m.deleted_at ? '<em>Message supprimé.</em>' : renderForumText(m.content)}</div></article>`;
        }).join('') : '<div class="forum-state compact"><p>Commencez la conversation.</p></div>'}</div>
        <form id="private-message-form" class="private-message-form"><textarea id="private-message-content" rows="3" maxlength="5000" required placeholder="Votre message privé…"></textarea><button class="primary-btn compact-btn" type="submit"><i class="fa-solid fa-paper-plane"></i> Envoyer</button></form>`;
    v2RenderMath(pane);
    await client.rpc('mark_private_thread_read', { p_thread_id: threadId });
    await loadPrivateThreads();
    setTimeout(() => { const list = document.getElementById('private-message-list'); if (list) list.scrollTop = list.scrollHeight; }, 30);
}

async function sendPrivateMessage(event) {
    event.preventDefault();
    if (!forumV2State.currentPrivateThreadId) return;
    const textarea = document.getElementById('private-message-content');
    const content = textarea?.value.trim() || '';
    if (!content) return;
    const { error } = await v2Client().from('private_messages').insert({ thread_id: forumV2State.currentPrivateThreadId, author_id: forumState.user.id, content });
    if (error) {
        const message = /row-level security|policy/i.test(error.message || '') ? 'Ce membre n’accepte plus de nouveaux messages privés.' : (error.message || 'Envoi impossible.');
        return v2Toast(message);
    }
    textarea.value = '';
    await openPrivateThread(forumV2State.currentPrivateThreadId);
}

async function setupPrivateRealtimeV2() {
    const client = v2Client();
    if (!client) return;
    if (forumV2State.privateChannel) await client.removeChannel(forumV2State.privateChannel);
    forumV2State.privateChannel = null;
    if (!forumState.user) return;
    forumV2State.privateChannel = client.channel(`private-messages-${forumState.user.id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'private_messages' }, async () => {
            if (document.getElementById('privateMessagesModal')?.classList.contains('active')) {
                await loadPrivateThreads();
                if (forumV2State.currentPrivateThreadId) await openPrivateThread(forumV2State.currentPrivateThreadId);
            }
        })
        .subscribe();
}

/* ==========================================================
   NOTIFICATIONS V2
========================================================== */

renderNotifications = function forumV2RenderNotifications(items) {
    const badge = document.getElementById('notification-badge');
    const pop = document.getElementById('notification-popover');
    const unread = items.filter(item => !item.is_read).length;
    if (badge) { badge.textContent = unread > 99 ? '99+' : String(unread); badge.hidden = unread === 0; }
    if (!pop) return;
    const icons = {
        reaction: 'fa-regular fa-heart', mention: 'fa-solid fa-at', subscription: 'fa-regular fa-bell',
        private_message: 'fa-regular fa-paper-plane', badge: 'fa-solid fa-award', reply: 'fa-regular fa-message', system: 'fa-solid fa-circle-info'
    };
    const rows = items.length ? items.map(item => `
        <button type="button" class="notification-item ${item.is_read ? '' : 'unread'}" data-notification-id="${item.id}" data-notification-topic="${v2Attr(item.topic_id || '')}" data-notification-post="${v2Attr(item.post_id || '')}" data-notification-thread="${v2Attr(item.private_thread_id || '')}">
            <span class="notification-item-icon"><i class="${icons[item.type] || 'fa-regular fa-message'}"></i></span>
            <span><strong>${v2Esc(item.message || 'Nouvelle notification')}</strong><small>${fRelativeDate(item.created_at)}</small></span>
        </button>`).join('') : '<div class="notification-empty">Aucune notification pour le moment.</div>';
    pop.innerHTML = `<div class="notification-head"><strong>Notifications</strong>${unread ? '<button type="button" data-notifications-read-all>Tout marquer comme lu</button>' : ''}</div><div class="notification-list">${rows}</div>`;
};

openNotification = async function forumV2OpenNotification(button) {
    const id = Number(button.dataset.notificationId || 0);
    const topicId = button.dataset.notificationTopic || '';
    const postId = button.dataset.notificationPost || '';
    const threadId = button.dataset.notificationThread || '';
    if (id) await v2Client().from('notifications').update({ is_read: true }).eq('id', id);
    closeNotificationPopover();
    loadNotifications();
    if (threadId) { forumV2State.currentPrivateThreadId = threadId; await openPrivateMessages(); return; }
    if (topicId) {
        goToForum(); await openForumTopic(topicId);
        if (postId) setTimeout(() => document.getElementById(`forum-post-${postId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    }
};

/* ==========================================================
   PRÉFÉRENCES DE PROFIL V2
========================================================== */

const forumV1OpenProfileEditor = openProfileEditor;
openProfileEditor = function forumV2OpenProfileEditor() {
    forumV1OpenProfileEditor();
    const email = document.getElementById('account-profile-email-notifications');
    const privateMsg = document.getElementById('account-profile-private-messages');
    if (email) email.checked = forumState.profile?.email_notifications === true;
    if (privateMsg) privateMsg.checked = forumState.profile?.private_messages_enabled !== false;
};

async function updateProfilePreference(field, value) {
    if (!forumState.user || !['email_notifications', 'private_messages_enabled'].includes(field)) return;
    const { data, error } = await v2Client().from('profiles').update({ [field]: value }).eq('user_id', forumState.user.id).select('*').single();
    if (error) return v2Toast(error.message || 'Préférence non enregistrée.');
    forumState.profile = data;
    v2Toast('Préférence enregistrée.');
}

/* ==========================================================
   ADMINISTRATION V2 : SUJETS ET MESSAGES
========================================================== */

const forumV1LoadForumAdmin = loadForumAdmin;
loadForumAdmin = async function forumV2LoadForumAdmin() {
    await forumV1LoadForumAdmin();
    await Promise.all([loadAdminTopicsV2(), loadAdminMessagesV2()]);
};

function setAdminForumPaneV2(name) {
    document.querySelectorAll('[data-admin-forum-v2-pane]').forEach(p => p.hidden = p.dataset.adminForumV2Pane !== name);
    document.querySelectorAll('[data-admin-forum-v2-tab]').forEach(b => b.classList.toggle('active', b.dataset.adminForumV2Tab === name));
    if (name === 'topics') loadAdminTopicsV2();
    if (name === 'messages') loadAdminMessagesV2();
}

async function loadAdminTopicsV2() {
    if (!forumState.isAdmin) return;
    const client = v2Client();
    let query = client.from('forum_topics').select('*').order('created_at', { ascending: false }).limit(250);
    const filter = forumV2State.adminTopicFilter;
    if (filter === 'active') query = query.is('deleted_at', null);
    if (filter === 'deleted') query = query.not('deleted_at', 'is', null);
    if (filter === 'locked') query = query.eq('is_locked', true).is('deleted_at', null);
    if (filter === 'solved') query = query.eq('is_solved', true).is('deleted_at', null);
    const { data: topics, error } = await query;
    const list = document.getElementById('admin-v2-topic-list');
    if (!list) return;
    if (error) { list.innerHTML = `<div class="admin-empty">${v2Esc(error.message)}</div>`; return; }
    const filtered = (topics || []).filter(t => !forumV2State.adminTopicSearch || t.title.toLowerCase().includes(forumV2State.adminTopicSearch.toLowerCase()));
    const categoryIds = [...new Set(filtered.map(t => t.category_id))];
    const authorIds = [...new Set(filtered.map(t => t.author_id))];
    const [categories, profiles] = await Promise.all([
        categoryIds.length ? client.from('forum_categories').select('id,name').in('id', categoryIds) : Promise.resolve({ data: [] }),
        authorIds.length ? client.from('profiles').select('user_id,username').in('user_id', authorIds) : Promise.resolve({ data: [] })
    ]);
    const cMap = new Map((categories.data || []).map(c => [Number(c.id), c.name]));
    const pMap = new Map((profiles.data || []).map(p => [p.user_id, p.username]));
    list.dataset.topics = JSON.stringify(filtered);
    list.innerHTML = filtered.length ? filtered.map(t => `
        <article class="admin-v2-forum-row ${t.deleted_at ? 'deleted' : ''}">
            <div class="admin-v2-forum-main"><strong>${v2Esc(t.title)}</strong><span>${v2Esc(cMap.get(Number(t.category_id)) || 'Catégorie')} · ${v2Esc(pMap.get(t.author_id) || 'Membre')} · ${fRelativeDate(t.created_at)}</span><div class="admin-v2-statuses">${t.is_pinned ? '<span>📌 Épinglé</span>' : ''}${t.is_locked ? '<span>🔒 Verrouillé</span>' : ''}${t.is_solved ? '<span>✅ Résolu</span>' : ''}${t.deleted_at ? '<span>🗑 Supprimé</span>' : ''}</div></div>
            <div class="admin-v2-forum-actions"><button type="button" class="admin-icon-action" data-admin-v2-topic-view="${t.id}" data-tooltip="Voir"><i class="fa-regular fa-eye"></i></button><button type="button" class="admin-icon-action" data-admin-v2-topic-edit="${t.id}" data-tooltip="Modifier"><i class="fa-solid fa-pen"></i></button>${t.deleted_at ? `<button type="button" class="admin-icon-action" data-admin-v2-topic-restore="${t.id}" data-tooltip="Restaurer"><i class="fa-solid fa-clock-rotate-left"></i></button>` : `<button type="button" class="admin-icon-action danger" data-admin-v2-topic-soft-delete="${t.id}" data-tooltip="Masquer"><i class="fa-regular fa-trash-can"></i></button>`}<button type="button" class="admin-icon-action danger hard" data-admin-v2-topic-hard-delete="${t.id}" data-tooltip="Supprimer définitivement"><i class="fa-solid fa-trash"></i></button></div>
        </article>`).join('') : '<div class="admin-empty">Aucun sujet correspondant.</div>';
}

async function loadAdminMessagesV2() {
    if (!forumState.isAdmin) return;
    const client = v2Client();
    let query = client.from('forum_posts').select('*').order('created_at', { ascending: false }).limit(300);
    const filter = forumV2State.adminMessageFilter;
    if (filter === 'visible') query = query.is('deleted_at', null);
    if (filter === 'deleted') query = query.not('deleted_at', 'is', null);
    const { data: posts, error } = await query;
    const list = document.getElementById('admin-v2-message-list');
    if (!list) return;
    if (error) { list.innerHTML = `<div class="admin-empty">${v2Esc(error.message)}</div>`; return; }
    const filtered = (posts || []).filter(p => !forumV2State.adminMessageSearch || (p.content || '').toLowerCase().includes(forumV2State.adminMessageSearch.toLowerCase()));
    const topicIds = [...new Set(filtered.map(p => p.topic_id))];
    const authorIds = [...new Set(filtered.map(p => p.author_id))];
    const [topics, profiles] = await Promise.all([
        topicIds.length ? client.from('forum_topics').select('id,title').in('id', topicIds) : Promise.resolve({ data: [] }),
        authorIds.length ? client.from('profiles').select('user_id,username').in('user_id', authorIds) : Promise.resolve({ data: [] })
    ]);
    const tMap = new Map((topics.data || []).map(t => [t.id, t.title]));
    const pMap = new Map((profiles.data || []).map(p => [p.user_id, p.username]));
    list.dataset.messages = JSON.stringify(filtered);
    list.innerHTML = filtered.length ? filtered.map(p => `
        <article class="admin-v2-forum-row ${p.deleted_at ? 'deleted' : ''}">
            <div class="admin-v2-forum-main"><strong>${v2Esc(pMap.get(p.author_id) || 'Membre')}</strong><span>${v2Esc(tMap.get(p.topic_id) || 'Sujet')} · ${fRelativeDate(p.created_at)}</span><p>${v2Esc((p.content || '').slice(0, 180))}${(p.content || '').length > 180 ? '…' : ''}</p></div>
            <div class="admin-v2-forum-actions"><button type="button" class="admin-icon-action" data-admin-v2-message-view="${p.id}" data-topic-id="${p.topic_id}" data-tooltip="Voir"><i class="fa-regular fa-eye"></i></button>${!p.deleted_at ? `<button type="button" class="admin-icon-action" data-admin-v2-message-edit="${p.id}" data-tooltip="Modifier"><i class="fa-solid fa-pen"></i></button><button type="button" class="admin-icon-action danger" data-admin-v2-message-soft-delete="${p.id}" data-tooltip="Masquer"><i class="fa-regular fa-trash-can"></i></button>` : `<button type="button" class="admin-icon-action" data-admin-v2-message-restore="${p.id}" data-tooltip="Restaurer"><i class="fa-solid fa-clock-rotate-left"></i></button>`}<button type="button" class="admin-icon-action danger hard" data-admin-v2-message-hard-delete="${p.id}" data-tooltip="Supprimer définitivement"><i class="fa-solid fa-trash"></i></button></div>
        </article>`).join('') : '<div class="admin-empty">Aucun message correspondant.</div>';
}

async function openAdminTopicEditorV2(topicId) {
    const topic = (JSON.parse(document.getElementById('admin-v2-topic-list')?.dataset.topics || '[]')).find(t => t.id === topicId);
    if (!topic) return;
    const { data: categories } = await v2Client().from('forum_categories').select('id,name').order('sort_order');
    document.getElementById('admin-v2-topic-id').value = topic.id;
    document.getElementById('admin-v2-topic-title').value = topic.title;
    document.getElementById('admin-v2-topic-category').innerHTML = (categories || []).map(c => `<option value="${c.id}" ${Number(c.id) === Number(topic.category_id) ? 'selected' : ''}>${v2Esc(c.name)}</option>`).join('');
    document.getElementById('admin-v2-topic-pinned').checked = topic.is_pinned;
    document.getElementById('admin-v2-topic-locked').checked = topic.is_locked;
    document.getElementById('admin-v2-topic-solved').checked = topic.is_solved;
    openModalById('adminV2TopicModal');
}

async function saveAdminTopicV2(event) {
    event.preventDefault();
    const id = document.getElementById('admin-v2-topic-id').value;
    const payload = {
        title: document.getElementById('admin-v2-topic-title').value.trim(),
        category_id: Number(document.getElementById('admin-v2-topic-category').value),
        is_pinned: document.getElementById('admin-v2-topic-pinned').checked,
        is_locked: document.getElementById('admin-v2-topic-locked').checked,
        is_solved: document.getElementById('admin-v2-topic-solved').checked
    };
    const { error } = await v2Client().from('forum_topics').update(payload).eq('id', id);
    if (error) return v2Toast(error.message || 'Modification impossible.');
    closeModalById('adminV2TopicModal');
    await loadAdminTopicsV2();
}

async function openAdminMessageEditorV2(postId) {
    const post = (JSON.parse(document.getElementById('admin-v2-message-list')?.dataset.messages || '[]')).find(p => Number(p.id) === Number(postId));
    if (!post || post.deleted_at) return;
    document.getElementById('admin-v2-message-id').value = post.id;
    document.getElementById('admin-v2-message-content').value = post.content;
    openModalById('adminV2MessageModal');
}

async function saveAdminMessageV2(event) {
    event.preventDefault();
    const id = Number(document.getElementById('admin-v2-message-id').value);
    const content = document.getElementById('admin-v2-message-content').value.trim();
    const { error } = await v2Client().from('forum_posts').update({ content }).eq('id', id);
    if (error) return v2Toast(error.message || 'Modification impossible.');
    closeModalById('adminV2MessageModal');
    await loadAdminMessagesV2();
}

async function softDeleteAdminTopicV2(id, restore = false) {
    const prompt = restore ? 'Restaurer ce sujet ?' : 'Masquer ce sujet du forum ? Il pourra être restauré depuis l’administration.';
    if (!confirm(prompt)) return;
    const { error } = await v2Client().from('forum_topics').update({ deleted_at: restore ? null : new Date().toISOString() }).eq('id', id);
    if (error) return v2Toast(error.message);
    await loadAdminTopicsV2();
}

async function hardDeleteAdminTopicV2(id) {
    if (!confirm('SUPPRESSION DÉFINITIVE : supprimer ce sujet ainsi que tous ses messages, réactions, signalements et abonnements ? Cette action est irréversible.')) return;
    const { error } = await v2Client().rpc('admin_hard_delete_forum_topic', { p_topic_id: id });
    if (error) return v2Toast(error.message);
    await Promise.all([loadAdminTopicsV2(), loadAdminMessagesV2()]);
}

async function softDeleteAdminMessageV2(id) {
    if (!confirm('Masquer ce message ? Il restera restaurable depuis l’administration.')) return;
    const { error } = await v2Client().from('forum_posts').update({ deleted_at: new Date().toISOString() }).eq('id', Number(id));
    if (error) return v2Toast(error.message);
    await loadAdminMessagesV2();
}

async function restoreAdminMessageV2(id) {
    if (!confirm('Restaurer ce message et sa dernière version avant suppression ?')) return;
    const { error } = await v2Client().rpc('restore_forum_post', { p_post_id: Number(id) });
    if (error) return v2Toast(error.message);
    await loadAdminMessagesV2();
}

async function hardDeleteAdminMessageV2(id) {
    if (!confirm('SUPPRESSION DÉFINITIVE : supprimer ce message, ses réactions, son historique et ses signalements ? Cette action est irréversible.')) return;
    const { error } = await v2Client().rpc('admin_hard_delete_forum_post', { p_post_id: Number(id) });
    if (error) return v2Toast(error.message);
    await loadAdminMessagesV2();
}

/* ==========================================================
   SESSION V2
========================================================== */

const forumV1RefreshCurrentAccount = refreshCurrentAccount;
refreshCurrentAccount = async function forumV2RefreshCurrentAccount(session = null) {
    await forumV1RefreshCurrentAccount(session);
    await Promise.all([setupForumPresenceV2(), setupPrivateRealtimeV2()]);
};

/* ==========================================================
   ÉVÉNEMENTS V2
========================================================== */

function bindForumV2Events() {
    enhanceForumEditorToolbars(document);

    const observer = new MutationObserver(() => enhanceForumEditorToolbars(document));
    const forumRoot = document.getElementById('forum');
    if (forumRoot) observer.observe(forumRoot, { childList: true, subtree: true });

    document.addEventListener('click', async event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const toolbar = target.closest('.forum-editor-toolbar');
        if (target.closest('[data-v2-reference]')) { await openReferencePicker(toolbar?.dataset.editorTarget || '', 'all'); return; }
        if (target.closest('[data-v2-mention]')) { await openReferencePicker(toolbar?.dataset.editorTarget || '', 'mention'); return; }
        if (target.closest('[data-v2-attachment]')) { openExternalAttachmentModal(toolbar?.dataset.editorTarget || ''); return; }

        const refFilter = target.closest('[data-reference-filter]');
        if (refFilter) {
            forumV2State.referenceFilter = refFilter.dataset.referenceFilter;
            document.querySelectorAll('[data-reference-filter]').forEach(btn => btn.classList.toggle('active', btn === refFilter));
            renderReferencePicker(); return;
        }
        const result = target.closest('[data-reference-kind]');
        if (result) {
            const textarea = document.getElementById(forumV2State.referenceTargetId);
            const kind = result.dataset.referenceKind;
            const label = result.dataset.referenceLabel;
            if (forumV2State.referenceMode === 'mention' && kind === 'member') v2InsertAtCursor(textarea, `@${label}`);
            else v2InsertAtCursor(textarea, `[[ref:${kind}:${result.dataset.referenceId}|${label.replace(/[|\]]/g, '')}]]`);
            closeModalById('forumReferenceModal'); return;
        }

        const siteRef = target.closest('[data-site-ref-kind]');
        if (siteRef) { await openSiteReference(siteRef.dataset.siteRefKind, siteRef.dataset.siteRefId, siteRef.dataset.siteRefLabel || ''); return; }

        const subscription = target.closest('[data-v2-subscribe-topic]');
        if (subscription) { await toggleTopicSubscription(subscription); return; }
        const copyLink = target.closest('[data-v2-copy-post-link]');
        if (copyLink) { copyDirectPostLink(copyLink.dataset.v2CopyPostLink); return; }
        const historyBtn = target.closest('[data-v2-post-history]');
        if (historyBtn) { await openPostHistory(historyBtn.dataset.v2PostHistory); return; }
        const restoreRevision = target.closest('[data-v2-restore-revision]');
        if (restoreRevision) { await restorePostRevision(restoreRevision.dataset.v2RestoreRevision, restoreRevision.dataset.postId); return; }

        const privateUser = target.closest('[data-v2-private-user]');
        if (privateUser) { closeModalById('memberProfileModal'); await openPrivateMessages(privateUser.dataset.v2PrivateUser); return; }
        const privateThread = target.closest('[data-private-thread]');
        if (privateThread) {
            forumV2State.currentPrivateOtherUser = { user_id: privateThread.dataset.privateOther, username: privateThread.dataset.privateName };
            await openPrivateThread(privateThread.dataset.privateThread, forumV2State.currentPrivateOtherUser); return;
        }

        const accountMessages = target.closest('[data-account-action="messages"]');
        if (accountMessages) { await openPrivateMessages(); return; }

        const forumAdminTab = target.closest('[data-admin-forum-v2-tab]');
        if (forumAdminTab) { setAdminForumPaneV2(forumAdminTab.dataset.adminForumV2Tab); return; }
        const topicFilter = target.closest('[data-admin-v2-topic-filter]');
        if (topicFilter) { forumV2State.adminTopicFilter = topicFilter.dataset.adminV2TopicFilter; document.querySelectorAll('[data-admin-v2-topic-filter]').forEach(b => b.classList.toggle('active', b === topicFilter)); await loadAdminTopicsV2(); return; }
        const messageFilter = target.closest('[data-admin-v2-message-filter]');
        if (messageFilter) { forumV2State.adminMessageFilter = messageFilter.dataset.adminV2MessageFilter; document.querySelectorAll('[data-admin-v2-message-filter]').forEach(b => b.classList.toggle('active', b === messageFilter)); await loadAdminMessagesV2(); return; }

        const topicView = target.closest('[data-admin-v2-topic-view]');
        if (topicView) { closeModalById('adminModal'); goToForum(); await openForumTopic(topicView.dataset.adminV2TopicView); return; }
        const topicEdit = target.closest('[data-admin-v2-topic-edit]');
        if (topicEdit) { await openAdminTopicEditorV2(topicEdit.dataset.adminV2TopicEdit); return; }
        const topicSoft = target.closest('[data-admin-v2-topic-soft-delete]');
        if (topicSoft) { await softDeleteAdminTopicV2(topicSoft.dataset.adminV2TopicSoftDelete); return; }
        const topicRestore = target.closest('[data-admin-v2-topic-restore]');
        if (topicRestore) { await softDeleteAdminTopicV2(topicRestore.dataset.adminV2TopicRestore, true); return; }
        const topicHard = target.closest('[data-admin-v2-topic-hard-delete]');
        if (topicHard) { await hardDeleteAdminTopicV2(topicHard.dataset.adminV2TopicHardDelete); return; }

        const messageView = target.closest('[data-admin-v2-message-view]');
        if (messageView) { closeModalById('adminModal'); goToForum(); await openForumTopic(messageView.dataset.topicId); setTimeout(() => document.getElementById(`forum-post-${messageView.dataset.adminV2MessageView}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80); return; }
        const messageEdit = target.closest('[data-admin-v2-message-edit]');
        if (messageEdit) { await openAdminMessageEditorV2(messageEdit.dataset.adminV2MessageEdit); return; }
        const messageSoft = target.closest('[data-admin-v2-message-soft-delete]');
        if (messageSoft) { await softDeleteAdminMessageV2(messageSoft.dataset.adminV2MessageSoftDelete); return; }
        const messageRestore = target.closest('[data-admin-v2-message-restore]');
        if (messageRestore) { await restoreAdminMessageV2(messageRestore.dataset.adminV2MessageRestore); return; }
        const messageHard = target.closest('[data-admin-v2-message-hard-delete]');
        if (messageHard) { await hardDeleteAdminMessageV2(messageHard.dataset.adminV2MessageHardDelete); return; }
    }, true);

    document.getElementById('forum-reference-search')?.addEventListener('input', renderReferencePicker);
    document.getElementById('forum-attachment-form')?.addEventListener('submit', submitExternalAttachment);
    document.getElementById('private-message-form-host')?.addEventListener('submit', sendPrivateMessage);
    document.addEventListener('submit', event => {
        if (event.target?.id === 'private-message-form') sendPrivateMessage(event);
    });
    document.getElementById('admin-v2-topic-form')?.addEventListener('submit', saveAdminTopicV2);
    document.getElementById('admin-v2-message-form')?.addEventListener('submit', saveAdminMessageV2);

    document.getElementById('admin-v2-topic-search')?.addEventListener('input', event => {
        forumV2State.adminTopicSearch = event.target.value.trim(); loadAdminTopicsV2();
    });
    document.getElementById('admin-v2-message-search')?.addEventListener('input', event => {
        forumV2State.adminMessageSearch = event.target.value.trim(); loadAdminMessagesV2();
    });

    document.getElementById('account-profile-email-notifications')?.addEventListener('change', event => updateProfilePreference('email_notifications', event.target.checked));
    document.getElementById('account-profile-private-messages')?.addEventListener('change', event => updateProfilePreference('private_messages_enabled', event.target.checked));

    document.querySelectorAll('[data-v2-close-modal]').forEach(btn => btn.addEventListener('click', () => closeModalById(btn.dataset.v2CloseModal)));
    ['forumReferenceModal', 'forumAttachmentModal', 'forumHistoryModal', 'privateMessagesModal', 'adminV2TopicModal', 'adminV2MessageModal'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', event => { if (event.target === event.currentTarget) closeModalById(id); });
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        ['forumReferenceModal', 'forumAttachmentModal', 'forumHistoryModal', 'privateMessagesModal', 'adminV2TopicModal', 'adminV2MessageModal'].forEach(closeModalById);
    });
}

async function handleForumV2DeepLink() {
    if (forumV2State.deepLinkHandled) return;
    forumV2State.deepLinkHandled = true;
    const params = new URLSearchParams(location.search);
    const topicId = params.get('topic');
    const postId = params.get('post');
    if (!topicId) return;
    goToForum();
    await openForumTopic(topicId);
    if (postId) setTimeout(() => document.getElementById(`forum-post-${postId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
}

async function initForumV2() {
    bindForumV2Events();
    // L'initialisation V1 est asynchrone : attendre brièvement que la session soit résolue.
    let attempts = 0;
    while (!forumState.initialized && attempts < 20) { await new Promise(r => setTimeout(r, 50)); attempts += 1; }
    await Promise.all([setupForumPresenceV2(), setupPrivateRealtimeV2()]);
    renderOnlineMembersV2();
    setTimeout(handleForumV2DeepLink, 120);
}

document.addEventListener('DOMContentLoaded', initForumV2);
