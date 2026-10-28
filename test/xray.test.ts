/**
 * createXray() end to end, against binaries in dist-wasm/ when they are built
 * (bun scripts/build.ts); skipped otherwise. The fetch reads from disk, so
 * this covers manifest → download → gunzip → sha256 → compile → run.
 * scripts/smoke.ts is the fuller run over every tag.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createXray, loadManifest } from '../src/index';

const dir = join(import.meta.dir, '..', 'dist-wasm');
const manifest = existsSync(join(dir, 'manifest.json')) ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) : null;
const build = manifest?.builds.at(-1);
const built = Boolean(build && existsSync(join(dir, build.file)));

const BASE = 'https://xray-wasm.test/';
const diskFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = join(dir, decodeURIComponent(url.pathname));
    if (!url.href.startsWith(BASE) || !existsSync(path)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(path));
}) as typeof fetch;

const config = JSON.stringify({
    inbounds: [{ listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { udp: true } }],
    outbounds: [{ protocol: 'freedom' }],
});

describe('loadManifest', () => {
    test('rejects what is not a manifest', async () => {
        const f = (async () => new Response('{"x":1}')) as unknown as typeof fetch;
        await expect(loadManifest(BASE, f)).rejects.toThrow('not an xray-wasm manifest');
    });
});

describe.skipIf(!built)(`createXray on ${build?.tag ?? 'a built tag'}`, () => {
    const xray = createXray({ baseUrl: BASE, fetch: diskFetch, worker: false });
    const tag = build?.tag as string;

    test('lists the builds', async () => {
        expect((await xray.manifest()).builds.map(entry => entry.tag)).toContain(tag);
    });

    test('prepare reports progress up to the gzip size', async () => {
        const seen: number[] = [];
        await xray.prepare(tag, loaded => seen.push(loaded));
        expect(seen.at(-1)).toBe(build.gzip);
    }, 60_000);

    test('check: ok, error, unavailable', async () => {
        const ok = await xray.check(config, { tag });
        expect(ok).toMatchObject({ verdict: 'ok', ok: true, tag, coreVersion: build.version });
        const bad = await xray.check('{"outbounds":[{"protocol":"no-such-protocol"}]}', { tag });
        expect(bad.verdict).toBe('error');
        expect(bad.error).toContain('no-such-protocol');
        expect((await xray.check(config, { tag: 'v0.0.0' })).verdict).toBe('unavailable');
    }, 60_000);

    test('check: relative files go under ASSET_DIR', async () => {
        const withGeo = JSON.stringify({ ...JSON.parse(config), routing: { rules: [{ type: 'field', domain: ['geosite:cn'], outboundTag: 'x' }] } });
        const result = await xray.check(withGeo, { tag });
        expect(result.verdict).toBe('inconclusive');
        expect(result.missingFiles).toEqual(['/usr/share/xray/geosite.dat']);
    }, 60_000);

    test('run: stdout, exit code, written files', async () => {
        const uuid = await xray.run(['uuid'], { tag });
        expect(uuid.exitCode).toBe(0);
        expect(uuid.stdout.trim()).toMatch(/^[0-9a-f-]{36}$/);
        const cert = await xray.run(['tls', 'cert', '-domain', 'example.com', '-file', 'out/server'], { tag, cwd: '/work', files: { 'out/.keep': new Uint8Array() } });
        expect(cert.exitCode).toBe(0);
        expect(Object.keys(cert.files).sort()).toEqual(['/work/out/server.crt', '/work/out/server.key']);
        const test_ = await xray.run(['run', '-test', '-c', 'c.json'], { tag, files: { 'c.json': new TextEncoder().encode(config) } });
        expect(test_.stdout).toContain('Configuration OK.');
        const stdin = await xray.run(['run', '-test'], { tag, stdin: config });
        expect(stdin.stdout).toContain('Configuration OK.');
    }, 60_000);

    test('run: refused commands answer at once, without the binary', async () => {
        const refused = await xray.run(['api', 'statsquery'], { tag: 'v0.0.0' });
        expect(refused.exitCode).toBe(1);
        expect(refused.stderr).toContain('gRPC');
    });

    test('run: an unknown tag rejects', async () => {
        await expect(xray.run(['version'], { tag: 'v0.0.0' })).rejects.toThrow('no build for v0.0.0');
    });
});

const workerScript = join(import.meta.dir, '..', 'dist', 'worker.js');
describe.skipIf(!built || !existsSync(workerScript))('createXray in a Worker (dist/)', () => {
    test('check and run through the worker', async () => {
        // A computed specifier: tsc must not need dist/ to typecheck a clean checkout.
        const distIndex = pathToFileURL(join(import.meta.dir, '..', 'dist', 'index.js')).href;
        const { createXray: create } = await import(distIndex) as typeof import('../src/index');
        const xray = create({ baseUrl: BASE, fetch: diskFetch, workerUrl: pathToFileURL(workerScript) });
        try {
            expect((await xray.check(config, { tag: build.tag })).verdict).toBe('ok');
            expect((await xray.run(['version'], { tag: build.tag })).stdout).toStartWith(`Xray ${build.version}`);
        } finally {
            xray.dispose();
        }
    }, 60_000);
});
