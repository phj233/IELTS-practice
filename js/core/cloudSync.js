(function initCloudSync(global) {
    'use strict';

    const API_ROOT = '/api';
    const SYNC_DEBOUNCE_MS = 350;
    const state = {
        available: null,
        user: null,
        csrfToken: '',
        syncStatus: 'idle',
        error: null
    };
    let installedApi = null;
    let syncPromise = null;
    let syncTimer = null;
    let uiMounted = false;
    let authEpoch = 0;

    class ApiError extends Error {
        constructor(message, status = 0, details = null) {
            super(message);
            this.name = 'CloudSyncApiError';
            this.status = status;
            this.details = details;
        }
    }

    function isHttpPage() {
        const protocol = global.location && global.location.protocol;
        return protocol === 'http:' || protocol === 'https:';
    }

    function getState() {
        return {
            available: state.available,
            user: state.user ? { ...state.user } : null,
            csrfToken: state.csrfToken,
            syncStatus: state.syncStatus,
            error: state.error
        };
    }

    function emitState() {
        if (typeof global.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') {
            return;
        }
        global.dispatchEvent(new global.CustomEvent('ielts-cloud-sync-state', {
            detail: getState()
        }));
    }

    function setState(next = {}) {
        Object.assign(state, next);
        emitState();
        renderUi();
    }

    async function fetchJson(path, options = {}) {
        if (!isHttpPage() || typeof global.fetch !== 'function') {
            throw new ApiError('当前页面未连接到同步服务器', 0);
        }

        const headers = {
            Accept: 'application/json',
            ...(options.headers || {})
        };
        if (options.body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        if (options.csrf !== false && state.csrfToken) {
            headers['X-CSRF-Token'] = state.csrfToken;
        }

        let response;
        try {
            response = await global.fetch(`${API_ROOT}${path}`, {
                method: options.method || 'GET',
                credentials: 'same-origin',
                headers,
                body: options.body === undefined ? undefined : JSON.stringify(options.body)
            });
        } catch (error) {
            throw new ApiError('无法连接同步服务器，请继续使用本地数据', 0, error);
        }

        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (_) {
            data = null;
        }
        if (data && data.csrfToken && options.captureCsrf !== false) {
            state.csrfToken = data.csrfToken;
        }
        if (!response.ok) {
            throw new ApiError(
                (data && data.error) || `同步请求失败（${response.status}）`,
                response.status,
                data
            );
        }
        return data || {};
    }

    function handleApiError(error, { quiet = false } = {}) {
        if (error && error.status === 401) {
            setState({ user: null, syncStatus: 'idle', error: quiet ? null : '登录已失效，请重新登录' });
            return;
        }
        if (error && (error.status === 0 || error.status === 404)) {
            setState({ available: false, syncStatus: 'idle', error: quiet ? null : '同步服务器不可用，正在使用本地数据' });
            return;
        }
        setState({ syncStatus: 'error', error: error && error.message ? error.message : '同步失败' });
    }

    async function refreshSession() {
        const requestEpoch = authEpoch;
        if (!isHttpPage()) {
            setState({ available: false, user: null, syncStatus: 'idle', error: null });
            return getState();
        }
        try {
            const data = await fetchJson('/auth/me', { csrf: false, captureCsrf: false });
            if (requestEpoch !== authEpoch) return getState();
            state.csrfToken = data.csrfToken || state.csrfToken;
            setState({ available: true, user: data.user || null, syncStatus: 'idle', error: null });
            if (data.user && installedApi) {
                queueSync(installedApi, 0);
            }
        } catch (error) {
            if (error.status === 401) {
                try {
                    const csrf = await fetchJson('/auth/csrf', { csrf: false, captureCsrf: false });
                    if (requestEpoch !== authEpoch) return getState();
                    setState({ available: true, user: null, csrfToken: csrf.csrfToken || '', syncStatus: 'idle', error: null });
                } catch (csrfError) {
                    handleApiError(csrfError, { quiet: true });
                }
            } else {
                handleApiError(error, { quiet: true });
            }
        }
        return getState();
    }

    async function authenticate(mode, username, password) {
        const requestEpoch = ++authEpoch;
        if (!username || !password) {
            throw new ApiError('请输入用户名和密码');
        }
        if (!state.csrfToken) {
            const csrf = await fetchJson('/auth/csrf', { csrf: false });
            state.csrfToken = csrf.csrfToken || '';
        }
        const data = await fetchJson(`/auth/${mode}`, {
            method: 'POST',
            body: { username, password }
        });
        if (requestEpoch !== authEpoch) return getState().user;
        setState({ available: true, user: data.user || null, syncStatus: 'idle', error: null });
        if (installedApi && data.user) {
            queueSync(installedApi, 0);
        }
        return data.user || null;
    }

    async function login(username, password) {
        return authenticate('login', username, password);
    }

    async function register(username, password) {
        return authenticate('register', username, password);
    }

    async function logout() {
        if (!state.user) return;
        ++authEpoch;
        try {
            await fetchJson('/auth/logout', { method: 'POST', body: {} });
        } finally {
            setState({ user: null, csrfToken: '', syncStatus: 'idle', error: null });
        }
    }

    async function importLocalRecords(api) {
        if (!state.user || !api || !api.__cloudSyncLocal) {
            return { skipped: true, records: [] };
        }
        if (syncPromise) return syncPromise;

        syncPromise = (async () => {
            setState({ available: true, syncStatus: 'syncing', error: null });
            const localRecords = await api.__cloudSyncLocal.list();
            const data = await fetchJson('/practice-records/import', {
                method: 'POST',
                body: { records: localRecords }
            });
            const mergedRecords = Array.isArray(data.records) ? data.records : [];
            await api.__cloudSyncLocal.replace(mergedRecords, { updateStats: true });
            setState({ available: true, syncStatus: 'synced', error: null });
            return { records: mergedRecords };
        })().catch((error) => {
            handleApiError(error);
            throw error;
        }).finally(() => {
            syncPromise = null;
        });
        return syncPromise;
    }

    function queueSync(api, delay = SYNC_DEBOUNCE_MS) {
        if (!state.user || !api) return;
        if (syncTimer) global.clearTimeout(syncTimer);
        syncTimer = global.setTimeout(() => {
            syncTimer = null;
            importLocalRecords(api).catch(() => {});
        }, delay);
    }

    async function deleteRemoteRecords(records, api) {
        if (!state.user || !Array.isArray(records) || records.length === 0) return;
        try {
            for (const record of records) {
                if (!record || record.id == null) continue;
                await fetchJson(`/practice-records/${encodeURIComponent(String(record.id))}`, {
                    method: 'DELETE'
                });
            }
            queueSync(api, 0);
        } catch (error) {
            handleApiError(error);
        }
    }

    async function clearRemoteRecords() {
        if (!state.user) return;
        try {
            await fetchJson('/practice-records', { method: 'DELETE' });
            setState({ syncStatus: 'synced', error: null });
        } catch (error) {
            handleApiError(error);
        }
    }

    function wrapMutation(api, name, after) {
        const original = api.__cloudSyncLocal[name];
        if (typeof original !== 'function') return;
        api[name] = async function cloudSyncedMutation(...args) {
            const result = await original(...args);
            after(result, args);
            return result;
        };
    }

    function install(api) {
        if (!api || api.__cloudSyncWrapped) return api;
        const local = {};
        [
            'list', 'replace', 'mergeRecords', 'restoreRecords', 'clear',
            'deleteById', 'deleteMany', 'saveRecord'
        ].forEach((name) => {
            if (typeof api[name] === 'function') local[name] = api[name].bind(api);
        });
        if (typeof local.list !== 'function' || typeof local.replace !== 'function') {
            return api;
        }

        Object.defineProperty(api, '__cloudSyncLocal', {
            value: local,
            configurable: false,
            enumerable: false,
            writable: false
        });
        Object.defineProperty(api, '__cloudSyncWrapped', {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false
        });
        api.syncWithServer = () => importLocalRecords(api);
        api.getCloudSyncState = getState;

        wrapMutation(api, 'saveRecord', () => queueSync(api));
        ['replace', 'mergeRecords', 'restoreRecords'].forEach((name) => {
            wrapMutation(api, name, () => queueSync(api));
        });
        wrapMutation(api, 'deleteMany', (result) => deleteRemoteRecords(result && result.deletedRecords, api));
        wrapMutation(api, 'deleteById', (result) => deleteRemoteRecords(result && result.record ? [result.record] : [], api));
        wrapMutation(api, 'clear', () => clearRemoteRecords());

        installedApi = api;
        refreshSession().catch(() => {});
        return api;
    }

    function mountUi() {
        if (uiMounted || !global.document || !global.document.body) return;
        const header = global.document.querySelector('.hero-header') || global.document.body;
        const style = global.document.createElement('style');
        style.textContent = `
            .cloud-sync-control { margin: 10px 0 0; display: flex; justify-content: flex-end; }
            .cloud-sync-button { border: 1px solid rgba(99,102,241,.45); background: rgba(255,255,255,.78); color: #3730a3; border-radius: 999px; padding: 7px 12px; cursor: pointer; font: inherit; }
            .cloud-sync-dialog { position: fixed; z-index: 10050; right: 20px; top: 76px; width: min(360px, calc(100vw - 32px)); padding: 18px; border-radius: 16px; background: #fff; color: #1f2937; box-shadow: 0 18px 48px rgba(15,23,42,.24); border: 1px solid rgba(99,102,241,.2); }
            .cloud-sync-dialog[hidden] { display: none; }
            .cloud-sync-dialog h3 { margin: 0 0 8px; font-size: 1.05rem; }
            .cloud-sync-dialog p { margin: 0 0 12px; font-size: .88rem; line-height: 1.45; color: #4b5563; }
            .cloud-sync-dialog input { box-sizing: border-box; width: 100%; margin: 5px 0; padding: 9px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; }
            .cloud-sync-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
            .cloud-sync-actions button { border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; background: #4f46e5; color: #fff; font: inherit; }
            .cloud-sync-actions button[data-cloud-secondary] { background: #e2e8f0; color: #334155; }
            .cloud-sync-status { min-height: 20px; color: #475569; }
            .cloud-sync-error { color: #b91c1c; }
        `;
        global.document.head.appendChild(style);

        const control = global.document.createElement('div');
        control.className = 'cloud-sync-control';
        control.innerHTML = '<button type="button" class="cloud-sync-button" id="cloud-sync-toggle">☁️ 登录并同步</button>';
        header.appendChild(control);

        const dialog = global.document.createElement('section');
        dialog.id = 'cloud-sync-dialog';
        dialog.className = 'cloud-sync-dialog';
        dialog.hidden = true;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-label', '账户与多设备同步');
        dialog.innerHTML = `
            <h3>☁️ 多设备同步</h3>
            <p id="cloud-sync-status" class="cloud-sync-status"></p>
            <form id="cloud-sync-form">
                <input id="cloud-sync-username" name="username" autocomplete="username" placeholder="用户名" maxlength="80" required>
                <input id="cloud-sync-password" name="password" type="password" autocomplete="current-password" placeholder="密码（至少 8 位，含大小写字母与数字）" required>
                <div class="cloud-sync-actions">
                    <button type="submit" data-cloud-action="login">登录</button>
                    <button type="button" data-cloud-action="register" data-cloud-secondary>注册首个账号</button>
                    <button type="button" data-cloud-action="sync" data-cloud-secondary>立即同步</button>
                    <button type="button" data-cloud-action="logout" data-cloud-secondary>退出登录</button>
                </div>
            </form>
        `;
        global.document.body.appendChild(dialog);

        control.querySelector('button').addEventListener('click', () => {
            dialog.hidden = !dialog.hidden;
            renderUi();
        });
        dialog.querySelector('form').addEventListener('submit', async (event) => {
            event.preventDefault();
            const username = dialog.querySelector('#cloud-sync-username').value.trim();
            const password = dialog.querySelector('#cloud-sync-password').value;
            try {
                await login(username, password);
            } catch (error) {
                handleApiError(error);
            }
        });
        dialog.querySelector('[data-cloud-action="register"]').addEventListener('click', async () => {
            const username = dialog.querySelector('#cloud-sync-username').value.trim();
            const password = dialog.querySelector('#cloud-sync-password').value;
            try {
                await register(username, password);
            } catch (error) {
                handleApiError(error);
            }
        });
        dialog.querySelector('[data-cloud-action="sync"]').addEventListener('click', () => {
            if (installedApi) importLocalRecords(installedApi).catch(() => {});
        });
        dialog.querySelector('[data-cloud-action="logout"]').addEventListener('click', () => logout().catch(handleApiError));
        uiMounted = true;
        renderUi();
    }

    function renderUi() {
        if (!uiMounted || !global.document) return;
        const button = global.document.querySelector('#cloud-sync-toggle');
        const status = global.document.querySelector('#cloud-sync-status');
        const form = global.document.querySelector('#cloud-sync-form');
        if (!button || !status || !form) return;

        const loggedIn = Boolean(state.user);
        button.textContent = loggedIn ? `☁️ ${state.user.username} · ${state.syncStatus === 'syncing' ? '同步中' : '已同步'}` : '☁️ 登录并同步';
        if (state.available === false) {
            status.textContent = '当前是本地模式：请通过 Portainer 部署的应用地址访问，才能使用同步。';
        } else if (loggedIn) {
            status.textContent = `已登录为 ${state.user.username}。本地记录会安全合并到此账号。`;
        } else {
            status.textContent = '登录后可把本机练习记录合并到同一账号；首次使用请注册。';
        }
        status.className = `cloud-sync-status${state.error ? ' cloud-sync-error' : ''}`;
        if (state.error) status.textContent = state.error;
        form.querySelector('#cloud-sync-username').disabled = loggedIn || state.available === false;
        form.querySelector('#cloud-sync-password').disabled = loggedIn || state.available === false;
        form.querySelector('[data-cloud-action="login"]').hidden = loggedIn || state.available === false;
        form.querySelector('[data-cloud-action="register"]').hidden = loggedIn || state.available === false;
        form.querySelector('[data-cloud-action="sync"]').hidden = !loggedIn;
        form.querySelector('[data-cloud-action="logout"]').hidden = !loggedIn;
    }

    global.CloudSync = {
        ApiError,
        getState,
        refreshSession,
        login,
        register,
        logout,
        sync: () => installedApi ? importLocalRecords(installedApi) : Promise.resolve({ skipped: true, records: [] }),
        install
    };

    if (global.PracticeRecordAPI) install(global.PracticeRecordAPI);
    if (global.document) {
        if (global.document.readyState === 'loading') {
            global.document.addEventListener('DOMContentLoaded', mountUi, { once: true });
        } else {
            mountUi();
        }
    }
})(typeof window !== 'undefined' ? window : globalThis);
