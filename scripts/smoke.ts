/**
 * Run the built binaries (dist-wasm/) under Bun, through the same runner and
 * in-memory file system the browser worker uses: configs whose verdict on
 * each tag is known from the tag's source, and CLI commands whose output has
 * a known shape. Synthetic data only (example.com, 127.0.0.1, generated keys).
 *
 *   bun scripts/smoke.ts [--dir dist-wasm] [--tags v26.7.28,v26.10.21] [--geo dir]
 *
 * --geo  a directory with real geoip.dat / geosite.dat for the geo cases,
 *        instead of the two-entry files built below (CN in geosite, PRIVATE in geoip).
 *
 * Exits non-zero if any case disagrees with its expectation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { classify } from '../src/classify';
import { refusal } from '../src/commands';
import { evaluateWasmExec, execute, type ExecResult } from '../src/exec';
import type { Manifest, Verdict } from '../src/types';
import { checkCases, geoFiles } from './smoke-cases';

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = resolve(arg('dir') ?? join(import.meta.dir, '..', 'dist-wasm'));
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
const only = arg('tags')?.split(',');
const geoDir = arg('geo');
if (geoDir) {
    for (const name of ['geoip.dat', 'geosite.dat']) {
        const path = join(geoDir, name);
        if (existsSync(path)) geoFiles[name] = new Uint8Array(readFileSync(path));
    }
}

evaluateWasmExec(readFileSync(join(dir, manifest.wasmExec.file), 'utf8'));

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface CliCase {
    name: string;
    args: string[];
    files?: Record<string, Uint8Array>;
    stdin?: string;
    /** Returns a failure message, or null. */
    expect: (result: ExecResult, tag: string) => string | null;
}

const config = JSON.stringify(checkCases[0]!.config);
const want = (cond: boolean, message: string) => (cond ? null : message);
const exit0 = (result: ExecResult) => (result.exitCode === 0 ? null : `exit ${result.exitCode}: ${result.text.slice(-300)}`);
const out = (result: ExecResult) => text(result.stdout);

const cliCases: CliCase[] = [
    { name: 'version', args: ['version'], expect: (r, tag) => exit0(r) ?? want(out(r).startsWith(`Xray ${tag.slice(1)} `), `stdout: ${out(r).slice(0, 80)}`) },
    { name: '-version (v4 compatible)', args: ['-version'], expect: (r, tag) => exit0(r) ?? want(out(r).startsWith(`Xray ${tag.slice(1)} `), 'no version line') },
    { name: 'help', args: ['help'], expect: r => want(/\brun\b/.test(r.text) && /\buuid\b/.test(r.text), `no command list: ${r.text.slice(0, 200)}`) },
    { name: 'uuid', args: ['uuid'], expect: r => exit0(r) ?? want(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n?$/.test(out(r)), `stdout: ${out(r)}`) },
    // UUIDv5 of "example" in Xray's namespace (common/uuid): stable across tags.
    { name: 'uuid -i', args: ['uuid', '-i', 'example'], expect: r => exit0(r) ?? want(/^[0-9a-f-]{36}\n?$/.test(out(r)), `stdout: ${out(r)}`) },
    { name: 'x25519', args: ['x25519'], expect: r => exit0(r) ?? want(/Private ?[Kk]ey:/.test(out(r)), `stdout: ${out(r)}`) },
    { name: 'x25519 -i (derives from a given key)', args: ['x25519', '-i', 'sEWTw6dNz2IG9vSN8zvIM7Xh8RJmxKJL3Gp2MmpqYmA'], expect: r => exit0(r) ?? want(out(r).includes('sEWTw6dNz2IG9vSN8zvIM7Xh8RJmxKJL3Gp2MmpqYmA'), `stdout: ${out(r)}`) },
    { name: 'wg', args: ['wg'], expect: r => exit0(r) ?? want(/Private ?[Kk]ey:/.test(out(r)), `stdout: ${out(r)}`) },
    { name: 'mldsa65', args: ['mldsa65'], expect: r => exit0(r) ?? want(/Seed:/.test(out(r)), `stdout: ${out(r).slice(0, 200)}`) },
    { name: 'mlkem768', args: ['mlkem768'], expect: r => exit0(r) ?? want(/Seed:/.test(out(r)), `stdout: ${out(r).slice(0, 200)}`) },
    { name: 'vlessenc', args: ['vlessenc'], expect: r => exit0(r) ?? want(/"decryption"/.test(out(r)) && /"encryption"/.test(out(r)), `stdout: ${out(r).slice(0, 200)}`) },
    { name: 'tls cert (JSON on stdout)', args: ['tls', 'cert', '-domain', 'example.com'], expect: r => exit0(r) ?? want(/"certificate"/.test(out(r)) && /BEGIN CERTIFICATE/.test(out(r)), `stdout: ${out(r).slice(0, 200)}`) },
    {
        name: 'tls cert -file (writes two files)',
        args: ['tls', 'cert', '-domain', 'example.com', '-file', 'server'],
        expect: r => exit0(r) ?? want(
            text(r.files['/work/server.crt'] ?? new Uint8Array()).includes('BEGIN CERTIFICATE') && (r.files['/work/server.key']?.length ?? 0) > 0,
            `files: ${Object.keys(r.files).join(', ')}`,
        ),
    },
    { name: 'run -test on a file', args: ['run', '-test', '-c', 'config.json'], files: { 'config.json': new TextEncoder().encode(config) }, expect: r => exit0(r) ?? want(/Configuration OK\./.test(out(r)), 'no "Configuration OK."') },
    { name: 'run -test from stdin', args: ['run', '-test', '-c', 'stdin:'], stdin: config, expect: r => exit0(r) ?? want(/Configuration OK\./.test(out(r)), 'no "Configuration OK."') },
    { name: 'run -dump', args: ['run', '-dump', '-c', 'config.json'], files: { 'config.json': new TextEncoder().encode(config) }, expect: r => exit0(r) ?? want(/"outbounds"/.test(out(r)), `stdout: ${out(r).slice(0, 200)}`) },
    {
        name: 'convert pb -outpbfile',
        args: ['convert', 'pb', '-outpbfile', 'config.pb', 'config.json'],
        files: { 'config.json': new TextEncoder().encode(config) },
        expect: r => exit0(r) ?? want((r.files['/work/config.pb']?.length ?? 0) > 100, `files: ${Object.keys(r.files).join(', ')} ${r.text.slice(-200)}`),
    },
    { name: 'unknown command', args: ['no-such-command'], expect: r => want(r.exitCode !== 0, 'exit 0') },
];

/** Refused before the binary starts: the message and exit code, without loading anything. */
const refusedCases: string[][] = [['run'], ['run', '-c', 'config.json'], ['api', 'statsquery'], ['tls', 'ping', 'example.com'], ['run', '-test', '-c', 'https://example.com/config.json']];

let failures = 0;
const report = (pass: boolean, line: string) => {
    if (!pass) failures++;
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${line}`);
};

for (const args of refusedCases) report(refusal(args) !== null, `refused: xray ${args.join(' ')}`);
for (const args of [['run', '-test'], ['api'], ['tls', 'ping', '-h'], ['help', 'api']]) report(refusal(args) === null, `allowed: xray ${args.join(' ')}`);

for (const build of manifest.builds) {
    if (only && !only.includes(build.tag)) continue;
    const t0 = performance.now();
    const gz = join(dir, build.file);
    const bytes = build.file.endsWith('.gz') ? gunzipSync(readFileSync(gz)) : readFileSync(gz);
    const module = await WebAssembly.compile(bytes);
    console.log(`\n${build.tag} (core ${build.version}, ${build.channel ?? '?'}), compiled in ${Math.round(performance.now() - t0)} ms`);
    for (const c of checkCases) {
        const json = typeof c.config === 'string' ? c.config : JSON.stringify(c.config);
        const raw = await execute(module, { kind: 'check', args: [], configJson: json, files: c.files ? geoFiles : {} }).done;
        const result = classify(raw, build.tag, json);
        const expected: Verdict = typeof c.expect === 'function' ? c.expect(build.tag) : c.expect;
        const detail = result.error ? ` — ${result.error.split('\n')[0]!.split(' > ').slice(-2).join(' > ').slice(0, 160)}` : '';
        const missing = result.missingFiles ? ` [missing: ${result.missingFiles.join(', ')}]` : '';
        report(result.verdict === expected && (!c.errorIncludes || (result.error ?? '').includes(c.errorIncludes)),
            `check ${c.name}: ${result.verdict} (want ${expected}, ${result.durationMs} ms)${detail}${missing}`);
        if (result.verdict !== expected) console.log(result.log.slice(-12).map(line => `      | ${line}`).join('\n'));
    }
    for (const c of cliCases) {
        const result = await execute(module, {
            kind: 'run', args: c.args, files: c.files ?? {},
            ...(c.stdin !== undefined ? { stdin: new TextEncoder().encode(c.stdin) } : {}),
        }).done;
        const problem = c.expect(result, build.tag);
        report(problem === null, `xray ${c.args.join(' ')}: exit ${result.exitCode} (${Math.round(result.durationMs)} ms)${problem ? ` — ${problem}` : ''}`);
    }
    // A file one command wrote, read by the next: `tls hash` of a certificate `tls cert` made.
    const cert = await execute(module, { kind: 'run', args: ['tls', 'cert', '-domain', 'example.com', '-file', 'server'], files: {} }).done;
    const hash = await execute(module, { kind: 'run', args: ['tls', 'hash', '-cert', 'server.crt'], files: { 'server.crt': cert.files['/work/server.crt'] ?? new Uint8Array() } }).done;
    report(hash.exitCode === 0 && /[0-9a-f]{64}/i.test(out(hash)), `xray tls hash -cert server.crt: exit ${hash.exitCode} — ${out(hash).trim().slice(0, 120)}`);
}
console.log(failures ? `\n${failures} case(s) failed` : '\nall cases passed');
process.exit(failures ? 1 : 0);
