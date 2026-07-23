import { normalizeSongObject } from './core-utils.js';

export const CLOUD_PLAYLIST_TABLE = 'cplayer_playlists';
export const CLOUD_PLAYLIST_ID_PREFIX = 'user_pl_';
export const CLOUD_MAX_PLAYLISTS = 500;
export const CLOUD_MAX_SONGS = 10000;

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
    if (!Number.isFinite(updatedAt) || (row.deleted_at != null && !Number.isFinite(deletedAt))) {
        throw new Error('云端歌单时间无效');
    }
    return {
        id,
        name: cleanString(row.name, 100, true),
        songs: row.songs.map(normalizeCloudSong),
        version,
        updatedAt,
        deletedAt
    };
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
        if (outbox && outbox.operation === 'delete') return { action: 'ack-delete' };
        return local ? { action: 'push', expectedVersion: 0 } : { action: 'none' };
    }

    if (remote.deletedAt) {
        if (outbox && outbox.operation === 'delete') return { action: 'ack-delete' };
        const localVersion = Number(local && local.cloudVersion) || 0;
        const dirty = !!(local && local.cloudDirty) || !!outbox;
        if (local && dirty && remote.version > localVersion) return { action: 'conflict' };
        return local ? { action: 'pull-delete' } : { action: 'none' };
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
        const data = throwIfError(await this.client
            .from(CLOUD_PLAYLIST_TABLE)
            .select('playlist_id,name,songs,version,updated_at,deleted_at')
            .order('updated_at', { ascending: true }));
        if (!Array.isArray(data) || data.length > CLOUD_MAX_PLAYLISTS) {
            throw new Error('云端歌单数量无效');
        }
        return data.map(normalizeRemotePlaylist);
    }

    async upsertPlaylist(record, expectedVersion) {
        const playlist = toCloudPlaylistInput(record);
        const data = throwIfError(await this.client.rpc('sync_cplayer_playlist', {
            p_playlist_id: playlist.id,
            p_name: playlist.name,
            p_songs: playlist.songs,
            p_expected_version: Number(expectedVersion) || 0
        }));
        return normalizeRemotePlaylist(firstRpcRow(data));
    }

    async deletePlaylist(playlistId, expectedVersion) {
        const data = throwIfError(await this.client.rpc('delete_cplayer_playlist', {
            p_playlist_id: cleanString(playlistId, 160, true),
            p_expected_version: Number(expectedVersion) || 0
        }));
        return normalizeRemotePlaylist(firstRpcRow(data));
    }

    async deleteAccount() {
        return throwIfError(await this.client.rpc('delete_cplayer_account'));
    }
}
