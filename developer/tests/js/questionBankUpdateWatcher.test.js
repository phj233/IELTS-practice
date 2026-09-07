#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');
const source = fs.readFileSync(path.join(root, 'js/runtime/questionBankUpdateWatcher.js'), 'utf8');

function createHarness() {
    const versions = ['before', 'after'];
    let cursor = 0;
    let reloads = 0;
    const activeSessions = new Map([['exam-1', {}]]);
    const window = {
        location: { reload() { reloads += 1; } },
        app: { components: { practiceRecorder: { activeSessions } } },
        console: { info() {}, warn() {} },
        setInterval() { return 1; },
        async fetch() {
            return { ok: true, async json() { return { version: versions[Math.min(cursor++, versions.length - 1)] }; } };
        }
    };
    window.window = window;
    const context = vm.createContext({ window, globalThis: window, Date, Promise, Error, String, Number, console: window.console });
    vm.runInContext(source, context, { filename: 'questionBankUpdateWatcher.js' });
    return { watcher: window.QuestionBankUpdateWatcher, activeSessions, reloads: () => reloads };
}

test('question-bank changes defer restart until no practice session is active', async () => {
    const { watcher, activeSessions, reloads } = createHarness();
    const initial = await watcher.checkNow();
    assert.equal(initial.checked, true);
    assert.equal(initial.changed, false);
    const deferred = await watcher.checkNow();
    assert.equal(deferred.checked, true);
    assert.equal(deferred.changed, true);
    assert.equal(deferred.deferred, true);
    assert.equal(reloads(), 0);
    activeSessions.clear();
    const restarted = await watcher.checkNow();
    assert.equal(restarted.checked, true);
    assert.equal(restarted.changed, true);
    assert.equal(restarted.restarted, true);
    assert.equal(reloads(), 1);
});

test('bundle build generates a version from generated question-bank assets', () => {
    const buildSource = fs.readFileSync(path.join(root, 'scripts/build-bundles.mjs'), 'utf8');
    assert.match(buildSource, /question-bank-version\.json/);
    assert.match(buildSource, /createHash\('sha256'\)/);
});

test('question-bank updater limits Git restores to generated assets and publishes the version last', () => {
    const updaterSource = fs.readFileSync(path.join(root, 'backend/scripts/update-question-bank.sh'), 'utf8');
    assert.match(updaterSource, /git fetch --quiet/);
    assert.match(updaterSource, /git restore --worktree --source=FETCH_HEAD -- \$asset_paths/);
    assert.match(updaterSource, /git restore --worktree --source=FETCH_HEAD -- "\$version_file"/);
    assert.match(updaterSource, /never pulls\n# application code/);
});
