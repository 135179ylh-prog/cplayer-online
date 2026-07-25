import { normalizeSongObject } from './core-utils.js';

export const CLOUD_PLAYLIST_TABLE = 'cplayer_playlists';
export const CLOUD_PLAYLIST_VERSION_TABLE = 'cplayer_playlist_versions';
export const CLOUD_PLAYLIST_ID_PREFIX = 'user_pl_';
export const CLOUD_MAX_PLAYLISTS = 500;
export const CLOUD_MAX_SONGS = 10000;
export const PLAYLIST_HISTORY_LIMIT = 20;
export const PLAYLIST_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PLAYLIST_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const PLAYLIST_VERSION_REASONS = new Set(['edit', 'delete', 'restore', 'remote']);

const CLOUD_STATUS_META = Object.freeze({
    disabled: Object.freeze({ label: '未配置', visualState: 'disabled' }),
    'signed-out': Object.freeze({ label: '未登录', visualState: 'signed-out' }),
    pending: Object.freeze({ label: '待同步', visualState: 'pending' }),
    syncing: Object.freeze({ label: '同步中', visualState: 'syncing' }),
    synced: Object.freeze({ label: '已同步', visualState: 'synced' }),
    conflict: Object.freeze({ label: '有冲突', visualState: 'conflict' }),
    error: Object.freeze({ label: '同步出错', visualState: 'error' })
});

function isPlainRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value, maxLength, required) {
    if (value == null && !required) return '';
    if (typeof value !== 'string') throw new Error('云端歌单字段格式错误');
    const clean = value.trim();
    if (required && !clean) throw new Error('云端歌单字段不能为空');
    if (clean.length > maxLength) throw new Error('云端歌单字段过长');
    return clean;
}

function normalizeStatusCount(value) {
    const count = Number(value);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function formatCloudLastSuccessfulAt(value, now = Date.now()) {
    const timestamp = Number(value);
    const current = Number(now);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(current)) {
        return '尚未成功同步';
    }
    const elapsed = Math.max(0, current - timestamp);
    if (elapsed < 60_000) return '刚刚';
    if (elapsed < 3_600_000) return Math.floor(elapsed / 60_000) + ' 分钟前';
    if (elapsed < 86_400_000) return Math.floor(elapsed / 3_600_000) + ' 小时前';
    return new Date(timestamp).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
}

export function projectCloudSyncStatus(input) {
    const source = isPlainRecord(input) ? input : {};
    const state = Object.hasOwn(CLOUD_STATUS_META, source.state) ? source.state : 'error';
    const pendingCount = normalizeStatusCount(source.pendingCount);
    const conflictCount = normalizeStatusCount(source.conflictCount);
    const signedIn = source.signedIn === true;
    let visualState = CLOUD_STATUS_META[state].visualState;
    let label = CLOUD_STATUS_META[state].label;

    if (state !== 'error' && conflictCount > 0) {
        visualState = 'conflict';
        label = '有冲突';
    } else if (state !== 'error' && state !== 'syncing' && pendingCount > 0) {
        visualState = 'pending';
        if (state === 'signed-out') label = '未登录 · 有待办';
        else if (state === 'disabled') label = '未配置 · 有待办';
        else label = '待同步';
    }

    const lastSuccessfulText = formatCloudLastSuccessfulAt(
        source.lastSuccessfulAt,
        source.now
    );
    return {
        state,
        visualState,
        label,
        pendingCount,
        conflictCount,
        lastSuccessfulText,
        retrySuggested: signedIn && conflictCount === 0 &&
            (state === 'error' || state === 'pending' || pendingCount > 0),
        entryLabel: '打开设置，云同步：' + label + '，' + pendingCount +
            ' 项待同步，' + conflictCount + ' 个冲突'
    };
}

function decodeJwtPayload(value) {
    const parts = String(value || '').split('.');
    if (parts.length !== 3) return null;
    try {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
        return JSON.parse(atob(padded));
    } catch (error) {
        return null;
    }
}

export function isUnsafeCloudKey(value) {
    const key = String(value || '').trim();
    if (!key) return false;
    if (/^(?:sb_secret_|service_role)/i.test(key)) return true;
    const payload = decodeJwtPayload(key);
    return !!(payload && payload.role === 'service_role');
}

export function normalizeCloudConfig(input) {
    const source = isPlainRecord(input) ? input : {};
    const rawUrl = String(source.url || '').trim();
    const publishableKey = String(source.publishableKey || source.anonKey || '').trim();
    if (!rawUrl || !publishableKey) return null;
    if (publishableKey.length < 16 || isUnsafeCloudKey(publishableKey)) return null;

    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (error) {
        return null;
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password ||
        parsed.search || parsed.hash) {
        return null;
    }
    return {
        url: parsed.href.replace(/\/+$/, ''),
        publishableKey
    };
}

export function normalizeCloudSong(song) {
    if (!isPlainRecord(song)) throw new Error('云端歌曲格式错误');
    const normalized = normalizeSongObject(song);
    const idIsNumber = typeof normalized.id === 'number' && Number.isFinite(normalized.id);
    const idIsString = typeof normalized.id === 'string' &&
        !!normalized.id.trim() && normalized.id.trim().length <= 128;
    if (!idIsNumber && !idIsString) throw new Error('云端歌曲缺少有效 id');
    normalized.id = idIsString ? normalized.id.trim() : normalized.id;
    normalized.name = cleanString(normalized.name, 300, true);
    normalized.artist = cleanString(normalized.artist, 300, true);
    normalized.cover = cleanString(normalized.cover, 2048, false);
    normalized.album = cleanString(normalized.album, 300, false);
    normalized.source = cleanString(normalized.source, 100, false) || 'Cloud';
    return normalized;
}

export function normalizeRemotePlaylist(row) {
    if (!isPlainRecord(row)) throw new Error('云端歌单格式错误');
    const id = cleanString(row.playlist_id, 160, true);
    if (!id.startsWith(CLOUD_PLAYLIST_ID_PREFIX)) throw new Error('云端歌单 id 无效');
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('云端歌单版本无效');
    if (!Array.isArray(row.songs) || row.songs.length > CLOUD_MAX_SONGS) {
        throw new Error('云端歌单歌曲数量无效');
    }
    const updatedAt = Date.parse(row.updated_at);
    const deletedAt = row.deleted_at == null ? 0 : Date.parse(row.deleted_at);
    const purgedAt = row.purged_at == null ? 0 : Date.parse(row.purged_at);
    if (!Number.isFinite(updatedAt) ||
        (row.deleted_at != null && !Number.isFinite(deletedAt)) ||
        (row.purged_at != null && !Number.isFinite(purgedAt))) {
        throw new Error('云端歌单时间无效');
    }
    if (purgedAt && !deletedAt) throw new Error('云端永久删除状态无效');
    return {
        id,
        name: cleanString(row.name, 100, true),
        songs: row.songs.map(normalizeCloudSong),
        version,
        updatedAt,
        deletedAt,
        purgedAt
    };
}

export function normalizePlaylistVersion(input) {
    if (!isPlainRecord(input)) throw new Error('歌单历史格式错误');
    const snapshotId = cleanString(input.snapshotId ?? input.snapshot_id ?? input.id, 200, true);
    const id = cleanString(input.id ?? snapshotId, 1024, true);
    const playlistId = cleanString(input.playlistId ?? input.playlist_id, 160, true);
    if (!playlistId.startsWith(CLOUD_PLAYLIST_ID_PREFIX)) throw new Error('歌单历史 id 无效');
    const rawCreatedAt = input.createdAt ?? input.created_at;
    const createdAt = typeof rawCreatedAt === 'number' ? rawCreatedAt : Date.parse(rawCreatedAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) throw new Error('歌单历史时间无效');
    if (!Array.isArray(input.songs) || input.songs.length > CLOUD_MAX_SONGS) {
        throw new Error('歌单历史歌曲数量无效');
    }
    const reason = PLAYLIST_VERSION_REASONS.has(input.reason) ? input.reason : 'edit';
    return {
        id,
        playlistId,
        name: cleanString(input.name, 100, true),
        songs: input.songs.map(normalizeCloudSong),
        createdAt,
        reason,
        snapshotId,
        cloudOwnerId: typeof input.cloudOwnerId === 'string' ? input.cloudOwnerId : ''
    };
}

export function selectRetainedPlaylistVersions(entries, now = Date.now()) {
    const current = Number(now);
    if (!Number.isFinite(current)) throw new Error('历史清理时间无效');
    const cutoff = current - PLAYLIST_HISTORY_RETENTION_MS;
    const seen = new Set();
    return (Array.isArray(entries) ? entries : [])
        .map(normalizePlaylistVersion)
        .filter((entry) => entry.createdAt > cutoff && entry.createdAt <= current + 5 * 60 * 1000)
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .filter((entry) => {
            const snapshotKey = entry.playlistId + '\u0000' + entry.snapshotId;
            if (seen.has(snapshotKey)) return false;
            seen.add(snapshotKey);
            return true;
        })
        .slice(0, PLAYLIST_HISTORY_LIMIT);
}

export function toCloudHistoryInput(entries, playlistId, now = Date.now()) {
    const expectedPlaylistId = cleanString(playlistId, 160, true);
    return selectRetainedPlaylistVersions(entries, now)
        .filter((entry) => entry.playlistId === expectedPlaylistId)
        .map((entry) => ({
            snapshot_id: entry.snapshotId,
            playlist_id: entry.playlistId,
            name: entry.name,
            songs: entry.songs,
            reason: entry.reason,
            created_at: new Date(entry.createdAt).toISOString()
        }));
}

export function isPlaylistTrashExpired(deletedAt, now = Date.now()) {
    const deleted = Number(deletedAt);
    const current = Number(now);
    return Number.isFinite(deleted) && deleted > 0 && Number.isFinite(current) &&
        current >= deleted + PLAYLIST_TRASH_RETENTION_MS;
}

export function getPlaylistTrashRemainingDays(deletedAt, now = Date.now()) {
    const deleted = Number(deletedAt);
    const current = Number(now);
    if (!Number.isFinite(deleted) || deleted <= 0 || !Number.isFinite(current)) return 0;
    return Math.max(0, Math.ceil((deleted + PLAYLIST_TRASH_RETENTION_MS - current) / 86_400_000));
}

export function haveSamePlaylistContent(left, right) {
    try {
        const a = toCloudPlaylistInput(left);
        const b = toCloudPlaylistInput(right);
        return a.name === b.name && JSON.stringify(a.songs) === JSON.stringify(b.songs);
    } catch (error) {
        return false;
    }
}

export function makeRecoveredPlaylistName(name) {
    const suffix = '（已恢复）';
    const base = cleanString(name || '未命名歌单', 100, true);
    if (base.endsWith(suffix)) return base;
    return base.slice(0, 100 - suffix.length).trimEnd() + suffix;
}

export function toCloudPlaylistInput(record) {
    if (!isPlainRecord(record)) throw new Error('本地歌单格式错误');
    const id = cleanString(record.id, 160, true);
    if (!id.startsWith(CLOUD_PLAYLIST_ID_PREFIX)) throw new Error('本地歌单 id 无效');
    if (!Array.isArray(record.songs) || record.songs.length > CLOUD_MAX_SONGS) {
        throw new Error('本地歌单歌曲数量无效');
    }
    return {
        id,
        name: cleanString(record.name || '未命名歌单', 100, true),
        songs: record.songs.map(normalizeCloudSong)
    };
}

export function makeCloudOutboxId(ownerId, playlistId) {
    const owner = cleanString(ownerId, 128, true);
    const id = cleanString(playlistId, 160, true);
    return owner + ':' + id;
}

export function isSameCloudMutation(current, sent) {
    const currentId = current && typeof current.mutationId === 'string'
        ? current.mutationId.trim()
        : '';
    const sentId = sent && typeof sent.mutationId === 'string'
        ? sent.mutationId.trim()
        : '';
    return !!currentId && currentId === sentId;
}

export function decidePlaylistSync(localRecord, remoteRecord, outboxRecord) {
    const local = localRecord || null;
    const remote = remoteRecord || null;
    const outbox = outboxRecord || null;

    if (!remote) {
        if (outbox && outbox.operation === 'delete') return { action: 'delete', expectedVersion: 0 };
        if (outbox && outbox.operation === 'purge') return { action: 'ack-purge' };
        return local ? { action: 'push', expectedVersion: 0 } : { action: 'none' };
    }

    if (remote.purgedAt) {
        if (outbox && outbox.operation === 'purge') return { action: 'ack-purge' };
        const localVersion = Number(local && local.cloudVersion) || 0;
        const dirty = !!(local && local.cloudDirty) || !!outbox;
        if (local && Number(local.purgedAt) > 0 && !dirty && localVersion === remote.version) {
            return { action: 'none' };
        }
        if (local && outbox && (outbox.operation === 'upsert' || outbox.operation === 'restore')) {
            return { action: 'recover-copy' };
        }
        return local ? { action: 'pull-purge' } : { action: 'none' };
    }

    if (remote.deletedAt) {
        if (outbox && outbox.operation === 'delete') return { action: 'ack-delete' };
        if (outbox && outbox.operation === 'purge') {
            const expected = Number(outbox.expectedVersion) || 0;
            return expected === remote.version
                ? { action: 'purge', expectedVersion: remote.version }
                : { action: 'conflict' };
        }
        const localVersion = Number(local && local.cloudVersion) || 0;
        const dirty = !!(local && local.cloudDirty) || !!outbox;
        if (local && outbox && outbox.operation === 'restore' &&
            (Number(outbox.expectedVersion) || 0) === remote.version) {
            return { action: 'push', expectedVersion: remote.version };
        }
        if (local && Number(local.deletedAt) > 0 && !Number(local.purgedAt) &&
            !dirty && localVersion === remote.version) return { action: 'none' };
        if (local && dirty && remote.version > localVersion) return { action: 'conflict' };
        return local || !outbox ? { action: 'pull-delete' } : { action: 'none' };
    }

    if (outbox && outbox.operation === 'purge') {
        const expected = Number(outbox.expectedVersion) || 0;
        return expected === remote.version
            ? { action: 'purge', expectedVersion: remote.version }
            : { action: 'conflict' };
    }

    if (!local) {
        if (outbox && outbox.operation === 'delete') {
            const expected = Number(outbox.expectedVersion) || 0;
            return expected === remote.version
                ? { action: 'delete', expectedVersion: remote.version }
                : { action: 'conflict' };
        }
        return { action: 'pull' };
    }

    const localVersion = Number(local.cloudVersion) || 0;
    const dirty = !!local.cloudDirty || !!outbox;
    if (remote.version === localVersion) {
        if (outbox && outbox.operation === 'delete') {
            return { action: 'delete', expectedVersion: remote.version };
        }
        return dirty
            ? { action: 'push', expectedVersion: remote.version }
            : { action: 'none' };
    }
    if (remote.version > localVersion) {
        if (outbox && outbox.operation === 'restore') {
            return haveSamePlaylistContent(local, remote)
                ? { action: 'ack-restore' }
                : { action: 'recover-copy' };
        }
        return dirty ? { action: 'conflict' } : { action: 'pull' };
    }
    return { action: 'conflict' };
}

export function isCloudConflictError(error) {
    const text = [
        error && error.message,
        error && error.details,
        error && error.hint,
        error && error.code
    ].filter(Boolean).join(' ');
    return /cplayer_playlist_conflict|playlist conflict|version conflict/i.test(text);
}

function throwIfError(result) {
    if (result && result.error) throw result.error;
    return result ? result.data : null;
}

function firstRpcRow(data) {
    if (Array.isArray(data)) return data[0] || null;
    return data || null;
}

export class CPlayerCloudService {
    constructor(options) {
        const settings = options || {};
        this.config = normalizeCloudConfig(settings.config);
        if (!this.config) throw new Error('云同步尚未配置');
        if (!settings.supabase || typeof settings.supabase.createClient !== 'function') {
            throw new Error('云同步组件未加载');
        }
        this.client = settings.supabase.createClient(
            this.config.url,
            this.config.publishableKey,
            {
                auth: {
                    storage: settings.storage,
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true,
                    flowType: 'pkce'
                },
                global: {
                    headers: { 'X-Client-Info': 'cplayer-online' }
                }
            }
        );
    }

    async getSession() {
        const data = throwIfError(await this.client.auth.getSession());
        return data && data.session ? data.session : null;
    }

    onAuthStateChange(callback) {
        const result = this.client.auth.onAuthStateChange(callback);
        return result && result.data ? result.data.subscription : null;
    }

    async signUp(email, password) {
        return throwIfError(await this.client.auth.signUp({ email, password }));
    }

    async signIn(email, password) {
        return throwIfError(await this.client.auth.signInWithPassword({ email, password }));
    }

    async signOut() {
        return throwIfError(await this.client.auth.signOut({ scope: 'local' }));
    }

    async requestPasswordReset(email, redirectTo) {
        return throwIfError(await this.client.auth.resetPasswordForEmail(email, { redirectTo }));
    }

    async updatePassword(password) {
        return throwIfError(await this.client.auth.updateUser({ password }));
    }

    async listPlaylists() {
        const fields = 'playlist_id,name,songs,version,updated_at,deleted_at,purged_at';
        const readRows = async (purged) => {
            const rows = [];
            const pageSize = 500;
            for (let offset = 0; ; offset += pageSize) {
                let query = this.client.from(CLOUD_PLAYLIST_TABLE).select(fields);
                query = purged
                    ? query.not('purged_at', 'is', null)
                    : query.is('purged_at', null);
                const page = throwIfError(await query
                    .order('updated_at', { ascending: true })
                    .order('playlist_id', { ascending: true })
                    .range(offset, offset + pageSize - 1));
                if (!Array.isArray(page)) throw new Error('云端歌单格式错误');
                rows.push(...page);
                if (!purged && rows.length > CLOUD_MAX_PLAYLISTS) {
                    throw new Error('云端歌单数量无效');
                }
                if (purged && rows.length > 5000) throw new Error('云端删除标记数量异常');
                if (page.length < pageSize) break;
            }
            return rows;
        };
        const [visible, purged] = await Promise.all([readRows(false), readRows(true)]);
        return visible.concat(purged).map(normalizeRemotePlaylist);
    }

    async upsertPlaylist(record, expectedVersion, history = []) {
        const playlist = toCloudPlaylistInput(record);
        const data = throwIfError(await this.client.rpc('sync_cplayer_playlist_v2', {
            p_playlist_id: playlist.id,
            p_name: playlist.name,
            p_songs: playlist.songs,
            p_expected_version: Number(expectedVersion) || 0,
            p_history: toCloudHistoryInput(history, playlist.id)
        }));
        return normalizeRemotePlaylist(firstRpcRow(data));
    }

    async deletePlaylist(record, expectedVersion, history = []) {
        const playlist = toCloudPlaylistInput(typeof record === 'string'
            ? { id: record, name: '未命名歌单', songs: [] }
            : record);
        const data = throwIfError(await this.client.rpc('delete_cplayer_playlist_v2', {
            p_playlist_id: playlist.id,
            p_name: playlist.name,
            p_songs: playlist.songs,
            p_expected_version: Number(expectedVersion) || 0,
            p_history: toCloudHistoryInput(history, playlist.id)
        }));
        return normalizeRemotePlaylist(firstRpcRow(data));
    }

    async purgePlaylist(playlistId, expectedVersion) {
        const data = throwIfError(await this.client.rpc('purge_cplayer_playlist', {
            p_playlist_id: cleanString(playlistId, 160, true),
            p_expected_version: Number(expectedVersion) || 0
        }));
        return normalizeRemotePlaylist(firstRpcRow(data));
    }

    async cleanupPlaylistData() {
        return throwIfError(await this.client.rpc('cleanup_cplayer_playlist_data'));
    }

    async listPlaylistVersions(playlistId) {
        const id = cleanString(playlistId, 160, true);
        const data = throwIfError(await this.client
            .from(CLOUD_PLAYLIST_VERSION_TABLE)
            .select('snapshot_id,playlist_id,name,songs,reason,created_at')
            .eq('playlist_id', id)
            .order('created_at', { ascending: false })
            .limit(PLAYLIST_HISTORY_LIMIT));
        if (!Array.isArray(data)) throw new Error('云端历史格式错误');
        return data.map(normalizePlaylistVersion);
    }

    async deleteAccount() {
        return throwIfError(await this.client.rpc('delete_cplayer_account'));
    }
}
