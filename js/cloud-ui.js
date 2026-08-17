// Cloud account, sync and health UI, extracted from js/app.js.
//
// Mutable cloud state lives in js/cloud-state.js, so this module needs no
// setters: it mutates that shared object directly, exactly as app.js did.
// cloudConflicts travels with this block because nothing outside referenced it.
import { cloudState } from './cloud-state.js';
import {
    diffPlaylistContent,
    isCloudConflictError,
    projectCloudSyncStatus
} from './cloud-sync.js';

// Set once during startup, before any cloud action can run.
let deps = {};
export function configureCloudUi(next) {
    deps = next;
}

export const cloudConflicts = new Map();

export function rememberCloudSyncSuccess(ownerId) {
    if (!ownerId || cloudState.cloudUserId !== ownerId) return;
    const previous = cloudState.cloudLastSuccessfulAt;
    cloudState.cloudLastSuccessfulAt = Date.now();
    deps.writeLocalStorage(cloudState.CLOUD_LAST_SUCCESS_KEY, JSON.stringify({
        ownerId,
        at: cloudState.cloudLastSuccessfulAt
    }));
    if (cloudState.cloudLastSuccessfulAt !== previous) {
        invalidateCloudHealthSnapshot('最近成功同步记录已更新');
    }
}

export function forgetCloudSyncSuccess(ownerId) {
    if (!ownerId) return;
    try {
        const record = JSON.parse(deps.readLocalStorage(cloudState.CLOUD_LAST_SUCCESS_KEY, 'null') || 'null');
        if (record && record.ownerId === ownerId) deps.removeLocalStorage(cloudState.CLOUD_LAST_SUCCESS_KEY);
    } catch (error) {
        deps.removeLocalStorage(cloudState.CLOUD_LAST_SUCCESS_KEY);
    }
    if (cloudState.cloudUserId === ownerId) cloudState.cloudLastSuccessfulAt = 0;
}

const CLOUD_BADGE_TONE_CLASSES = [
    'border-slate-300/20', 'bg-slate-400/20', 'text-slate-200',
    'border-sky-200/30', 'bg-sky-300/15', 'text-sky-100',
    'border-emerald-200/30', 'bg-emerald-300/15', 'text-emerald-100',
    'border-amber-200/30', 'bg-amber-300/15', 'text-amber-100',
    'border-red-200/30', 'bg-red-300/15', 'text-red-100'
];
const CLOUD_BADGE_TONES = Object.freeze({
    disabled: ['border-slate-300/20', 'bg-slate-400/20', 'text-slate-200'],
    'signed-out': ['border-slate-300/20', 'bg-slate-400/20', 'text-slate-200'],
    syncing: ['border-sky-200/30', 'bg-sky-300/15', 'text-sky-100'],
    synced: ['border-emerald-200/30', 'bg-emerald-300/15', 'text-emerald-100'],
    pending: ['border-amber-200/30', 'bg-amber-300/15', 'text-amber-100'],
    conflict: ['border-amber-200/30', 'bg-amber-300/15', 'text-amber-100'],
    error: ['border-red-200/30', 'bg-red-300/15', 'text-red-100']
});
const CLOUD_DOT_TONE_CLASSES = [
    'bg-slate-400', 'bg-sky-400', 'bg-emerald-400', 'bg-amber-400', 'bg-red-400'
];
const CLOUD_DOT_TONES = Object.freeze({
    disabled: 'bg-slate-400',
    'signed-out': 'bg-slate-400',
    syncing: 'bg-sky-400',
    synced: 'bg-emerald-400',
    pending: 'bg-amber-400',
    conflict: 'bg-amber-400',
    error: 'bg-red-400'
});

function applyCloudStatusProjection(projection) {
    document.documentElement.dataset.cplayerCloudPending = String(projection.pendingCount);
    document.documentElement.dataset.cplayerCloudConflicts = String(projection.conflictCount);
    document.documentElement.dataset.cplayerCloudLastSuccess = cloudState.cloudLastSuccessfulAt
        ? String(cloudState.cloudLastSuccessfulAt)
        : '';

    ['settingsBtn', 'mobileSettingsBtn'].forEach(function (id) {
        const button = document.getElementById(id);
        if (!button) return;
        button.title = projection.entryLabel;
        button.setAttribute('aria-label', projection.entryLabel);
    });
    document.querySelectorAll('[data-cloud-status-indicator]').forEach(function (dot) {
        dot.classList.remove(...CLOUD_DOT_TONE_CLASSES);
        dot.classList.add(CLOUD_DOT_TONES[projection.visualState] || CLOUD_DOT_TONES.disabled);
        dot.dataset.cloudState = projection.visualState;
    });

    const badge = document.getElementById('cloudStatusBadge');
    if (badge) {
        badge.textContent = projection.label;
        badge.classList.remove(...CLOUD_BADGE_TONE_CLASSES);
        const tone = CLOUD_BADGE_TONES[projection.visualState] || CLOUD_BADGE_TONES.disabled;
        badge.classList.add(...tone);
        badge.dataset.cloudState = projection.visualState;
    }
    const pending = document.getElementById('cloudPendingCount');
    const conflicts = document.getElementById('cloudConflictCount');
    const lastSuccess = document.getElementById('cloudLastSuccessfulAt');
    if (pending) pending.textContent = String(projection.pendingCount);
    if (conflicts) conflicts.textContent = String(projection.conflictCount);
    if (lastSuccess) lastSuccess.textContent = projection.lastSuccessfulText;

    const lastError = document.getElementById('cloudLastError');
    setCloudSectionVisible(lastError, !!cloudState.cloudLastErrorMessage);
    if (lastError) lastError.textContent = cloudState.cloudLastErrorMessage
        ? '最近错误：' + cloudState.cloudLastErrorMessage
        : '';
    const syncLabel = document.getElementById('cloudAccountSyncBtnLabel');
    if (syncLabel) syncLabel.textContent = projection.retrySuggested ? '重试同步' : '立即同步';
}

export function setCloudState(nextState, message, error) {
    const stateChanged = cloudState.cloudState !== nextState ||
        (message && cloudState.cloudStateMessage !== message);
    cloudState.cloudState = nextState;
    if (message) cloudState.cloudStateMessage = message;
    if (nextState === 'error') {
        cloudState.cloudLastErrorMessage = message || '云同步操作失败';
        deps.rememberCloudSyncError(cloudState.cloudUserId, cloudState.cloudLastErrorMessage);
    } else if (nextState === 'synced') {
        if (cloudState.cloudUserId) deps.forgetCloudSyncError(cloudState.cloudUserId);
        else cloudState.cloudLastErrorMessage = '';
    } else if (nextState === 'signed-out' || nextState === 'disabled') {
        cloudState.cloudLastErrorMessage = '';
    }
    document.documentElement.dataset.cplayerCloudState = nextState;
    if (error) console.warn('[cloud]', message || nextState, error);
    if (stateChanged) invalidateCloudHealthSnapshot('云同步状态已变化');
    refreshCloudAccountUI();
}

export function cloudErrorMessage(error, fallback) {
    const text = [
        error && error.message,
        error && error.details,
        error && error.hint,
        error && error.code
    ].filter(Boolean).join(' ');
    if (isCloudConflictError(error)) return '云端歌单刚刚被其他设备修改，请选择保留哪一份';
    if (error && error.name === 'CloudOwnerCollisionError') {
        return '本机已有其他账号的同 ID 歌单，未覆盖本地数据；请退出其他账号或删除冲突歌单后重试';
    }
    if (/invalid login credentials|invalid password|invalid email/i.test(text)) return '邮箱或密码不正确';
    if (/user already registered|already been registered/i.test(text)) return '这个邮箱已经注册，请直接登录';
    if (/email not confirmed|confirm your email/i.test(text)) return '请先完成邮箱验证，再登录';
    if (/playlist_limit_reached|歌单数量达到上限/i.test(text)) return '云端歌单已达到 500 个上限，请先删除不需要的歌单';
    if (/rate limit|too many requests/i.test(text)) return '操作太频繁，请稍后再试';
    if (/storage|localstorage|持久|存储/i.test(text)) return '浏览器存储不可用，登录状态无法可靠保存';
    if (/fetch|network|timeout|offline|failed to/i.test(text)) return '云同步暂时无法连接，已保留本机数据';
    return fallback || '云同步操作失败，本机数据未受影响';
}

function setCloudSectionVisible(element, visible) {
    if (!element) return;
    element.classList.toggle('hidden', !visible);
    element.inert = !visible;
}

function renderCloudPendingUI() {
    const section = document.getElementById('cloudPendingQueue');
    const list = document.getElementById('cloudPendingList');
    const retryAll = document.getElementById('cloudRetryAllBtn');
    if (!section || !list || !retryAll) return;

    const configured = Boolean(deps.getConfiguredCloud());
    const signedIn = Boolean(configured && cloudState.cloudService && cloudState.cloudSession && cloudState.cloudUserId);
    const hasPending = cloudState.cloudPendingCount > 0;
    setCloudSectionVisible(section, hasPending);
    list.innerHTML = '';
    retryAll.disabled = cloudState.cloudAccountBusy || !signedIn || navigator.onLine === false || !cloudState.cloudPendingItems.length;
    retryAll.title = signedIn
        ? (navigator.onLine === false ? '联网后才能重试全部待同步项目' : '重试全部待同步项目')
        : '登录对应账号后才能重试';

    if (!hasPending) return;
    if (!signedIn) {
        const message = document.createElement('div');
        message.className = 'rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-[11px] opacity-70';
        message.textContent = '登录对应账号后查看具体待同步歌单并继续同步。';
        list.appendChild(message);
        return;
    }
    if (!cloudState.cloudPendingItems.length) {
        const loading = document.createElement('div');
        loading.className = 'rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-[11px] opacity-70';
        loading.textContent = '正在读取待同步项目…';
        list.appendChild(loading);
        return;
    }

    cloudState.cloudPendingItems.forEach(function (item) {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 rounded-xl border border-white/10 bg-black/10 px-3 py-2';
        row.dataset.cloudOutboxId = item.id;

        const info = document.createElement('div');
        info.className = 'min-w-0 flex-1';
        const name = document.createElement('div');
        name.className = 'truncate text-xs font-semibold';
        name.textContent = item.name;
        const detail = document.createElement('div');
        detail.className = 'mt-1 text-[11px] opacity-60';
        const songText = item.songCount == null ? '' : ' · ' + item.songCount + ' 首';
        detail.textContent = deps.cloudPendingOperationLabel(item.operation) + songText +
            ' · ' + deps.formatCloudPendingUpdatedAt(item.updatedAt);
        info.appendChild(name);
        info.appendChild(detail);

        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'min-h-[40px] shrink-0 rounded-xl bg-white/10 px-3 text-[11px] font-semibold';
        retry.textContent = '重试';
        retry.setAttribute('aria-label', '重试歌单「' + item.name + '」');
        retry.title = navigator.onLine === false ? '联网后才能重试' : '重试歌单「' + item.name + '」';
        retry.disabled = cloudState.cloudAccountBusy || navigator.onLine === false;
        retry.addEventListener('click', function () { void deps.retryCloudOutboxItem(item.id); });
        row.appendChild(info);
        row.appendChild(retry);
        list.appendChild(row);
    });
}

const CLOUD_DIFF_PREVIEW_LIMIT = 6;

function makeCloudDiffSongText(song) {
    const name = song && song.name ? song.name : '未知歌曲';
    const artist = song && song.artist ? song.artist : '未知艺术家';
    return name + ' · ' + artist;
}

function appendCloudDiffSection(container, title, items, emptyText, renderItem) {
    const section = document.createElement('div');
    section.className = 'rounded-xl border border-white/10 bg-black/10 p-2.5';
    const heading = document.createElement('div');
    heading.className = 'text-[11px] font-semibold opacity-70';
    heading.textContent = title;
    section.appendChild(heading);
    const list = document.createElement('div');
    list.className = 'mt-1 space-y-1';
    const values = Array.isArray(items) ? items : [];
    if (!values.length) {
        const empty = document.createElement('div');
        empty.className = 'text-[11px] opacity-45';
        empty.textContent = emptyText;
        list.appendChild(empty);
    } else {
        values.slice(0, CLOUD_DIFF_PREVIEW_LIMIT).forEach(function (item) {
            const row = document.createElement('div');
            row.className = 'min-w-0 text-[11px] leading-5';
            row.textContent = renderItem(item);
            list.appendChild(row);
        });
        if (values.length > CLOUD_DIFF_PREVIEW_LIMIT) {
            const more = document.createElement('div');
            more.className = 'text-[11px] opacity-45';
            more.textContent = '还有 ' + (values.length - CLOUD_DIFF_PREVIEW_LIMIT) + ' 项未展开';
            list.appendChild(more);
        }
    }
    section.appendChild(list);
    container.appendChild(section);
}

function renderCloudConflictDiff(conflict) {
    const box = document.getElementById('cloudAccountConflictDiff');
    if (!box) return;
    box.innerHTML = '';
    if (!conflict) return;
    const summary = document.createElement('div');
    summary.className = 'text-[11px] opacity-75';
    try {
        const diff = diffPlaylistContent(conflict.local, conflict.remote);
        const parts = [];
        if (diff.nameChanged) parts.push('名称不同');
        if (diff.localOnly.length) parts.push('本机多 ' + diff.localOnly.length + ' 首');
        if (diff.remoteOnly.length) parts.push('云端多 ' + diff.remoteOnly.length + ' 首');
        if (diff.metadataChanged.length) parts.push(diff.metadataChanged.length + ' 首信息不同');
        if (diff.orderChanged) parts.push('顺序不同');
        summary.textContent = parts.length
            ? '差异：' + parts.join(' · ')
            : '两边歌单内容相同，请确认要保留哪一份';
        box.appendChild(summary);

        const counts = document.createElement('div');
        counts.className = 'mt-2 grid grid-cols-2 gap-2 text-[11px]';
        const localCount = document.createElement('div');
        localCount.className = 'rounded-lg bg-white/5 px-2.5 py-2';
        localCount.textContent = '本机：' + (diff.localName || '未命名歌单') + ' · ' + diff.localSongCount + ' 首';
        const remoteCount = document.createElement('div');
        remoteCount.className = 'rounded-lg bg-white/5 px-2.5 py-2';
        remoteCount.textContent = '云端：' + (diff.remoteName || '未命名歌单') + ' · ' + diff.remoteSongCount + ' 首';
        counts.appendChild(localCount);
        counts.appendChild(remoteCount);
        box.appendChild(counts);

        const sections = document.createElement('div');
        sections.className = 'mt-2 grid gap-2';
        appendCloudDiffSection(sections, '仅本机有', diff.localOnly, '没有本机独有歌曲', makeCloudDiffSongText);
        appendCloudDiffSection(sections, '仅云端有', diff.remoteOnly, '没有云端独有歌曲', makeCloudDiffSongText);
        appendCloudDiffSection(sections, '歌曲信息变化', diff.metadataChanged, '没有同歌不同信息', function (item) {
            return '本机：' + makeCloudDiffSongText(item.local) + '；云端：' + makeCloudDiffSongText(item.remote);
        });
        const orderItems = diff.orderChanged ? [
            { label: '本机顺序', songs: diff.localOrder },
            { label: '云端顺序', songs: diff.remoteOrder }
        ] : [];
        appendCloudDiffSection(sections, '共同歌曲顺序', orderItems, '共同歌曲顺序一致', function (item) {
            return item.label + '：' + item.songs.slice(0, CLOUD_DIFF_PREVIEW_LIMIT)
                .map(makeCloudDiffSongText).join(' → ') +
                (item.songs.length > CLOUD_DIFF_PREVIEW_LIMIT ? ' …' : '');
        });
        box.appendChild(sections);
    } catch (error) {
        summary.textContent = '差异预览暂时不可用，但你仍可以选择保留本机或云端版本';
        box.appendChild(summary);
        console.warn('[cloud] conflict diff preview failed', error);
    }
}

function refreshCloudConflictUI() {
    const panel = document.getElementById('cloudAccountConflict');
    const name = document.getElementById('cloudAccountConflictName');
    const position = document.getElementById('cloudAccountConflictPosition');
    const conflict = cloudConflicts.values().next().value || null;
    setCloudSectionVisible(panel, !!conflict);
    if (name) name.textContent = conflict
        ? (conflict.local && conflict.local.name) || (conflict.remote && conflict.remote.name) || '未命名歌单'
        : '';
    if (position) position.textContent = conflict ? '1 / ' + cloudConflicts.size : '0 / 0';
    renderCloudConflictDiff(conflict);
}

export function refreshCloudAccountUI() {
    const config = deps.getConfiguredCloud();
    const hasConfig = !!config;
    const configured = hasConfig && !!cloudState.cloudService;
    const signedIn = configured && !!cloudState.cloudSession && !!cloudState.cloudUserId;
    const projection = projectCloudSyncStatus({
        state: cloudState.cloudState,
        signedIn,
        pendingCount: cloudState.cloudPendingCount,
        conflictCount: cloudConflicts.size,
        lastSuccessfulAt: cloudState.cloudLastSuccessfulAt
    });
    applyCloudStatusProjection(projection);

    const card = document.getElementById('cloudAccountCard');
    if (!card) return;
    const signedOut = document.getElementById('cloudAccountSignedOut');
    const signedInPanel = document.getElementById('cloudAccountSignedIn');
    const recovery = document.getElementById('cloudAccountRecovery');
    const status = document.getElementById('cloudAccountStatus');
    const email = document.getElementById('cloudAccountUserEmail');
    const emailInput = document.getElementById('cloudAccountEmail');
    const allButtons = card.querySelectorAll('button:not(#cloudHealthCheckBtn):not(#cloudHealthCheckExportBtn)');

    setCloudSectionVisible(signedOut, configured && !signedIn && !cloudState.cloudRecoveryMode);
    setCloudSectionVisible(signedInPanel, signedIn && !cloudState.cloudRecoveryMode);
    setCloudSectionVisible(recovery, configured && cloudState.cloudRecoveryMode);
    if (email) email.textContent = cloudState.cloudSession && cloudState.cloudSession.user ? (cloudState.cloudSession.user.email || '') : '';
    if (status) {
        let statusText;
        if (!hasConfig) statusText = '云同步尚未配置，播放器仍可本地使用';
        else if (cloudState.cloudRecoveryMode) statusText = '请设置新的登录密码';
        else statusText = cloudState.cloudStateMessage;
        if (!signedIn && projection.pendingCount > 0) {
            statusText += '；本机有 ' + projection.pendingCount + ' 项待同步，登录对应账号后继续';
        } else if (signedIn && projection.pendingCount > 0 &&
            cloudState.cloudState !== 'conflict' && cloudState.cloudState !== 'error') {
            statusText += '（' + projection.pendingCount + ' 项）';
        }
        status.textContent = statusText;
    }
    if (emailInput && signedIn && cloudState.cloudSession.user && !emailInput.value) {
        emailInput.value = cloudState.cloudSession.user.email || '';
    }
    allButtons.forEach(function (button) {
        button.disabled = cloudState.cloudAccountBusy || !configured;
    });
    const conflict = cloudConflicts.size > 0;
    const localButton = document.getElementById('cloudAccountUseLocalBtn');
    const remoteButton = document.getElementById('cloudAccountUseCloudBtn');
    if (localButton) localButton.disabled = cloudState.cloudAccountBusy || !conflict;
    if (remoteButton) remoteButton.disabled = cloudState.cloudAccountBusy || !conflict;
    refreshCloudConflictUI();
    renderCloudPendingUI();
}


export function isCloudHealthSnapshotFresh() {
    return !!cloudState.cloudHealthSnapshot &&
        cloudState.cloudHealthSnapshot.revision === cloudState.cloudHealthRevision &&
        cloudState.cloudHealthSnapshot.ownerId === (cloudState.cloudUserId || '');
}

export function renderCloudHealthFreshness() {
    const notice = document.getElementById('cloudHealthCheckFreshness');
    const exportButton = document.getElementById('cloudHealthCheckExportBtn');
    const fresh = isCloudHealthSnapshotFresh();
    if (notice) {
        notice.classList.toggle('hidden', !cloudState.cloudHealthSnapshot || fresh);
        notice.textContent = fresh
            ? ''
            : '本机状态已变化，当前报告已过期；请重新检查后再导出报告。';
    }
    if (exportButton) {
        exportButton.classList.toggle('hidden', !cloudState.cloudHealthSnapshot);
        exportButton.disabled = !fresh || cloudState.cloudHealthCheckBusy;
    }
}

export function invalidateCloudHealthSnapshot(reason) {
    cloudState.cloudHealthRevision += 1;
    if (!cloudState.cloudHealthSnapshot) return;
    renderCloudHealthFreshness(reason);
}

export function cloudHealthStatusLabel(status) {
    return status === 'pass' ? '通过' : status === 'warn' ? '需留意' : '受阻';
}

export function cloudHealthStatusClasses(status) {
    if (status === 'pass') return ['border-emerald-200/25', 'bg-emerald-300/10', 'text-emerald-100'];
    if (status === 'warn') return ['border-amber-200/25', 'bg-amber-300/10', 'text-amber-100'];
    return ['border-red-200/25', 'bg-red-300/10', 'text-red-100'];
}

export async function inspectIndexedDbHealth() {
    const requiredStores = ['playlists', 'lyrics', 'images', deps.CLOUD_OUTBOX_STORE, deps.PLAYLIST_HISTORY_STORE];
    try {
        if (!deps.getDb()) await deps.initDatabase();
        if (!deps.getDb()) throw new Error('IndexedDB connection unavailable');
        const stores = Array.from(deps.getDb().objectStoreNames);
        const missingStores = requiredStores.filter(function (name) { return stores.indexOf(name) === -1; });
        const outbox = await deps.readCloudOutbox(cloudState.cloudUserId || '');
        if (missingStores.length) {
            return {
                id: 'indexeddb',
                status: 'fail',
                detail: '本机数据库可读取，但缺少关键数据表：' + missingStores.join('、'),
                recommendation: '请刷新页面；如果仍然出现，请关闭其他播放器页面后重试。',
                dbVersion: Number(deps.getDb().version) || 0,
                stores: stores,
                pendingCount: outbox.length
            };
        }
        const state = deps.getStorageState() === 'ready' ? 'pass' : deps.getStorageState() === 'degraded' ? 'warn' : 'fail';
        return {
            id: 'indexeddb',
            status: state,
            detail: '本机数据库可读取，版本 v' + (Number(deps.getDb().version) || 0) + '，待同步 ' + outbox.length + ' 项。',
            recommendation: state === 'pass' ? '无需处理。' : '请刷新页面；暂时不要清理浏览器站点数据。',
            dbVersion: Number(deps.getDb().version) || 0,
            stores: stores,
            pendingCount: outbox.length
        };
    } catch (error) {
        return {
            id: 'indexeddb',
            status: 'fail',
            detail: '本机数据库暂时无法读取。',
            recommendation: '请刷新页面并关闭其他播放器页面；在处理前不要清理站点数据。',
            dbVersion: 0,
            stores: [],
            pendingCount: 0
        };
    }
}

export async function inspectServiceWorkerHealth() {
    const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
    const cacheSupported = typeof window !== 'undefined' && 'caches' in window;
    if (!supported) {
        return {
            id: 'service-worker',
            status: 'warn',
            detail: '当前浏览器不支持 Service Worker，离线页面缓存不可用。',
            recommendation: '播放器仍可在线使用；如需离线打开，请换用支持 PWA 的浏览器。',
            supported: false,
            controller: false,
            cacheSupported: cacheSupported,
            appCacheCount: 0
        };
    }
    let appCacheCount = 0;
    try {
        if (cacheSupported) {
            const keys = await caches.keys();
            appCacheCount = keys.filter(function (key) { return key.indexOf('cplayer5-') === 0; }).length;
        }
    } catch (error) {
        return {
            id: 'service-worker',
            status: 'warn',
            detail: 'Service Worker 已支持，但无法读取缓存状态。',
            recommendation: '联网后刷新一次页面；不要因此删除本机歌单。',
            supported: true,
            controller: Boolean(navigator.serviceWorker.controller),
            cacheSupported: cacheSupported,
            appCacheCount: 0
        };
    }
    const controller = Boolean(navigator.serviceWorker.controller);
    const status = controller && cacheSupported && appCacheCount > 0 ? 'pass' : 'warn';
    return {
        id: 'service-worker',
        status: status,
        detail: controller
            ? (appCacheCount > 0 ? 'Service Worker 已接管，检测到 ' + appCacheCount + ' 个应用缓存。' : 'Service Worker 已接管，但暂未检测到应用缓存。')
            : 'Service Worker 尚未接管当前页面。',
        recommendation: status === 'pass' ? '无需处理。' : '联网后刷新一次页面，等待应用完成首次缓存。',
        supported: true,
        controller: controller,
        cacheSupported: cacheSupported,
        appCacheCount: appCacheCount
    };
}

export function inspectCloudHealth(pendingCountOverride) {
    const suppliedPendingCount = Number(pendingCountOverride);
    const pendingCount = Number.isSafeInteger(suppliedPendingCount) && suppliedPendingCount >= 0
        ? suppliedPendingCount
        : cloudState.cloudPendingCount;
    const configured = Boolean(deps.getConfiguredCloud());
    const signedIn = Boolean(cloudState.cloudSession && cloudState.cloudUserId);
    const recentError = signedIn
        ? (cloudState.cloudLastErrorMessage || deps.readCloudLastError(cloudState.cloudUserId))
        : '';
    if (!configured) {
        return {
            id: 'cloud',
            status: pendingCount > 0 ? 'warn' : 'pass',
            detail: pendingCount > 0
                ? '云同步未配置；本机仍有 ' + pendingCount + ' 项待同步改动，播放器保持本机优先。'
                : '云同步未配置；播放器保持本机优先且无需登录。',
            recommendation: pendingCount > 0
                ? '如需保留这些改动并跨设备同步，请配置并登录对应账号；在此之前不要清理站点数据。'
                : '如需跨设备歌单，再在设置中配置云同步并登录。',
            configured: false,
            signedIn: false,
            state: 'disabled',
            pendingCount: pendingCount,
            conflictCount: cloudConflicts.size,
            hasRecentSuccess: false,
            lastError: ''
        };
    }
    if (!signedIn) {
        return {
            id: 'cloud',
            status: pendingCount > 0 ? 'warn' : 'pass',
            detail: pendingCount > 0
                ? '尚未登录，本机有 ' + pendingCount + ' 项等待对应账号同步。'
                : '云同步已配置但当前未登录；本机歌单仍可完整使用。',
            recommendation: pendingCount > 0 ? '登录对应账号后再同步，避免把本机改动留在待同步队列。' : '如需跨设备同步，请登录对应账号。',
            configured: true,
            signedIn: false,
            state: cloudState.cloudState,
            pendingCount: pendingCount,
            conflictCount: cloudConflicts.size,
            hasRecentSuccess: false,
            lastError: ''
        };
    }
    const hasConflict = cloudConflicts.size > 0 || cloudState.cloudState === 'conflict';
    const hasError = cloudState.cloudState === 'error' || !!recentError;
    const hasPending = pendingCount > 0 || cloudState.cloudState === 'pending' || cloudState.cloudState === 'syncing';
    const status = hasConflict || hasError || hasPending ? 'warn' : 'pass';
    const recentSuccessDetail = cloudState.cloudLastSuccessfulAt > 0 ? '最近有成功同步记录。' : '尚无成功同步记录。';
    return {
        id: 'cloud',
        status: status,
        detail: hasConflict
            ? '已登录，但有 ' + cloudConflicts.size + ' 个冲突需要选择保留版本。'
            : hasError
                ? '已登录，但最近一次同步报错：' + recentError + '本机数据仍保留。' + recentSuccessDetail
                : hasPending
                    ? '已登录，当前有 ' + pendingCount + ' 项等待同步。' + recentSuccessDetail
                    : '已登录，云同步状态正常。' + recentSuccessDetail,
        recommendation: hasConflict ? '打开冲突差异预览，明确选择本机或云端版本。' : hasError ? '联网后点击“重试同步”；不要手动覆盖歌单。' : hasPending ? '保持联网，或点击“立即同步”。' : '无需处理。',
        configured: true,
        signedIn: true,
        state: cloudState.cloudState,
        pendingCount: pendingCount,
        conflictCount: cloudConflicts.size,
        hasRecentSuccess: cloudState.cloudLastSuccessfulAt > 0,
        lastError: recentError
    };
}
