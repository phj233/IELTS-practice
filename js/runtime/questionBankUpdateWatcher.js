(function initQuestionBankUpdateWatcher(global) {
    'use strict';

    const VERSION_URL = 'assets/generated/question-bank-version.json';
    const CHECK_INTERVAL_MS = 120000;
    let knownVersion = null;
    let reloadPending = false;
    let announcedPendingReload = false;

    function hasActivePractice() {
        const app = global.app;
        const recorder = app && app.components && app.components.practiceRecorder;
        if (recorder && recorder.activeSessions && Number(recorder.activeSessions.size) > 0) {
            return true;
        }
        if (!app || !app.examWindows || typeof app.examWindows.forEach !== 'function') {
            return false;
        }
        let active = false;
        app.examWindows.forEach((info) => {
            if (active || !info) return;
            const status = String(info.status || '').toLowerCase();
            const practiceWindow = info.window;
            if (status !== 'completed' && status !== 'closed' && (!practiceWindow || !practiceWindow.closed)) {
                active = true;
            }
        });
        return active;
    }

    function announce(message) {
        if (typeof global.showMessage === 'function') {
            global.showMessage(message, 'info');
        } else if (global.console && typeof global.console.info === 'function') {
            global.console.info(`[QuestionBankUpdateWatcher] ${message}`);
        }
    }

    function restartPracticeSystem() {
        if (global.__questionBankRestarting) return;
        global.__questionBankRestarting = true;
        announce('题库已更新，正在刷新练习系统。');
        if (global.location && typeof global.location.reload === 'function') {
            global.location.reload();
        }
    }

    async function readVersion() {
        if (typeof global.fetch !== 'function') return null;
        const separator = VERSION_URL.includes('?') ? '&' : '?';
        const response = await global.fetch(`${VERSION_URL}${separator}t=${Date.now()}`, {
            cache: 'no-store',
            credentials: 'same-origin'
        });
        if (!response.ok) {
            throw new Error(`question-bank version request failed (${response.status})`);
        }
        const payload = await response.json();
        return payload && typeof payload.version === 'string' ? payload.version : null;
    }

    async function checkNow() {
        let nextVersion;
        try {
            nextVersion = await readVersion();
        } catch (error) {
            if (global.console && typeof global.console.warn === 'function') {
                global.console.warn('[QuestionBankUpdateWatcher] version check failed:', error);
            }
            return { checked: false, reason: 'request-failed' };
        }
        if (!nextVersion) return { checked: false, reason: 'missing-version' };
        if (!knownVersion) {
            knownVersion = nextVersion;
            return { checked: true, changed: false };
        }
        if (nextVersion !== knownVersion) {
            knownVersion = nextVersion;
            reloadPending = true;
        }
        if (!reloadPending) return { checked: true, changed: false };
        if (hasActivePractice()) {
            if (!announcedPendingReload) {
                announcedPendingReload = true;
                announce('检测到题库更新，当前练习完成后将自动刷新。');
            }
            return { checked: true, changed: true, deferred: true };
        }
        reloadPending = false;
        announcedPendingReload = false;
        restartPracticeSystem();
        return { checked: true, changed: true, restarted: true };
    }

    function start() {
        checkNow();
        global.setInterval(checkNow, CHECK_INTERVAL_MS);
        if (global.document && typeof global.document.addEventListener === 'function') {
            global.document.addEventListener('visibilitychange', () => {
                if (!global.document.hidden) checkNow();
            });
        }
    }

    global.QuestionBankUpdateWatcher = {
        checkNow,
        hasActivePractice,
        start
    };

    if (global.document) {
        if (global.document.readyState === 'loading') {
            global.document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    }
})(typeof window !== 'undefined' ? window : globalThis);
