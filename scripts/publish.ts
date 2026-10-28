/**
 * Lay out built binaries (dist-wasm/) for publishing. Only the gzip copies
 * are published: about 12 MiB each instead of about 60.
 *
 *   bun scripts/publish.ts --pages <dir>     <dir>/<tag>/xray.wasm.gz, manifest.json, wasm_exec.js, index.html
 *   bun scripts/publish.ts --release <dir>   flat asset names: <tag>.xray.wasm.gz, manifest.json, wasm_exec.js
 *        [--from dist-wasm]
 *
 * Each layout gets its own manifest whose `file` values name what is next to
 * it, so `createXray({ baseUrl })` works against either folder. `rawFile` is
 * dropped: neither layout carries the uncompressed binary.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BuildInfo, Manifest } from '../src/types';

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const from = resolve(arg('from') ?? join(import.meta.dir, '..', 'dist-wasm'));
const pages = arg('pages');
const release = arg('release');
if (!pages && !release) {
    console.error('usage: bun scripts/publish.ts --pages <dir> | --release <dir> [--from dist-wasm]');
    process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8')) as Manifest;
if (!manifest.builds.length) throw new Error(`${from}: no builds`);

/** Release asset names are flat: GitHub has no folders in a release. */
export const releaseAssetName = (tag: string) => `${tag}.xray.wasm.gz`;

function layout(out: string, place: (build: BuildInfo) => string): Manifest {
    mkdirSync(out, { recursive: true });
    const builds = manifest.builds.map(build => {
        const target = place(build);
        const source = join(from, build.file);
        if (!existsSync(source)) throw new Error(`${source} is missing`);
        mkdirSync(dirname(join(out, target)), { recursive: true });
        copyFileSync(source, join(out, target));
        const { rawFile: _raw, ...rest } = build;
        return { ...rest, file: target };
    });
    copyFileSync(join(from, manifest.wasmExec.file), join(out, manifest.wasmExec.file));
    const next: Manifest = { ...manifest, builds };
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(next, null, 2)}\n`);
    return next;
}

const mib = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;

if (pages) {
    const out = resolve(pages);
    const next = layout(out, build => `${build.tag}/xray.wasm.gz`);
    const rows = [...next.builds].reverse().map(build =>
        `<tr><td><code>${build.tag}</code></td><td>${build.channel ?? ''}</td><td>${build.publishedAt?.slice(0, 10) ?? ''}</td><td>${mib(build.gzip)}</td><td><a href="${build.file}">${build.file}</a></td></tr>`).join('\n');
    // A plain index so the folder explains itself to someone who opens it.
    writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>xray-wasm binaries</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:56rem;margin:2rem auto;padding:0 1rem;color:#222;background:#fff}
table{border-collapse:collapse;width:100%}td,th{padding:.3rem .6rem;border-bottom:1px solid #ddd;text-align:left}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}td,th{border-color:#333}a{color:#8ab4f8}}</style></head>
<body><h1>xray-wasm binaries</h1>
<p>Xray-core's own <code>xray</code> command, compiled to WebAssembly from unmodified release tags.
Load them with <a href="https://github.com/bropines/xray-wasm">xray-wasm</a>:
<code>createXray({ baseUrl: '${'https://bropines.github.io/xray-wasm/'}' })</code>. A page downloads only the tag it asks for.</p>
<p><a href="manifest.json">manifest.json</a> · <a href="${next.wasmExec.file}">${next.wasmExec.file}</a> (${next.wasmExec.go})</p>
<table><thead><tr><th>Tag</th><th>Channel</th><th>Published</th><th>Download</th><th>File</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>
`);
    const total = next.builds.reduce((sum, build) => sum + build.gzip, 0);
    console.log(`pages: ${next.builds.length} builds, ${mib(total)} in ${out}`);
}

if (release) {
    const out = resolve(release);
    const next = layout(out, build => releaseAssetName(build.tag));
    console.log(`release: ${next.builds.length} builds in ${out}`);
}
