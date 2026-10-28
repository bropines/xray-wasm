/**
 * A static server over the repository, for examples/browser.html.
 *
 *   bun scripts/serve.ts [--port 8787]
 *
 * Serves .gz files as plain bytes (no Content-Encoding), the way GitHub Pages
 * does, so the loader's own inflate path is the one exercised.
 */
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const i = process.argv.indexOf('--port');
const port = i >= 0 ? Number(process.argv[i + 1]) : 8787;

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.wasm': 'application/wasm',
    '.gz': 'application/gzip',
};

Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch(request) {
        const path = normalize(join(root, decodeURIComponent(new URL(request.url).pathname)));
        if (!path.startsWith(root) || !existsSync(path) || statSync(path).isDirectory()) return new Response('not found', { status: 404 });
        const type = TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';
        return new Response(Bun.file(path), { headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' } });
    },
});
console.log(`http://127.0.0.1:${port}/examples/browser.html`);
