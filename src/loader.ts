/**
 * Fetching: the manifest, wasm_exec.js and one tag's binary — only the tag
 * that is asked for. Runs on the caller's side, with the caller's fetch, so a
 * custom fetch (auth, a cache, a mirror) works with or without a worker.
 */
import type { BuildInfo, Manifest } from './types.js';

export function folderUrl(baseUrl: string | URL): URL {
    const here = (globalThis as { location?: { href: string } }).location?.href;
    const text = String(baseUrl);
    const url = here ? new URL(text, here) : new URL(text);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
}

export async function loadManifest(baseUrl: string | URL, f: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<Manifest> {
    const url = new URL('manifest.json', folderUrl(baseUrl));
    const response = await f(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const manifest = await response.json() as Manifest;
    if (!manifest || !Array.isArray(manifest.builds) || !manifest.wasmExec?.file) throw new Error(`${url}: not an xray-wasm manifest`);
    return manifest;
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

async function sha256(bytes: Uint8Array): Promise<string | null> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null; // an insecure context has no SubtleCrypto: skip the check
    return hex(await subtle.digest('SHA-256', bytes as BufferSource));
}

async function readAll(response: Response, total: number, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
    if (!response.body || !onProgress) return new Uint8Array(await response.arrayBuffer());
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    onProgress(0, total);
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress(loaded, Math.max(total, loaded));
    }
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
    return out;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
    const inflated = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(inflated).arrayBuffer());
}

/**
 * The uncompressed binary of one build, checked against the manifest's hash.
 * The URL carries the hash so a cache keyed by URL never serves an older
 * binary of the same tag (the file name never changes; the build can).
 */
export async function fetchBinary(base: URL, build: BuildInfo, f: typeof fetch, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
    const canInflate = typeof DecompressionStream !== 'undefined';
    const useRaw = !canInflate || !build.file.endsWith('.gz');
    const file = useRaw ? build.rawFile ?? (build.file.endsWith('.gz') ? null : build.file) : build.file;
    if (!file) throw new Error(`${build.tag}: this environment has no DecompressionStream and the host keeps no uncompressed binary`);
    const url = new URL(file, base);
    url.searchParams.set('v', build.sha256.slice(0, 16));
    const response = await f(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const bytes = await readAll(response, useRaw ? build.size : build.gzip, onProgress);
    // A host that sends Content-Encoding: gzip for .gz hands over inflated
    // bytes already; decide by the gzip magic number, not by the name.
    const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : bytes;
    const digest = await sha256(raw);
    if (digest && digest !== build.sha256) throw new Error(`${url}: sha256 ${digest} does not match the manifest (${build.sha256})`);
    return raw;
}

export async function fetchWasmExec(base: URL, manifest: Manifest, f: typeof fetch): Promise<string> {
    const url = new URL(manifest.wasmExec.file, base);
    url.searchParams.set('v', manifest.wasmExec.sha256.slice(0, 16));
    const response = await f(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const text = await response.text();
    const digest = await sha256(new TextEncoder().encode(text));
    if (digest && digest !== manifest.wasmExec.sha256) throw new Error(`${url}: sha256 does not match the manifest`);
    return text;
}
