#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert';
import { test } from 'node:test';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return payload == null ? '' : JSON.stringify(payload);
        }
    };
}

function createLocalApi(initialRecords) {
    const records = clone(initialRecords);
    return {
        async list() {
            return clone(records);
        },
        async replace(nextRecords) {
            records.splice(0, records.length, ...clone(nextRecords));
            return clone(records);
        },
        async mergeRecords(nextRecords) {
            records.push(...clone(nextRecords));
            return { records: clone(records) };
        },
        async restoreRecords(nextRecords) {
            records.splice(0, records.length, ...clone(nextRecords));
            return { records: clone(records) };
        },
        async saveRecord(record) {
            records.unshift(clone(record));
            return clone(record);
        },
        async deleteMany(ids) {
            const idSet = new Set(ids.map(String));
            const deletedRecords = records.filter((record) => idSet.has(String(record.id)));
            const remaining = records.filter((record) => !idSet.has(String(record.id)));
            records.splice(0, records.length, ...remaining);
            return { deletedRecords, deletedCount: deletedRecords.length, records: clone(records) };
        },
        async deleteById(id) {
            const result = await this.deleteMany([id]);
            return { deleted: result.deletedCount > 0, record: result.deletedRecords[0] || null, records: result.records };
        },
        async clear() {
            records.splice(0, records.length);
            return true;
        }
    };
}

function createHarness() {
    const calls = [];
    const remoteRecords = [{ id: 'remote-record', updatedAt: '2026-09-01T00:00:00.000Z' }];
    const api = createLocalApi([{ id: 'local-record', updatedAt: '2026-09-02T00:00:00.000Z' }]);
    const window = {
        location: { protocol: 'http:' },
        PracticeRecordAPI: api,
        setTimeout,
        clearTimeout,
        console: { log() {}, warn() {}, error() {} },
        async fetch(url, options = {}) {
            calls.push({ url, options: clone(options) });
            if (url === '/api/auth/me') return makeResponse(401, { user: null, csrfToken: 'csrf-anonymous' });
            if (url === '/api/auth/csrf') return makeResponse(200, { csrfToken: 'csrf-anonymous' });
            if (url === '/api/auth/login') return makeResponse(200, {
                user: { id: 'user-1', username: 'learner' },
                csrfToken: 'csrf-authenticated'
            });
            if (url === '/api/practice-records/import') {
                const incoming = JSON.parse(options.body).records;
                const byId = new Map(remoteRecords.map((record) => [record.id, clone(record)]));
                incoming.forEach((record) => byId.set(record.id, clone(record)));
                return makeResponse(201, { records: Array.from(byId.values()) });
            }
            if (url === '/api/practice-records/local-record') return makeResponse(200, { removed: 1 });
            return makeResponse(404, { error: 'Not found' });
        }
    };
    window.window = window;
    const context = vm.createContext({
        window,
        globalThis: window,
        setTimeout,
        clearTimeout,
        JSON,
        Promise,
        Error,
        Object,
        Array,
        String,
        encodeURIComponent
    });
    const source = fs.readFileSync(path.join(repoRoot, 'js/core/cloudSync.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'js/core/cloudSync.js' });
    return { api, calls, cloudSync: window.CloudSync };
}

test('CloudSync logs in, merges local records with the server, and preserves local storage', async () => {
    const { api, calls, cloudSync } = createHarness();
    await cloudSync.login('learner', 'StrongPass1');
    const synced = await cloudSync.sync();

    assert.equal(cloudSync.getState().user.username, 'learner');
    assert.deepEqual(synced.records.map((record) => record.id).sort(), ['local-record', 'remote-record']);
    assert.deepEqual((await api.list()).map((record) => record.id).sort(), ['local-record', 'remote-record']);
    const importCall = calls.find((call) => call.url === '/api/practice-records/import');
    assert.equal(importCall.options.headers['X-CSRF-Token'], 'csrf-authenticated');
});

test('CloudSync propagates a local record deletion only after local deletion succeeds', async () => {
    const { api, calls, cloudSync } = createHarness();
    await cloudSync.login('learner', 'StrongPass1');
    await api.deleteById('local-record');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal((await api.list()).some((record) => record.id === 'local-record'), false);
    assert.ok(calls.some((call) => call.url === '/api/practice-records/local-record' && call.options.method === 'DELETE'));
});
