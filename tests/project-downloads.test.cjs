const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function declaration(name) {
    const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, 'Production function exists: ' + name);
    return match[0];
}
function constant(name) {
    const match = source.match(new RegExp('^const ' + name + ' = [^]*?^(?:};|\\];)', 'm'));
    assert.ok(match, 'Production constant exists: ' + name);
    return match[0];
}
function element() {
    const classes = new Set();
    return {
        value: '', checked: false, files: [], hidden: false, innerHTML: '', textContent: '',
        dataset: {}, style: {}, focus() {}, setAttribute() {},
        querySelector() { return element(); },
        classList: {
            add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
            contains(name) { return classes.has(name); },
            toggle(name, selected) { if (selected) classes.add(name); else classes.delete(name); }
        }
    };
}
function harness() {
    const fields = new Map();
    const get = id => {
        if (!fields.has(id)) fields.set(id, element());
        return fields.get(id);
    };
    for (const match of html.matchAll(/id="(admin-project-[^"]+)"/g)) get(match[1]);
    get('admin-project-form').reset = () => {
        for (const field of fields.values()) { field.value = ''; field.checked = false; field.files = []; }
    };
    const ctx = {
        URL, console, document: { getElementById: get, querySelectorAll: () => [] },
        adminCache: { projects: [] }, adminAuthenticated: true, adminBusy: false,
        myProjects: [], projectSearchTerm: '', activeProjectCategory: 'all', publicContentLoadError: null,
        window: {}, STORAGE_BUCKETS: { assets: 'assets' },
        normalizeText: value => value.toLowerCase(), showAdminEditor() {}, hideAdminEditor() {},
        setBodyModalState() {},
        setAdminBusy(busy) { ctx.adminBusy = busy; },
        setAdminStatus(message, kind) { ctx.message = message; ctx.messageKind = kind; },
        async saveDbRecord(table, payload, id) {
            if (ctx.saveError) throw ctx.saveError;
            ctx.saved = { table, payload: clone(payload), id };
        },
        async afterAdminMutation() { ctx.afterSave = true; },
        async uploadAdminFile() { ctx.uploaded = true; throw new Error('Unexpected logo upload'); },
        async removeStorageFile() {},
        isAllowedImageFile: () => true
    };
    vm.createContext(ctx);
    const constants = ['PROJECT_DOWNLOAD_PLATFORMS', 'projectStatusLabels', 'projectStatusDescriptions', 'categoryLabels'];
    const functions = [
        'escapeHtmlAttribute', 'safeExternalLink', 'projectDownloads', 'renderProjectDownloads',
        'projectDownloadPayload', 'projectStatus', 'mapProjectRow', 'renderProjects', 'openProjectModal',
        'resetAdminProjectForm', 'editAdminProject', 'handleProjectSave'
    ];
    vm.runInContext(constants.map(constant).concat(functions.map(declaration)).join('\n'), ctx);
    return { ctx, get };
}
function links(markup) {
    return [...markup.matchAll(/class="primary-btn project-download-link"[^]*?<span>([^<]+)<\/span>/g)].map(match => match[1]);
}
const platforms = [
    ['app_url', 'Windows', 'admin-project-app-url'],
    ['android_url', 'Android', 'admin-project-android-url'],
    ['mac_url', 'Mac', 'admin-project-mac-url']
];

for (let mask = 0; mask < 8; mask++) {
    test('only populated platforms appear in cards and details: combination ' + mask, () => {
        const { ctx, get } = harness();
        const row = { id: 1, name: 'Application', category: 'application', tags: [], features: [] };
        const expected = [];
        platforms.forEach(([column, label], index) => {
            row[column] = mask & (1 << index) ? 'https://example.com/' + label.toLowerCase() : '';
            if (row[column]) expected.push(label);
        });
        const project = ctx.mapProjectRow(row);
        ctx.myProjects = [project];
        ctx.renderProjects();
        ctx.openProjectModal(0);
        assert.deepEqual(links(get('projects-container').innerHTML), expected);
        assert.deepEqual(links(get('project-modal-body').innerHTML), expected);
        assert.equal(ctx.projectStatus(project), mask ? 'available' : 'development');
        assert.equal(ctx.renderProjectDownloads(project).includes('Télécharger pour'), Boolean(mask));
    });
}
test('legacy links remain Windows downloads', () => {
    const { ctx } = harness();
    assert.deepEqual(clone(ctx.projectDownloads({ appUrl: ' https://example.com/app.exe ' })).map(link => link.label), ['Windows']);
    assert.equal(ctx.projectDownloads({ windowsUrl: '', appUrl: 'https://example.com/old.exe' }).length, 0);
});
test('blank, malformed and unsafe URLs are not offered', () => {
    const { ctx } = harness();
    for (const url of ['', ' ', null, 'javascript:alert(1)', 'file:///tmp/app', 'https://', 'https://[invalid']) {
        assert.equal(ctx.projectDownloads({ windowsUrl: url, androidUrl: url, macUrl: url }).length, 0);
    }
});
test('download labels and URLs are escaped', () => {
    const { ctx } = harness();
    const markup = ctx.renderProjectDownloads({ name: 'Projet "test" <img>', windowsUrl: 'https://example.com/?q="test"&x=1' });
    assert.ok(!markup.includes('<img>'));
    assert.ok(markup.includes('&quot;'));
    assert.ok(markup.includes('&amp;'));
    assert.ok(markup.includes('rel="noopener noreferrer"'));
});
test('an Android-only project can be edited, saved, reloaded and cleared', async () => {
    const { ctx, get } = harness();
    const row = { id: 12, name: 'Mobile', app_url: null, android_url: 'https://example.com/old.apk', mac_url: null };
    ctx.adminCache.projects = [row];
    ctx.editAdminProject(12);
    assert.equal(get('admin-project-android-url').value, row.android_url);
    assert.equal(get('admin-project-app-url').value, '');
    get('admin-project-android-url').value = ' https://example.com/new.apk ';
    await ctx.handleProjectSave({ preventDefault() {} });
    assert.equal(ctx.saved.payload.android_url, 'https://example.com/new.apk');
    assert.equal(ctx.saved.payload.app_url, null);
    assert.equal(ctx.saved.payload.mac_url, null);
    assert.equal(ctx.saved.id, 12);
    assert.ok(ctx.afterSave);
    assert.equal(get('admin-project-android-url').value, '');
    ctx.adminCache.projects = [{ id: 12, ...ctx.saved.payload }];
    ctx.editAdminProject(12);
    get('admin-project-android-url').value = '';
    await ctx.handleProjectSave({ preventDefault() {} });
    assert.equal(ctx.saved.payload.android_url, null);
    assert.equal(ctx.renderProjectDownloads(ctx.mapProjectRow(ctx.saved.payload)), '');
});
test('new projects save only the supplied systems', async () => {
    const { ctx, get } = harness();
    ctx.resetAdminProjectForm();
    get('admin-project-name').value = 'Desktop';
    get('admin-project-app-url').value = 'https://example.com/setup.exe';
    get('admin-project-mac-url').value = 'https://example.com/app.dmg';
    await ctx.handleProjectSave({ preventDefault() {} });
    assert.equal(ctx.saved.id, null);
    assert.deepEqual(clone(ctx.projectDownloads(ctx.mapProjectRow(ctx.saved.payload))).map(link => link.label), ['Windows', 'Mac']);
});
test('old database rows remain editable before the migration', async () => {
    const { ctx, get } = harness();
    ctx.adminCache.projects = [{ id: 4, name: 'Legacy', app_url: 'https://example.com/app.exe' }];
    ctx.editAdminProject(4);
    await ctx.handleProjectSave({ preventDefault() {} });
    assert.equal(ctx.saved.payload.app_url, 'https://example.com/app.exe');
    assert.ok(!Object.hasOwn(ctx.saved.payload, 'android_url'));
    assert.ok(!Object.hasOwn(ctx.saved.payload, 'mac_url'));
    assert.equal(get('admin-project-mac-url').value, '');
});
test('invalid links are rejected before uploading or saving', async () => {
    const { ctx, get } = harness();
    get('admin-project-android-url').value = 'javascript:alert(1)';
    get('admin-project-logo-file').files = [{}];
    await ctx.handleProjectSave({ preventDefault() {} });
    assert.equal(ctx.saved, undefined);
    assert.equal(ctx.uploaded, undefined);
    assert.match(ctx.message, /Android.*valide/);
    assert.equal(ctx.adminBusy, false);
});
test('a missing migration is reported and leaves entered links available', async () => {
    const { ctx, get } = harness();
    get('admin-project-android-url').value = 'https://example.com/app.apk';
    ctx.saveError = { code: 'PGRST204', message: "Could not find the 'android_url' column of 'projects' in the schema cache" };
    await ctx.handleProjectSave({ preventDefault() {} });
    assert.match(ctx.message, /doivent être activés/);
    assert.equal(ctx.afterSave, undefined);
    assert.equal(get('admin-project-android-url').value, 'https://example.com/app.apk');
    assert.equal(ctx.adminBusy, false);
});
