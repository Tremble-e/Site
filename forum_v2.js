'use strict';

/* ==========================================================
   FORUM V2.7
   - Références internes au site
   - Pièces jointes externes (URL uniquement)
   - Présence en ligne
   - Abonnements aux sujets
   - Historique des modifications
   - Badges
   - Messages privés individuels et groupes
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
    deepLinkHandled: false,
    replyContext: null,
    privateThreads: [],
    currentPrivateThreadSummary: null,
    currentPrivateMembers: [],
    privateMemberDirectory: [],
    groupSelectedMembers: new Set(),
    pendingPrivateAddUserId: null,
    privateMembershipRefreshTimer: null,
    memberDirectory: [],
    memberDirectoryFilter: 'all'
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

function v2RenderMention(username) {
    const clean = String(username || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
    if (!clean) return '';
    return `<button type="button" class="forum-mention" data-member-mention="${v2Attr(clean)}" data-tooltip="Voir le profil de @${v2Attr(clean)}">@${v2Esc(clean)}</button>`;
}

async function openMentionedMember(username) {
    const clean = String(username || '').trim();
    if (!clean) return;
    const { data, error } = await v2Client().from('profiles').select('user_id,username').ilike('username', clean).maybeSingle();
    if (error || !data?.user_id) return v2Toast(`Le profil @${clean} n’est plus disponible.`);
    await openMemberProfile(data.user_id);
}

function v2RenderSpecialToken(token) {
    const replyMatch = token.match(/^\[\[reply:(\d+)\|([^|\]]+)\|([^\]]+)\]\]$/i);
    if (replyMatch) {
        const [, postId, author, excerpt] = replyMatch;
        return `<button type="button" class="forum-reply-reference" data-site-ref-kind="post" data-site-ref-id="${v2Attr(postId)}" data-site-ref-label="Message #${v2Attr(postId)}"><i class="fa-solid fa-reply"></i><span class="forum-reply-reference-copy"><small>Réponse à @${v2Esc(author)}</small><span>${v2Esc(excerpt)}</span></span><i class="fa-solid fa-arrow-turn-down"></i></button>`;
    }

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
    let protectedText = String(raw || '').replace(/\[\[(?:reply:\d+\|[^\]]+|ref:(?:project|document|subject|info|topic|post|member):[^\]]+|media:(?:image|file):https?:\/\/[^\]]+)\]\]/gi, match => {
        const index = tokens.push(v2RenderSpecialToken(match)) - 1;
        return `FORUMV2TOKEN${index}ENDTOKEN`;
    });

    protectedText = protectedText.replace(/(^|[\s([{>])@([A-Za-z0-9_.-]{3,40})/gm, (full, prefix, username) => {
        const index = tokens.push(v2RenderMention(username)) - 1;
        return `${prefix}FORUMV2TOKEN${index}ENDTOKEN`;
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
        mention.dataset.tooltip = 'Mentionner n’importe quel membre de la communauté';
        mention.className = 'forum-toolbar-wide';
        mention.innerHTML = '<i class="fa-solid fa-at"></i><span>Mentionner</span>';
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
        ['lessons', 'exercise_statements', 'exercise_corrections', 'sheets'].forEach(type => (subject[type] || []).forEach(doc => {
            if (doc?._dbId != null) items.push({ kind: 'document', id: String(doc._dbId), label: doc.title, detail: subject.name });
        }));
    });
    (window.globalResources || (typeof globalResources !== 'undefined' ? globalResources : []) || []).forEach(doc => {
        if (doc?._dbId != null) items.push({ kind: 'document', id: String(doc._dbId), label: doc.title, detail: 'Ressource générale' });
    });
    (window.generalInfo || generalInfo || []).forEach(info => {
        if (info?._dbId != null) {
            const scope = info.section === 'projects' ? 'Projets' : 'Études';
            items.push({ kind: 'info', id: String(info._dbId), label: info.title, detail: `${scope} · ${(info.text || '').slice(0, 90)}` });
        }
    });

    const client = v2Client();
    if (client) {
        const [topics, members, recentPosts] = await Promise.all([
            client.from('forum_topic_summaries').select('id,title,category_name').order('last_post_at', { ascending: false }).limit(150),
            client.from('profiles').select('user_id,username,role,is_banned').eq('is_banned', false).order('username').limit(500),
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

function v2PlainExcerpt(raw, max = 170) {
    return String(raw || '')
        .replace(/\[\[[^\]]+\]\]/g, ' ')
        .replace(/[`*_>#\[\]()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function renderReplyComposeContextV2() {
    const host = document.getElementById('forum-reply-context');
    if (!host) return;
    const context = forumV2State.replyContext;
    if (!context) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = `
        <div class="forum-reply-compose-icon"><i class="fa-solid fa-reply"></i></div>
        <div class="forum-reply-compose-copy"><small>Réponse à <strong>@${v2Esc(context.author)}</strong></small><span>${v2Esc(context.excerpt)}</span></div>
        <button type="button" class="forum-reply-compose-cancel" data-v2-cancel-reply data-tooltip="Annuler la réponse ciblée"><i class="fa-solid fa-xmark"></i></button>`;
}

function clearForumV2ReplyContext() {
    forumV2State.replyContext = null;
    renderReplyComposeContextV2();
}

function getForumV2ReplyContext() {
    const context = forumV2State.replyContext;
    if (!context || String(context.topicId) !== String(forumState.currentTopicId)) return null;
    return { ...context };
}

function replyToForumPostV2(postId) {
    if (!forumState.user) return openAccountModal('login');
    if (forumState.profile?.is_banned) return v2Toast('Votre compte est suspendu.');
    const post = forumState.rawPosts.get(Number(postId));
    if (!post || post.deleted_at) return;
    const profile = post.author_id ? forumState.profilesById.get(post.author_id) : null;
    const author = profile?.username || 'Utilisateur supprimé';
    const excerpt = String(post.content || '').replace(/\[\[(?:reply|ref|media):[^\]]+\]\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Message';
    forumV2State.replyContext = { postId: Number(post.id), topicId: String(forumState.currentTopicId), author, excerpt };
    renderReplyComposeContextV2();
    const textarea = document.getElementById('forum-reply-content');
    textarea?.focus();
    document.getElementById('forum-reply-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderForumReplyReference(postId) {
    const target = forumState.rawPosts.get(Number(postId));
    if (!target) return '';
    const profile = target.author_id ? forumState.profilesById.get(target.author_id) : null;
    const author = profile?.username || 'Utilisateur supprimé';
    const excerpt = String(target.content || '').replace(/\[\[(?:reply|ref|media):[^\]]+\]\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 155) || 'Message';
    return `<button type="button" class="forum-reply-reference structured" data-site-ref-kind="post" data-site-ref-id="${v2Attr(postId)}" data-site-ref-label="Message #${v2Attr(postId)}"><i class="fa-solid fa-reply"></i><span class="forum-reply-reference-copy"><small>Réponse à @${v2Esc(author)}</small><span>${v2Esc(excerpt)}</span></span><i class="fa-solid fa-arrow-turn-down"></i></button>`;
}

window.replyToForumPostV2 = replyToForumPostV2;
window.getForumV2ReplyContext = getForumV2ReplyContext;
window.clearForumV2ReplyContext = clearForumV2ReplyContext;
window.renderForumReplyReference = renderForumReplyReference;
window.renderForumReplyComposeContextV2 = renderReplyComposeContextV2;
window.openMentionedMember = openMentionedMember;

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
            for (const type of ['lessons', 'exercise_statements', 'exercise_corrections', 'sheets']) {
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
        const resource = (typeof globalResources !== 'undefined' ? globalResources : []).find(d => String(d._dbId) === String(id));
        if (resource) {
            navigateToSection('courses');
            switchMainCourseTab('global-resources-content');
            setTimeout(() => openResourcePdf(resource.title, resource.url, resource._dbId || ''), 100);
            return;
        }
    }
    if (kind === 'info') {
        const info = (typeof generalInfo !== 'undefined' ? generalInfo : []).find(item => String(item._dbId) === String(id));
        const section = info?.section === 'projects' ? 'projects' : 'studies';

        if (section === 'projects') {
            navigateToSection('projects');
            switchProjectPageTab('infos');
        } else {
            navigateToSection('courses');
            switchMainCourseTab('global-info-content');
        }

        setTimeout(() => {
            const container = section === 'projects' ? '#project-info-container' : '#general-info-container';
            const target = [...document.querySelectorAll(`${container} .info-block`)].find(el => String(el.dataset.infoId || '') === String(id));
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
    if (!(await siteConfirm({ title: 'Restaurer cette version ?', message: 'Cette ancienne version remplacera le contenu actuel.', detail: 'La version actuelle restera conservée dans l’historique.', confirmLabel: 'Restaurer', icon: 'fa-solid fa-clock-rotate-left' }))) return;
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

    const presenceKey = forumState.user?.id || `visitor-${Math.random().toString(36).slice(2)}`;
    const channel = client.channel('forum-community-presence', { config: { presence: { key: presenceKey } } });
    forumV2State.presenceChannel = channel;
    channel
        .on('presence', { event: 'sync' }, () => {
            const state = channel.presenceState();
            forumV2State.onlineUsers.clear();
            Object.values(state).flat().forEach(entry => {
                if (entry?.user_id) forumV2State.onlineUsers.set(entry.user_id, entry);
            });
            renderOnlineMembersV2();
            refreshPresenceSurfacesV2();
        })
        .subscribe(async status => {
            if (status === 'SUBSCRIBED' && forumState.user && forumState.profile) {
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
    const presence = document.getElementById('forum-members-presence');
    const countLabel = document.getElementById('forum-members-online-count');
    const avatars = document.getElementById('forum-members-online-avatars');

    if (countLabel) countLabel.textContent = `${count} en ligne`;
    if (presence) presence.classList.toggle('empty', count === 0);
    if (!avatars) return;

    const users = [...forumV2State.onlineUsers.values()].slice(0, 4);
    avatars.innerHTML = users.map(u => u.avatar_url
        ? `<button type="button" data-member-profile="${v2Attr(u.user_id)}" data-tooltip="${v2Attr(u.username)}" aria-label="Voir le profil de ${v2Attr(u.username)}"><img src="${v2Attr(u.avatar_url)}" alt=""></button>`
        : `<button type="button" data-member-profile="${v2Attr(u.user_id)}" data-tooltip="${v2Attr(u.username)}" aria-label="Voir le profil de ${v2Attr(u.username)}">${v2Esc(String(u.username || '?').slice(0, 2).toUpperCase())}</button>`
    ).join('');
}

function v2IsOnline(userId = '', username = '') {
    if (userId && forumV2State.onlineUsers.has(String(userId))) return true;
    const wanted = String(username || '').trim().toLowerCase();
    if (!wanted) return false;
    return [...forumV2State.onlineUsers.values()].some(entry => String(entry?.username || '').trim().toLowerCase() === wanted);
}

window.isForumUserOnlineV2 = v2IsOnline;

function refreshForumGeneralPresenceV2() {
    document.querySelectorAll('[data-forum-presence-user]').forEach(element => {
        const online = v2IsOnline(element.dataset.forumPresenceUser, element.dataset.forumPresenceName || '');
        element.classList.toggle('is-online', online);
        element.setAttribute('aria-label', online ? 'En ligne' : 'Hors ligne');
        const label = element.querySelector('.forum-user-presence-label');
        if (label) label.textContent = online ? 'En ligne' : 'Hors ligne';
    });
}

async function openForumMembersDirectoryV2() {
    openModalById('forumMembersModal');
    const list = document.getElementById('forum-members-directory-list');
    if (list) list.innerHTML = '<div class="forum-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><span>Chargement des membres…</span></div>';
    const { data, error } = await v2Client().from('community_members').select('*').order('username').limit(500);
    if (error) {
        if (list) list.innerHTML = `<div class="forum-state compact"><i class="fa-solid fa-triangle-exclamation"></i><p>${v2Esc(error.message || 'Impossible de charger les membres.')}</p></div>`;
        return;
    }
    forumV2State.memberDirectory = data || [];
    renderForumMembersDirectoryV2();
}

function renderForumMembersDirectoryV2() {
    const list = document.getElementById('forum-members-directory-list');
    if (!list) return;
    const term = String(document.getElementById('forum-members-directory-search')?.value || '').trim().toLowerCase();
    const filter = forumV2State.memberDirectoryFilter || 'all';
    const rows = forumV2State.memberDirectory.filter(member => {
        const matchesSearch = !term || String(member.username || '').toLowerCase().includes(term);
        const matchesFilter = filter !== 'online' || v2IsOnline(member.user_id, member.username);
        return matchesSearch && matchesFilter;
    });
    const onlineTotal = forumV2State.memberDirectory.filter(member => v2IsOnline(member.user_id, member.username)).length;
    const summary = document.getElementById('forum-members-directory-summary');
    if (summary) summary.textContent = `${forumV2State.memberDirectory.length} membre${forumV2State.memberDirectory.length === 1 ? '' : 's'} · ${onlineTotal} en ligne`;
    if (!rows.length) {
        list.innerHTML = '<div class="forum-state compact"><i class="fa-solid fa-user-slash"></i><p>Aucun membre ne correspond à ce filtre.</p></div>';
        return;
    }
    list.innerHTML = rows.map(member => {
        const online = v2IsOnline(member.user_id, member.username);
        const role = member.role === 'admin' ? 'Admin' : member.role === 'moderator' ? 'Modérateur' : 'Membre';
        return `<button type="button" class="forum-directory-member ${online ? 'is-online' : ''}" data-member-directory-profile="${v2Attr(member.user_id)}">
            <span class="forum-directory-avatar">${fAvatar(member)}<span class="forum-directory-online-dot" aria-hidden="true"></span></span>
            <span class="forum-directory-copy"><strong>${v2Esc(member.username)}</strong><small>${v2Esc(role)} · inscrit ${fRelativeDate(member.created_at)}</small></span>
            <span class="forum-directory-presence"><span class="forum-directory-status-dot"></span>${online ? 'En ligne' : 'Hors ligne'}</span>
            <i class="fa-solid fa-chevron-right"></i>
        </button>`;
    }).join('');
}

function refreshPresenceSurfacesV2() {
    refreshForumGeneralPresenceV2();
    if (document.getElementById('forumMembersModal')?.classList.contains('active')) renderForumMembersDirectoryV2();
    if (document.getElementById('privateMessagesModal')?.classList.contains('active')) {
        loadPrivateThreads().catch(() => {});
        updateCurrentPrivatePresenceV2();
    }
    if (document.getElementById('privateGroupMembersModal')?.classList.contains('active')) renderPrivateGroupMemberList();
}

function updateCurrentPrivatePresenceV2() {
    const summary = currentPrivateSummary();
    const label = document.querySelector('[data-private-presence-label]');
    if (!summary || !label) return;
    if (summary.is_group) {
        const count = forumV2State.currentPrivateMembers.filter(m => v2IsOnline(m.user_id, m.username)).length;
        label.textContent = `${forumV2State.currentPrivateMembers.length} membre${forumV2State.currentPrivateMembers.length === 1 ? '' : 's'} · ${count} en ligne`;
        label.classList.toggle('is-online', count > 0);
    } else {
        const other = forumV2State.currentPrivateMembers.find(m => m.user_id !== forumState.user?.id);
        const online = v2IsOnline(other?.user_id, other?.username || summary.other_username);
        label.textContent = online ? 'En ligne' : 'Hors ligne';
        label.classList.toggle('is-online', online);
    }
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
   MESSAGES PRIVÉS — V2.5 : conversations individuelles + groupes
========================================================== */

const forumV1RenderAccountPopover = renderAccountPopover;
renderAccountPopover = function forumV2RenderAccountPopover() {
    forumV1RenderAccountPopover();
    const pop = document.getElementById('account-popover');
    if (!pop || !forumState.user) return;
    // Ces deux raccourcis sont déjà accessibles directement dans la barre de navigation.
    pop.querySelector('[data-account-action="my-topics"]')?.remove();
    pop.querySelector('[data-account-action="messages"]')?.remove();
};

async function getPrivateMemberDirectory(force = false) {
    if (!force && forumV2State.privateMemberDirectory.length) return forumV2State.privateMemberDirectory;
    const { data, error } = await v2Client().from('profiles')
        .select('user_id,username,avatar_url,role,is_banned,private_messages_enabled')
        .eq('is_banned', false)
        .order('username')
        .limit(500);
    if (error) throw error;
    forumV2State.privateMemberDirectory = (data || []).filter(p => p.user_id !== forumState.user?.id);
    return forumV2State.privateMemberDirectory;
}

function privateAvatar(profile, extraClass = '') {
    if (profile?.avatar_url) return `<span class="member-avatar ${extraClass}"><img src="${v2Attr(profile.avatar_url)}" alt=""></span>`;
    const label = String(profile?.username || '?').slice(0, 2).toUpperCase();
    return `<span class="member-avatar ${extraClass}">${v2Esc(label)}</span>`;
}

function privateGroupAvatar() {
    return '<span class="member-avatar private-group-avatar"><i class="fa-solid fa-user-group"></i></span>';
}

function privateSystemMessageText(content) {
    const raw = String(content || '');
    return raw.startsWith('[[system]]') ? raw.slice('[[system]]'.length).trim() : '';
}

function privateMessagePreview(content, fallback = '') {
    const systemText = privateSystemMessageText(content);
    return (systemText || String(content || fallback)).replace(/\s+/g, ' ').trim();
}

function currentPrivateSummary() {
    return forumV2State.currentPrivateThreadSummary
        || forumV2State.privateThreads.find(t => String(t.id) === String(forumV2State.currentPrivateThreadId))
        || null;
}

async function openPrivateMessages(otherUserId = null) {
    if (!forumState.user) return openAccountModal('login');
    closeAccountPopover();
    openModalById('privateMessagesModal');
    if (otherUserId && otherUserId !== forumState.user.id) {
        const { data, error } = await v2Client().rpc('get_or_create_private_thread', { p_other_user: otherUserId });
        if (error) return v2Toast(error.message || 'Impossible de créer la conversation.');
        forumV2State.currentPrivateThreadId = data;
        forumV2State.currentPrivateThreadSummary = null;
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
    forumV2State.privateThreads = data || [];
    if (forumV2State.currentPrivateThreadId) {
        forumV2State.currentPrivateThreadSummary = forumV2State.privateThreads.find(t => String(t.id) === String(forumV2State.currentPrivateThreadId)) || null;
    }
    list.innerHTML = data?.length ? data.map(t => {
        const group = Boolean(t.is_group);
        const name = t.display_name || t.title || t.other_username || 'Conversation';
        const avatar = group ? privateGroupAvatar() : (t.display_avatar_url ? `<span class="member-avatar"><img src="${v2Attr(t.display_avatar_url)}" alt=""></span>` : privateAvatar({ username: name }));
        const preview = privateMessagePreview(t.last_message, group ? 'Nouveau groupe' : 'Nouvelle conversation');
        const directOnline = !group && v2IsOnline('', t.other_username || name);
        const detail = group ? `${Number(t.participant_count || 0)} membres · ${preview.slice(0, 70)}` : preview.slice(0, 80);
        return `<button type="button" class="private-thread-item ${String(t.id) === String(forumV2State.currentPrivateThreadId) ? 'active' : ''}" data-private-thread="${v2Attr(t.id)}">
            <span class="private-thread-avatar-presence ${directOnline ? 'is-online' : ''}">${avatar}${!group ? '<span class="private-presence-dot"></span>' : ''}</span>
            <span><strong>${v2Esc(name)}</strong><small>${!group ? `<span class="private-thread-online-label ${directOnline ? 'is-online' : ''}">${directOnline ? 'En ligne' : 'Hors ligne'}</span> · ` : ''}${v2Esc(detail)}</small></span>
            ${Number(t.unread_count || 0) ? `<span class="private-unread">${Number(t.unread_count)}</span>` : ''}
        </button>`;
    }).join('') : '<div class="admin-empty"><i class="fa-regular fa-paper-plane"></i><p>Aucune conversation privée.</p><small>Écrivez à un membre ou créez un groupe.</small></div>';
}

async function fetchPrivateThreadMembers(threadId) {
    const client = v2Client();
    const { data: memberships, error } = await client.from('private_thread_members')
        .select('thread_id,user_id,joined_at,added_by,last_read_at')
        .eq('thread_id', threadId)
        .order('joined_at');
    if (error) throw error;
    const ids = (memberships || []).map(m => m.user_id);
    const profiles = ids.length ? (await client.from('profiles').select('user_id,username,avatar_url,role,is_banned').in('user_id', ids)).data || [] : [];
    const map = new Map(profiles.map(p => [p.user_id, p]));
    return (memberships || []).map(m => ({ ...m, ...(map.get(m.user_id) || { username: 'Utilisateur supprimé', avatar_url: '' }) }));
}

function renderPrivateHeadParticipants(members) {
    return `<span class="private-head-avatars">${members.slice(0, 4).map(m => `<span class="private-head-avatar-presence ${v2IsOnline(m.user_id, m.username) ? 'is-online' : ''}">${privateAvatar(m, 'tiny')}<span class="private-presence-dot"></span></span>`).join('')}${members.length > 4 ? `<span class="private-head-more">+${members.length - 4}</span>` : ''}</span>`;
}

async function openPrivateThread(threadId) {
    const previousThreadId = forumV2State.currentPrivateThreadId;
    const sameThread = String(previousThreadId || '') === String(threadId || '');
    const previousTextarea = sameThread ? document.getElementById('private-message-content') : null;
    const draftState = previousTextarea ? {
        value: previousTextarea.value,
        start: previousTextarea.selectionStart,
        end: previousTextarea.selectionEnd,
        focused: document.activeElement === previousTextarea
    } : null;

    forumV2State.currentPrivateThreadId = threadId;
    const client = v2Client();
    let summary = forumV2State.privateThreads.find(t => String(t.id) === String(threadId));
    if (!summary) {
        const { data } = await client.from('private_thread_summaries').select('*').eq('id', threadId).maybeSingle();
        summary = data || null;
    }
    forumV2State.currentPrivateThreadSummary = summary;

    const [{ data: messages, error }, members] = await Promise.all([
        client.from('private_messages').select('*').eq('thread_id', threadId).order('created_at'),
        fetchPrivateThreadMembers(threadId)
    ]);
    if (error) return v2Toast(error.message || 'Conversation indisponible.');
    forumV2State.currentPrivateMembers = members;
    const profileMap = new Map(members.map(p => [p.user_id, p]));
    const pane = document.getElementById('private-message-pane');
    if (!pane) return;

    const isGroup = Boolean(summary?.is_group);
    const other = !isGroup ? members.find(p => p.user_id !== forumState.user.id) : null;
    const title = isGroup ? (summary?.display_name || summary?.title || 'Discussion de groupe') : (other?.username || summary?.other_username || 'Conversation');
    const onlineCount = members.filter(m => v2IsOnline(m.user_id, m.username)).length;
    const otherOnline = !isGroup && v2IsOnline(other?.user_id, other?.username || summary?.other_username);
    const subtitle = isGroup ? `${members.length} membre${members.length > 1 ? 's' : ''} · ${onlineCount} en ligne` : (otherOnline ? 'En ligne' : 'Hors ligne');

    pane.innerHTML = `
        <div class="private-chat-head">
            <div class="private-chat-identity"><span class="private-chat-main-avatar ${!isGroup && otherOnline ? 'is-online' : ''}">${isGroup ? privateGroupAvatar() : privateAvatar(other || { username: title }, 'head')}${!isGroup ? '<span class="private-presence-dot"></span>' : ''}</span><div><strong>${v2Esc(title)}</strong><small class="private-chat-presence-label ${isGroup ? (onlineCount ? 'is-online' : '') : (otherOnline ? 'is-online' : '')}" data-private-presence-label>${v2Esc(subtitle)}</small></div></div>
            <div class="private-chat-head-tools">${isGroup ? renderPrivateHeadParticipants(members) : ''}<button type="button" class="private-chat-members-btn" data-private-group-manage data-tooltip="${isGroup ? 'Gérer les membres' : 'Ajouter des membres à cette conversation'}"><i class="fa-solid fa-users"></i><span>${isGroup ? 'Membres' : 'Ajouter'}</span></button></div>
        </div>
        <div id="private-message-list" class="private-message-list">${messages?.length ? messages.map(m => {
            const systemText = !m.deleted_at ? privateSystemMessageText(m.content) : '';
            if (systemText) {
                return `<div class="private-system-event"><span class="private-system-event-icon"><i class="fa-solid fa-circle-info"></i></span><div class="private-system-event-copy">${renderForumText(systemText)}</div><time>${fRelativeDate(m.created_at)}</time></div>`;
            }
            const mine = m.author_id === forumState.user.id;
            const author = profileMap.get(m.author_id) || { username: mine ? forumState.profile?.username : 'Utilisateur supprimé', user_id: m.author_id };
            const authorOnline = v2IsOnline(author.user_id, author.username);
            return `<article class="private-message ${mine ? 'mine' : ''}"><div class="private-message-meta"><button type="button" class="private-message-author" data-private-member-profile="${v2Attr(author.user_id || '')}">${authorOnline ? '<span class="private-author-online-dot"></span>' : ''}${v2Esc(author.username)}</button><span>${fRelativeDate(m.created_at)}</span></div><div class="private-message-body">${m.deleted_at ? '<em>Message supprimé.</em>' : renderForumText(m.content)}</div></article>`;
        }).join('') : '<div class="forum-state compact"><p>Commencez la conversation.</p></div>'}</div>
        <form id="private-message-form" class="private-message-form">
            <div class="private-message-editor">
                <div class="forum-editor-toolbar private-message-toolbar" data-editor-target="private-message-content">
                    <button type="button" data-format="bold" data-tooltip="Gras"><i class="fa-solid fa-bold"></i></button>
                    <button type="button" data-format="italic" data-tooltip="Italique"><i class="fa-solid fa-italic"></i></button>
                    <button type="button" data-format="code" data-tooltip="Code"><i class="fa-solid fa-code"></i></button>
                </div>
                <textarea id="private-message-content" rows="3" maxlength="5000" required placeholder="Votre message privé…"></textarea>
            </div>
            <button class="primary-btn compact-btn private-message-send" type="submit"><i class="fa-solid fa-paper-plane"></i><span>Envoyer</span></button>
        </form>`;
    v2RenderMath(pane);
    enhanceForumEditorToolbars(document);

    // Un rafraîchissement temps réel ne doit jamais faire perdre le brouillon ni le focus.
    if (draftState) {
        const nextTextarea = document.getElementById('private-message-content');
        if (nextTextarea) {
            nextTextarea.value = draftState.value;
            if (draftState.focused) {
                nextTextarea.focus({ preventScroll: true });
                const max = nextTextarea.value.length;
                const start = Math.min(Number(draftState.start ?? max), max);
                const end = Math.min(Number(draftState.end ?? start), max);
                try { nextTextarea.setSelectionRange(start, end); } catch (_) {}
            }
        }
    }

    await client.rpc('mark_private_thread_read', { p_thread_id: threadId });
    await loadPrivateThreads();
    setTimeout(() => { const msgList = document.getElementById('private-message-list'); if (msgList) msgList.scrollTop = msgList.scrollHeight; }, 30);
}

async function sendPrivateMessage(event) {
    event.preventDefault();
    if (!forumV2State.currentPrivateThreadId) return;
    const textarea = document.getElementById('private-message-content');
    const content = textarea?.value.trim() || '';
    if (!content) return;
    const { error } = await v2Client().from('private_messages').insert({ thread_id: forumV2State.currentPrivateThreadId, author_id: forumState.user.id, content });
    if (error) return v2Toast(error.message || 'Envoi impossible.');
    textarea.value = '';
    await openPrivateThread(forumV2State.currentPrivateThreadId);
}

function renderPrivateDirectResults() {
    const host = document.getElementById('private-direct-results');
    if (!host) return;
    const term = String(document.getElementById('private-direct-search')?.value || '').trim().toLowerCase();
    const rows = forumV2State.privateMemberDirectory
        .filter(p => p.private_messages_enabled !== false && (!term || p.username.toLowerCase().includes(term)))
        .slice(0, 80);
    host.innerHTML = rows.length ? rows.map(p => {
        const online = v2IsOnline(p.user_id, p.username);
        const role = p.role === 'admin' ? 'Admin' : p.role === 'moderator' ? 'Modérateur' : 'Membre';
        return `
        <button type="button" class="private-direct-member ${online ? 'is-online' : ''}" data-private-direct-user="${v2Attr(p.user_id)}">
            <span class="private-group-avatar-presence ${online ? 'is-online' : ''}">${privateAvatar(p)}<span class="private-presence-dot"></span></span>
            <span><strong>${v2Esc(p.username)}</strong><small>${role} · <span class="private-member-presence-text ${online ? 'is-online' : ''}">${online ? 'En ligne' : 'Hors ligne'}</span></small></span>
            <i class="fa-solid fa-chevron-right"></i>
        </button>`;
    }).join('') : '<div class="admin-empty compact"><p>Aucun membre correspondant.</p></div>';
}

async function openPrivateDirectCreator() {
    if (!forumState.user) return openAccountModal('login');
    const host = document.getElementById('private-direct-results');
    const input = document.getElementById('private-direct-search');
    if (input) input.value = '';
    if (host) host.innerHTML = '<div class="forum-loading compact"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
    openModalById('privateDirectCreateModal');
    try {
        await getPrivateMemberDirectory(true);
        renderPrivateDirectResults();
        setTimeout(() => input?.focus(), 40);
    } catch (error) {
        if (host) host.innerHTML = `<div class="admin-empty compact"><p>${v2Esc(error.message || 'Liste des membres indisponible.')}</p></div>`;
    }
}

async function startPrivateDirectConversation(userId) {
    if (!userId) return;
    closeModalById('privateDirectCreateModal');
    await openPrivateMessages(userId);
}

function renderPrivateGroupCreateMembers() {
    const host = document.getElementById('private-group-create-members');
    if (!host) return;
    const term = String(document.getElementById('private-group-create-search')?.value || '').trim().toLowerCase();
    const rows = forumV2State.privateMemberDirectory.filter(p => p.private_messages_enabled !== false && (!term || p.username.toLowerCase().includes(term)));
    host.innerHTML = rows.length ? rows.map(p => {
        const checked = forumV2State.groupSelectedMembers.has(p.user_id);
        const online = v2IsOnline(p.user_id, p.username);
        const role = p.role === 'admin' ? 'Admin' : p.role === 'moderator' ? 'Modérateur' : 'Membre';
        return `<label class="private-group-candidate ${checked ? 'selected' : ''} ${online ? 'is-online' : ''}"><input type="checkbox" data-private-group-create-member="${v2Attr(p.user_id)}" ${checked ? 'checked' : ''}><span class="private-group-avatar-presence ${online ? 'is-online' : ''}">${privateAvatar(p)}<span class="private-presence-dot"></span></span><span><strong>${v2Esc(p.username)}</strong><small>${role} · <span class="private-member-presence-text ${online ? 'is-online' : ''}">${online ? 'En ligne' : 'Hors ligne'}</span></small></span><i class="fa-solid fa-check"></i></label>`;
    }).join('') : '<div class="admin-empty"><p>Aucun membre correspondant.</p></div>';
}

async function openPrivateGroupCreator(options = {}) {
    if (!forumState.user) return openAccountModal('login');
    const presetMemberIds = Array.isArray(options.presetMemberIds) ? options.presetMemberIds.filter(Boolean) : [];
    forumV2State.groupSelectedMembers = new Set(presetMemberIds);
    document.getElementById('private-group-create-form')?.reset();
    const nameInput = document.getElementById('private-group-create-name');
    if (nameInput && options.suggestedName) nameInput.value = String(options.suggestedName).slice(0, 80);
    const msg = document.getElementById('private-group-create-message');
    if (msg) {
        msg.hidden = !options.preserveCurrentThread;
        msg.className = 'account-message info';
        msg.textContent = options.preserveCurrentThread ? 'La conversation actuelle restera inchangée. Un nouveau groupe séparé sera créé.' : '';
    }
    const host = document.getElementById('private-group-create-members');
    if (host) host.innerHTML = '<div class="forum-loading compact"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
    openModalById('privateGroupCreateModal');
    try {
        await getPrivateMemberDirectory(true);
        renderPrivateGroupCreateMembers();
        setTimeout(() => nameInput?.focus(), 40);
    } catch (error) { v2Toast(error.message || 'Liste des membres indisponible.'); }
}

async function submitPrivateGroupCreate(event) {
    event.preventDefault();
    const name = document.getElementById('private-group-create-name')?.value.trim() || '';
    const ids = [...forumV2State.groupSelectedMembers];
    const msg = document.getElementById('private-group-create-message');
    if (ids.length < 2) {
        if (msg) { msg.textContent = 'Sélectionnez au moins deux membres pour créer un groupe.'; msg.className = 'account-message error'; msg.hidden = false; }
        return;
    }
    const { data, error } = await v2Client().rpc('create_private_group', { p_title: name, p_member_ids: ids });
    if (error) {
        if (msg) { msg.textContent = error.message || 'Création impossible.'; msg.className = 'account-message error'; msg.hidden = false; }
        return;
    }
    closeModalById('privateGroupCreateModal');
    forumV2State.currentPrivateThreadId = data;
    forumV2State.currentPrivateThreadSummary = null;
    await loadPrivateThreads();
    await openPrivateThread(data);
    v2Toast('Groupe créé.');
}

function renderPrivateGroupMemberList() {
    const host = document.getElementById('private-group-member-list');
    const summary = currentPrivateSummary();
    if (!host || !summary) return;
    const responsible = String(summary.creator_id || '') === String(forumState.user?.id || '');
    const members = forumV2State.currentPrivateMembers;
    document.getElementById('private-group-member-count').textContent = `${members.length} membre${members.length > 1 ? 's' : ''}`;
    host.innerHTML = members.map(member => {
        const isResponsible = String(member.user_id) === String(summary.creator_id || '');
        const canManage = Boolean(summary.is_group && responsible && !isResponsible);
        const roleLabel = isResponsible
            ? '<span class="private-group-responsible-label"><i class="fa-solid fa-crown"></i> Responsable du groupe</span>'
            : (member.role === 'admin' ? 'Admin' : member.role === 'moderator' ? 'Modérateur' : 'Membre');
        const actions = canManage ? `<div class="private-group-member-actions"><button type="button" class="private-group-responsible-btn" data-private-group-transfer="${v2Attr(member.user_id)}" data-tooltip="Nommer responsable du groupe"><i class="fa-solid fa-crown"></i></button><button type="button" class="private-group-remove-btn" data-private-group-remove="${v2Attr(member.user_id)}" data-tooltip="Retirer du groupe"><i class="fa-solid fa-user-minus"></i></button></div>` : '';
        const online = v2IsOnline(member.user_id, member.username);
        return `<div class="private-group-member-row ${online ? 'is-online' : ''}"><button type="button" class="private-group-member-profile" data-private-member-profile="${v2Attr(member.user_id)}"><span class="private-group-avatar-presence ${online ? 'is-online' : ''}">${privateAvatar(member)}<span class="private-presence-dot"></span></span><span><strong>${v2Esc(member.username)}</strong><small>${roleLabel} <span class="private-member-presence-text ${online ? 'is-online' : ''}">· ${online ? 'En ligne' : 'Hors ligne'}</span></small></span></button>${actions}</div>`;
    }).join('');
}

function renderPrivateGroupAddResults() {
    const host = document.getElementById('private-group-add-results');
    if (!host) return;
    const term = String(document.getElementById('private-group-add-search')?.value || '').trim().toLowerCase();
    const memberIds = new Set(forumV2State.currentPrivateMembers.map(m => m.user_id));
    const rows = forumV2State.privateMemberDirectory.filter(p => p.private_messages_enabled !== false && !memberIds.has(p.user_id) && (!term || p.username.toLowerCase().includes(term))).slice(0, 60);
    host.innerHTML = rows.length ? rows.map(p => {
        const online = v2IsOnline(p.user_id, p.username);
        const role = p.role === 'admin' ? 'Admin' : p.role === 'moderator' ? 'Modérateur' : 'Membre';
        return `<div class="private-group-add-row ${online ? 'is-online' : ''}"><span class="private-group-avatar-presence ${online ? 'is-online' : ''}">${privateAvatar(p)}<span class="private-presence-dot"></span></span><span><strong>${v2Esc(p.username)}</strong><small>${role} · <span class="private-member-presence-text ${online ? 'is-online' : ''}">${online ? 'En ligne' : 'Hors ligne'}</span></small></span><button type="button" class="private-group-add-btn" data-private-group-add="${v2Attr(p.user_id)}"><i class="fa-solid fa-user-plus"></i> Ajouter</button></div>`;
    }).join('') : '<div class="admin-empty compact"><p>Aucun autre membre.</p></div>';
}

async function openPrivateGroupMembers() {
    if (!forumV2State.currentPrivateThreadId) return;
    const summary = currentPrivateSummary();
    if (!summary) return;
    openModalById('privateGroupMembersModal');
    const subtitle = document.getElementById('private-group-members-subtitle');
    if (subtitle) subtitle.textContent = summary.is_group ? 'Tous les participants peuvent ajouter un membre. Seul le responsable du groupe peut en retirer ou transmettre son rôle.' : 'Ajouter quelqu’un transformera cette conversation en groupe. Vous en deviendrez le responsable.';
    try {
        forumV2State.currentPrivateMembers = await fetchPrivateThreadMembers(summary.id);
        await getPrivateMemberDirectory(true);
        const rename = document.getElementById('private-group-rename-form');
        const canRename = Boolean(summary.is_group && String(summary.creator_id || '') === String(forumState.user.id));
        if (rename) rename.hidden = !canRename;
        const input = document.getElementById('private-group-rename-input');
        if (input) input.value = summary.title || summary.display_name || '';
        const leaveZone = document.getElementById('private-group-leave-zone');
        const leaveHelp = document.getElementById('private-group-leave-help');
        if (leaveZone) leaveZone.hidden = !summary.is_group;
        if (leaveHelp && summary.is_group) leaveHelp.textContent = canRename
            ? 'En quittant le groupe, votre rôle de responsable sera automatiquement transmis à un autre membre.'
            : 'Vous ne recevrez plus les nouveaux messages de ce groupe.';
        renderPrivateGroupMemberList();
        renderPrivateGroupAddResults();
    } catch (error) { v2Toast(error.message || 'Participants indisponibles.'); }
}

async function performAddPrivateMemberToCurrent(userId) {
    const summary = currentPrivateSummary();
    if (!summary) return;
    const { error } = await v2Client().rpc('add_private_thread_member', { p_thread_id: summary.id, p_user_id: userId });
    if (error) return v2Toast(error.message || 'Ajout impossible.');
    await loadPrivateThreads();
    forumV2State.currentPrivateThreadSummary = forumV2State.privateThreads.find(t => String(t.id) === String(summary.id)) || forumV2State.currentPrivateThreadSummary;
    forumV2State.currentPrivateMembers = await fetchPrivateThreadMembers(summary.id);
    const refreshed = currentPrivateSummary();
    const rename = document.getElementById('private-group-rename-form');
    if (rename) rename.hidden = !(refreshed?.is_group && String(refreshed.creator_id || '') === String(forumState.user.id));
    const renameInput = document.getElementById('private-group-rename-input');
    if (renameInput && refreshed?.is_group) renameInput.value = refreshed.title || refreshed.display_name || '';
    const subtitle = document.getElementById('private-group-members-subtitle');
    if (subtitle && refreshed?.is_group) subtitle.textContent = 'Tous les participants peuvent ajouter un membre. Seul le responsable du groupe peut en retirer ou transmettre son rôle.';
    const leaveZone = document.getElementById('private-group-leave-zone');
    if (leaveZone) leaveZone.hidden = !refreshed?.is_group;
    renderPrivateGroupMemberList();
    renderPrivateGroupAddResults();
    await openPrivateThread(summary.id);
    v2Toast('Membre ajouté au groupe.');
}

async function addPrivateGroupMember(userId) {
    const summary = currentPrivateSummary();
    if (!summary || !userId) return;

    if (summary.is_group) {
        await performAddPrivateMemberToCurrent(userId);
        return;
    }

    forumV2State.pendingPrivateAddUserId = userId;
    const added = forumV2State.privateMemberDirectory.find(p => String(p.user_id) === String(userId));
    const other = forumV2State.currentPrivateMembers.find(p => String(p.user_id) !== String(forumState.user.id));
    const copy = document.getElementById('private-add-choice-copy');
    if (copy) copy.textContent = `${added?.username || 'Ce membre'} peut rejoindre cette conversation avec ${other?.username || 'votre correspondant'}, ou vous pouvez créer un nouveau groupe sans modifier l’échange actuel.`;
    openModalById('privateAddChoiceModal');
}

async function handlePrivateAddChoice(mode) {
    const userId = forumV2State.pendingPrivateAddUserId;
    const summary = currentPrivateSummary();
    if (!userId || !summary) return;
    closeModalById('privateAddChoiceModal');

    if (mode === 'current') {
        forumV2State.pendingPrivateAddUserId = null;
        await performAddPrivateMemberToCurrent(userId);
        return;
    }

    if (mode === 'new') {
        const added = forumV2State.privateMemberDirectory.find(p => String(p.user_id) === String(userId));
        const other = forumV2State.currentPrivateMembers.find(p => String(p.user_id) !== String(forumState.user.id));
        forumV2State.pendingPrivateAddUserId = null;
        closeModalById('privateGroupMembersModal');
        const preset = [other?.user_id, userId].filter(Boolean);
        const labels = [other?.username, added?.username].filter(Boolean);
        await openPrivateGroupCreator({
            presetMemberIds: preset,
            suggestedName: labels.length ? `Groupe avec ${labels.join(' et ')}` : 'Nouveau groupe',
            preserveCurrentThread: true
        });
    }
}

async function removePrivateGroupMember(userId) {
    const summary = currentPrivateSummary();
    const member = forumV2State.currentPrivateMembers.find(m => String(m.user_id) === String(userId));
    if (!summary || !member) return;
    const ok = await siteConfirm({ title: `Retirer ${member.username} ?`, message: 'Ce membre ne pourra plus lire les nouveaux messages de ce groupe.', detail: 'Les anciens messages restent dans la conversation.', confirmLabel: 'Retirer', danger: true, icon: 'fa-solid fa-user-minus' });
    if (!ok) return;
    const { error } = await v2Client().rpc('remove_private_thread_member', { p_thread_id: summary.id, p_user_id: userId });
    if (error) return v2Toast(error.message || 'Suppression impossible.');
    forumV2State.currentPrivateMembers = await fetchPrivateThreadMembers(summary.id);
    renderPrivateGroupMemberList();
    renderPrivateGroupAddResults();
    await loadPrivateThreads();
    await openPrivateThread(summary.id);
    v2Toast('Membre retiré du groupe.');
}

async function transferPrivateGroupResponsibility(userId) {
    const summary = currentPrivateSummary();
    const member = forumV2State.currentPrivateMembers.find(m => String(m.user_id) === String(userId));
    if (!summary?.is_group || !member || !forumState.user) return;
    const iAmResponsible = String(summary.creator_id || '') === String(forumState.user.id);
    if (!iAmResponsible || String(userId) === String(forumState.user.id)) return;

    const accepted = await siteConfirm({
        title: `Nommer ${member.username} responsable ?`,
        message: `${member.username} deviendra responsable de ce groupe à votre place.`,
        detail: 'Vous resterez membre du groupe. Le nouveau responsable pourra renommer le groupe, retirer des membres et transmettre à son tour ce rôle.',
        confirmLabel: 'Transmettre le rôle',
        icon: 'fa-solid fa-crown'
    });
    if (!accepted) return;

    const { error } = await v2Client().rpc('transfer_private_group_responsibility', {
        p_thread_id: summary.id,
        p_new_responsible: userId
    });
    if (error) return v2Toast(error.message || 'Transfert du rôle impossible.');

    await loadPrivateThreads();
    forumV2State.currentPrivateThreadSummary = forumV2State.privateThreads.find(t => String(t.id) === String(summary.id)) || null;
    forumV2State.currentPrivateMembers = await fetchPrivateThreadMembers(summary.id);
    await openPrivateThread(summary.id);
    await openPrivateGroupMembers();
    v2Toast(`${member.username} est maintenant responsable du groupe.`);
}

async function leavePrivateGroup() {
    const summary = currentPrivateSummary();
    if (!summary?.is_group || !forumState.user) return;
    const isResponsible = String(summary.creator_id || '') === String(forumState.user.id);
    const accepted = await siteConfirm({
        title: `Quitter « ${summary.display_name || summary.title || 'ce groupe'} » ?`,
        message: 'Vous ne pourrez plus lire les nouveaux messages de ce groupe.',
        detail: isResponsible
            ? 'Vous êtes responsable du groupe : le rôle sera automatiquement transmis au membre présent depuis le plus longtemps.'
            : 'Vous pourrez être ajouté de nouveau plus tard par un participant.',
        confirmLabel: 'Quitter le groupe',
        danger: true,
        icon: 'fa-solid fa-arrow-right-from-bracket'
    });
    if (!accepted) return;

    const leavingThreadId = summary.id;
    const { data, error } = await v2Client().rpc('leave_private_group', { p_thread_id: leavingThreadId });
    if (error) return v2Toast(error.message || 'Impossible de quitter le groupe.');

    closeModalById('privateGroupMembersModal');
    forumV2State.currentPrivateThreadId = null;
    forumV2State.currentPrivateThreadSummary = null;
    forumV2State.currentPrivateMembers = [];
    await loadPrivateThreads();

    const pane = document.getElementById('private-message-pane');
    if (forumV2State.privateThreads.length) {
        await openPrivateThread(forumV2State.privateThreads[0].id);
    } else if (pane) {
        pane.innerHTML = '<div class="private-chat-empty"><div><i class="fa-regular fa-paper-plane fa-2x"></i><h3>Aucune conversation sélectionnée</h3><p>Démarrez un nouveau message ou créez un groupe.</p></div></div>';
    }
    v2Toast(data?.thread_deleted ? 'Groupe supprimé : vous étiez le dernier membre.' : 'Vous avez quitté le groupe.');
}

async function renamePrivateGroup(event) {
    event.preventDefault();
    const summary = currentPrivateSummary();
    const title = document.getElementById('private-group-rename-input')?.value.trim() || '';
    if (!summary || !title) return;
    const { error } = await v2Client().rpc('rename_private_group', { p_thread_id: summary.id, p_title: title });
    if (error) return v2Toast(error.message || 'Renommage impossible.');
    await loadPrivateThreads();
    await openPrivateThread(summary.id);
    v2Toast('Nom du groupe mis à jour.');
}

async function setupPrivateRealtimeV2() {
    const client = v2Client();
    if (!client) return;
    if (forumV2State.privateChannel) await client.removeChannel(forumV2State.privateChannel);
    forumV2State.privateChannel = null;
    if (forumV2State.privateMembershipRefreshTimer) {
        clearTimeout(forumV2State.privateMembershipRefreshTimer);
        forumV2State.privateMembershipRefreshTimer = null;
    }
    if (!forumState.user) return;

    const refreshMembership = () => {
        // Les ajouts/suppressions de membres peuvent arriver en rafale : on regroupe les rafraîchissements.
        clearTimeout(forumV2State.privateMembershipRefreshTimer);
        forumV2State.privateMembershipRefreshTimer = setTimeout(async () => {
            forumV2State.privateMembershipRefreshTimer = null;
            if (!document.getElementById('privateMessagesModal')?.classList.contains('active')) return;
            const activeThreadId = forumV2State.currentPrivateThreadId;
            await loadPrivateThreads();
            if (!activeThreadId) return;
            const stillMember = forumV2State.privateThreads.some(t => String(t.id) === String(activeThreadId));
            if (stillMember) {
                await openPrivateThread(activeThreadId);
                return;
            }
            forumV2State.currentPrivateThreadId = null;
            forumV2State.currentPrivateThreadSummary = null;
            forumV2State.currentPrivateMembers = [];
            const pane = document.getElementById('private-message-pane');
            if (pane) pane.innerHTML = '<div class="private-chat-empty"><div><i class="fa-regular fa-paper-plane fa-2x"></i><h3>Conversation indisponible</h3><p>Vous ne faites plus partie de ce groupe.</p></div></div>';
        }, 120);
    };

    forumV2State.privateChannel = client.channel(`private-messages-${forumState.user.id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'private_messages' }, async payload => {
            if (!document.getElementById('privateMessagesModal')?.classList.contains('active')) return;
            await loadPrivateThreads();
            if (String(payload.new?.thread_id || '') === String(forumV2State.currentPrivateThreadId || '')) {
                await openPrivateThread(forumV2State.currentPrivateThreadId);
            }
        })
        // IMPORTANT : ne surtout pas écouter UPDATE ici.
        // mark_private_thread_read() met à jour last_read_at. Avec event:'*', cette mise à jour
        // rappelait openPrivateThread(), qui remettait last_read_at à jour, créant une boucle infinie.
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'private_thread_members' }, refreshMembership)
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'private_thread_members' }, refreshMembership)
        .subscribe();
}

/* ==========================================================
   NOTIFICATIONS V2
========================================================== */

function notificationDestinationLabel(item) {
    if (item.type === 'site_info') return item.info_section === 'projects' ? 'Voir les informations des projets' : 'Voir les informations des études';
    if (item.private_thread_id || item.type === 'private_message') return 'Ouvrir la conversation privée';
    if (item.post_id) return 'Afficher le message concerné';
    if (item.topic_id) return 'Ouvrir la discussion';
    if (item.type === 'badge') return 'Voir mon profil et mes badges';
    return 'Ouvrir la zone concernée';
}

renderNotifications = function forumV2RenderNotifications(items) {
    const badge = document.getElementById('notification-badge');
    const pop = document.getElementById('notification-popover');
    const unread = items.filter(item => !item.is_read).length;
    if (badge) { badge.textContent = unread > 99 ? '99+' : String(unread); badge.hidden = unread === 0; }
    if (!pop) return;
    const icons = {
        reaction: 'fa-regular fa-heart', mention: 'fa-solid fa-at', subscription: 'fa-regular fa-bell',
        private_message: 'fa-regular fa-paper-plane', badge: 'fa-solid fa-award', reply: 'fa-regular fa-message',
        system: 'fa-solid fa-circle-info', site_info: 'fa-solid fa-bullhorn'
    };
    const rows = items.length ? items.map(item => `
        <button type="button" class="notification-item ${item.is_read ? '' : 'unread'}" data-notification-id="${item.id}" data-notification-type="${v2Attr(item.type || '')}" data-notification-actor="${v2Attr(item.actor_id || '')}" data-notification-topic="${v2Attr(item.topic_id || '')}" data-notification-post="${v2Attr(item.post_id || '')}" data-notification-thread="${v2Attr(item.private_thread_id || '')}" data-notification-info="${v2Attr(item.info_id || '')}" data-notification-info-section="${v2Attr(item.info_section || '')}" aria-label="${v2Attr(notificationDestinationLabel(item))}">
            <span class="notification-item-icon"><i class="${icons[item.type] || 'fa-regular fa-message'}"></i></span>
            <span class="notification-item-copy"><strong>${v2Esc(item.message || 'Nouvelle notification')}</strong><small>${fRelativeDate(item.created_at)} · ${v2Esc(notificationDestinationLabel(item))}</small></span>
            <i class="fa-solid fa-chevron-right notification-item-arrow" aria-hidden="true"></i>
        </button>`).join('') : '<div class="notification-empty">Aucune notification pour le moment.</div>';
    pop.innerHTML = `<div class="notification-head"><strong>Notifications</strong>${unread ? '<button type="button" data-notifications-read-all>Tout marquer comme lu</button>' : ''}</div><div class="notification-list">${rows}</div>`;
};

async function focusForumPostFromNotification(postId) {
    if (!postId) return;
    window.setTimeout(() => {
        const target = document.getElementById(`forum-post-${postId}`);
        if (!target) return;
        target.scrollIntoView({ behavior: motionReduced ? 'auto' : 'smooth', block: 'center' });
        target.classList.add('notification-target-highlight');
        window.setTimeout(() => target.classList.remove('notification-target-highlight'), 2200);
    }, 100);
}

openNotification = async function forumV2OpenNotification(button) {
    const id = Number(button.dataset.notificationId || 0);
    const type = button.dataset.notificationType || '';
    let topicId = button.dataset.notificationTopic || '';
    const postId = button.dataset.notificationPost || '';
    const threadId = button.dataset.notificationThread || '';
    const actorId = button.dataset.notificationActor || '';
    const infoId = button.dataset.notificationInfo || '';
    const infoSection = button.dataset.notificationInfoSection || '';
    const client = v2Client();

    if (id) await client.from('notifications').update({ is_read: true }).eq('id', id);
    closeNotificationPopover();
    loadNotifications().catch(console.warn);

    // Informations du site : ouvre directement la bonne rubrique, avec surbrillance de l'annonce.
    if (type === 'site_info') {
        const section = infoSection === 'projects' ? 'projects' : 'studies';
        if (section === 'projects') {
            navigateToSection('projects');
            switchProjectPageTab('infos');
        } else {
            navigateToSection('courses');
            switchMainCourseTab('global-info-content');
        }

        window.setTimeout(() => {
            const container = section === 'projects' ? '#project-info-container' : '#general-info-container';
            const target = infoId
                ? [...document.querySelectorAll(`${container} .info-block`)].find(el => String(el.dataset.infoId || '') === String(infoId))
                : null;
            target?.scrollIntoView({ behavior: motionReduced ? 'auto' : 'smooth', block: 'center' });
            target?.classList.add('notification-target-highlight');
            window.setTimeout(() => target?.classList.remove('notification-target-highlight'), 2200);
        }, 100);
        return;
    }

    // Messages privés : ouvre la boîte puis sélectionne directement la bonne conversation.
    if (threadId || type === 'private_message') {
        let resolvedThreadId = threadId;
        if (!resolvedThreadId && actorId) {
            const { data } = await client.rpc('get_or_create_private_thread', { p_other_user: actorId });
            resolvedThreadId = data || '';
        }
        if (resolvedThreadId) {
            forumV2State.currentPrivateThreadId = resolvedThreadId;
            forumV2State.currentPrivateOtherUser = null;
            await openPrivateMessages();
            return;
        }
    }

    // Réponse / mention / réaction : on privilégie toujours le message exact.
    if (postId && !topicId) {
        const { data } = await client.from('forum_posts').select('topic_id').eq('id', Number(postId)).maybeSingle();
        topicId = data?.topic_id || '';
    }
    if (topicId) {
        goToForum();
        await openForumTopic(topicId);
        await focusForumPostFromNotification(postId);
        return;
    }

    // Badge : ouvre directement le profil du membre connecté, où les badges sont affichés.
    if (type === 'badge' && forumState.user) {
        await openMemberProfile(forumState.user.id);
        return;
    }

    // Notification système sans cible précise : ramène au forum plutôt que de ne rien faire.
    goToForum();
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
    if (!(await siteConfirm({ title: restore ? 'Restaurer ce sujet ?' : 'Masquer ce sujet ?', message: prompt, confirmLabel: restore ? 'Restaurer' : 'Masquer', danger: !restore, icon: restore ? 'fa-solid fa-clock-rotate-left' : 'fa-regular fa-eye-slash' }))) return;
    const { error } = await v2Client().from('forum_topics').update({ deleted_at: restore ? null : new Date().toISOString() }).eq('id', id);
    if (error) return v2Toast(error.message);
    await loadAdminTopicsV2();
}

async function hardDeleteAdminTopicV2(id) {
    if (!(await siteConfirm({ title: 'Supprimer définitivement ce sujet ?', message: 'Le sujet et tous ses messages seront supprimés.', detail: 'Réactions, signalements, abonnements et historique associés seront également effacés. Cette action est irréversible.', confirmLabel: 'Supprimer définitivement', danger: true }))) return;
    const { error } = await v2Client().rpc('admin_hard_delete_forum_topic', { p_topic_id: id });
    if (error) return v2Toast(error.message);
    await Promise.all([loadAdminTopicsV2(), loadAdminMessagesV2()]);
}

async function softDeleteAdminMessageV2(id) {
    if (!(await siteConfirm({ title: 'Masquer ce message ?', message: 'Le message ne sera plus visible publiquement.', detail: 'Il restera restaurable depuis l’administration.', confirmLabel: 'Masquer', danger: true, icon: 'fa-regular fa-eye-slash' }))) return;
    const { error } = await v2Client().from('forum_posts').update({ deleted_at: new Date().toISOString() }).eq('id', Number(id));
    if (error) return v2Toast(error.message);
    await loadAdminMessagesV2();
}

async function restoreAdminMessageV2(id) {
    if (!(await siteConfirm({ title: 'Restaurer ce message ?', message: 'Le message redeviendra visible dans la discussion.', confirmLabel: 'Restaurer', icon: 'fa-solid fa-clock-rotate-left' }))) return;
    const { error } = await v2Client().rpc('restore_forum_post', { p_post_id: Number(id) });
    if (error) return v2Toast(error.message);
    await loadAdminMessagesV2();
}

async function hardDeleteAdminMessageV2(id) {
    if (!(await siteConfirm({ title: 'Supprimer définitivement ce message ?', message: 'Le message sera effacé de la base.', detail: 'Ses réactions, son historique et ses signalements seront également supprimés. Cette action est irréversible.', confirmLabel: 'Supprimer définitivement', danger: true }))) return;
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

        const onlineAvatarProfile = target.closest('#forum-members-online-avatars [data-member-profile]');
        if (onlineAvatarProfile) return;
        const openDirectory = target.closest('[data-open-member-directory]');
        if (openDirectory) { await openForumMembersDirectoryV2(); return; }
        const directoryProfile = target.closest('[data-member-directory-profile]');
        if (directoryProfile) { closeModalById('forumMembersModal'); await openMemberProfile(directoryProfile.dataset.memberDirectoryProfile); return; }
        const directoryFilter = target.closest('[data-member-directory-filter]');
        if (directoryFilter) {
            forumV2State.memberDirectoryFilter = directoryFilter.dataset.memberDirectoryFilter || 'all';
            document.querySelectorAll('[data-member-directory-filter]').forEach(btn => btn.classList.toggle('active', btn === directoryFilter));
            renderForumMembersDirectoryV2();
            return;
        }

        const mentionLink = target.closest('[data-member-mention]');
        if (mentionLink) { await openMentionedMember(mentionLink.dataset.memberMention); return; }
        if (target.closest('[data-v2-cancel-reply]')) { clearForumV2ReplyContext(); document.getElementById('forum-reply-content')?.focus(); return; }

        const toolbar = target.closest('.forum-editor-toolbar');
        if (target.closest('[data-v2-reference]')) { await openReferencePicker(toolbar?.dataset.editorTarget || '', 'all'); return; }
        if (target.closest('[data-v2-mention]')) { await openReferencePicker(toolbar?.dataset.editorTarget || '', 'mention'); return; }
        if (target.closest('[data-v2-attachment]')) { openExternalAttachmentModal(toolbar?.dataset.editorTarget || ''); return; }

        const replyPost = target.closest('[data-v2-reply-post]');
        if (replyPost) { replyToForumPostV2(replyPost.dataset.v2ReplyPost); return; }

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
            if (forumV2State.referenceMode === 'mention' && kind === 'member') v2InsertAtCursor(textarea, `@${label} `);
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
        if (privateThread) { await openPrivateThread(privateThread.dataset.privateThread); return; }

        const newDirect = target.closest('[data-private-direct-new]');
        if (newDirect) { await openPrivateDirectCreator(); return; }
        const directUser = target.closest('[data-private-direct-user]');
        if (directUser) { await startPrivateDirectConversation(directUser.dataset.privateDirectUser); return; }
        const newGroup = target.closest('[data-private-group-new]');
        if (newGroup) { await openPrivateGroupCreator(); return; }
        const addChoice = target.closest('[data-private-add-choice]');
        if (addChoice) { await handlePrivateAddChoice(addChoice.dataset.privateAddChoice); return; }
        const leaveGroup = target.closest('[data-private-group-leave]');
        if (leaveGroup) { await leavePrivateGroup(); return; }
        const manageGroup = target.closest('[data-private-group-manage]');
        if (manageGroup) { await openPrivateGroupMembers(); return; }
        const addGroupMember = target.closest('[data-private-group-add]');
        if (addGroupMember) { await addPrivateGroupMember(addGroupMember.dataset.privateGroupAdd); return; }
        const transferGroupResponsibility = target.closest('[data-private-group-transfer]');
        if (transferGroupResponsibility) { await transferPrivateGroupResponsibility(transferGroupResponsibility.dataset.privateGroupTransfer); return; }
        const removeGroupMember = target.closest('[data-private-group-remove]');
        if (removeGroupMember) { await removePrivateGroupMember(removeGroupMember.dataset.privateGroupRemove); return; }
        const privateMemberProfile = target.closest('[data-private-member-profile]');
        if (privateMemberProfile?.dataset.privateMemberProfile) { closeModalById('privateGroupMembersModal'); await openMemberProfile(privateMemberProfile.dataset.privateMemberProfile); return; }

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

    document.getElementById('private-messages-btn')?.addEventListener('click', () => openPrivateMessages());
    document.getElementById('forum-members-directory-search')?.addEventListener('input', renderForumMembersDirectoryV2);
    document.querySelector('[data-open-member-directory]')?.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openForumMembersDirectoryV2(); }
    });
    document.getElementById('forum-reference-search')?.addEventListener('input', renderReferencePicker);
    document.getElementById('private-direct-search')?.addEventListener('input', renderPrivateDirectResults);
    document.getElementById('private-group-create-search')?.addEventListener('input', renderPrivateGroupCreateMembers);
    document.getElementById('private-group-add-search')?.addEventListener('input', renderPrivateGroupAddResults);
    document.getElementById('private-group-create-members')?.addEventListener('change', event => {
        const input = event.target.closest?.('[data-private-group-create-member]');
        if (!input) return;
        if (input.checked) forumV2State.groupSelectedMembers.add(input.dataset.privateGroupCreateMember);
        else forumV2State.groupSelectedMembers.delete(input.dataset.privateGroupCreateMember);
        renderPrivateGroupCreateMembers();
    });
    document.getElementById('forum-attachment-form')?.addEventListener('submit', submitExternalAttachment);
    document.getElementById('private-message-form-host')?.addEventListener('submit', sendPrivateMessage);
    document.getElementById('private-group-create-form')?.addEventListener('submit', submitPrivateGroupCreate);
    document.getElementById('private-group-rename-form')?.addEventListener('submit', renamePrivateGroup);
    document.addEventListener('submit', event => {
        if (event.target?.id === 'private-message-form') sendPrivateMessage(event);
    });
    document.addEventListener('keydown', event => {
        const textarea = event.target?.closest?.('#private-message-content');
        if (!textarea || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        textarea.form?.requestSubmit();
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
    ['forumReferenceModal', 'forumAttachmentModal', 'forumHistoryModal', 'forumMembersModal', 'privateMessagesModal', 'privateDirectCreateModal', 'privateGroupCreateModal', 'privateGroupMembersModal', 'privateAddChoiceModal', 'adminV2TopicModal', 'adminV2MessageModal'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', event => {
            const realBackdropClick = typeof window.isRealModalBackdropClick === 'function'
                ? window.isRealModalBackdropClick(event)
                : event.target === event.currentTarget;
            if (realBackdropClick) closeModalById(id);
        });
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        ['forumReferenceModal', 'forumAttachmentModal', 'forumHistoryModal', 'forumMembersModal', 'privateMessagesModal', 'privateDirectCreateModal', 'privateGroupCreateModal', 'privateGroupMembersModal', 'privateAddChoiceModal', 'adminV2TopicModal', 'adminV2MessageModal'].forEach(closeModalById);
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
