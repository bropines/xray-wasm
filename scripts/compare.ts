/**
 * Evidence for "one binary per release": run every smoke config through both
 * builds of a tag — the wrapper in go/check (DecodeJSONConfig → Build() →
 * core.New(), called from JS) and the tag's own `main` (`xray run -test -c
 * config.json`) — and compare verdicts and error text.
 *
 *   bun scripts/build.ts --variant check --repo <clone> --tags v26.10.21
 *   bun scripts/compare.ts [--cli dist-wasm] [--check dist-wasm-check] [--tags v26.10.21]
 *
 * Exits non-zero when a verdict differs. Error text is printed side by side
 * when it differs (the two phrase a decode failure differently, see README).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { classify } from '../src/classify';
import { evaluateWasmExec, execute, resolveFiles } from '../src/exec';
import { startGo } from '../src/runner';
import { ASSET_DIR, type Manifest } from '../src/types';
import { checkCases, geoFiles } from './smoke-cases';

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const cliDir = resolve(arg('cli') ?? 'dist-wasm');
const checkDir = resolve(arg('check') ?? 'dist-wasm-check');
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
const cli = read(cliDir);
const wrapper = read(checkDir);
evaluateWasmExec(readFileSync(join(cliDir, cli.wasmExec.file), 'utf8'));
const only = arg('tags')?.split(',');

const compile = (dir: string, file: string) => WebAssembly.compile(gunzipSync(readFileSync(join(dir, file))));

type Globals = { xrayCheck?: (json: string) => Promise<{ ok: boolean; error?: string }>; xrayCheckExit?: () => void; __xrayCheckReady?: (v: string) => void };
const g = globalThis as unknown as Globals;

/** The go/check protocol: wait for xrayCheck, call it, let main return. */
async function wrapperCheck(module: WebAssembly.Module, json: string, files: Record<string, Uint8Array>) {
    const ready = new Promise<void>(done => { g.__xrayCheckReady = () => done(); });
    const handle = startGo(module, ['xray-check'], { files: resolveFiles(files, ASSET_DIR) });
    const first = await Promise.race([ready.then(() => 'ready' as const), handle.done.then(() => 'exited' as const)]);
    if (first === 'exited') return { ok: false, crashed: true, error: 'exited during startup', missing: [] as string[] };
    const outcome = await Promise.race([g.xrayCheck!(json), handle.done.then(() => null)]);
    g.xrayCheckExit?.();
    const run = await handle.done;
    delete g.__xrayCheckReady;
    if (!outcome) return { ok: false, crashed: true, error: run.fs.output().slice(-5).join('\n'), missing: run.fs.missing };
    return { ok: outcome.ok, error: outcome.error, missing: run.fs.missing };
}

let differences = 0;
for (const build of cli.builds) {
    if (only && !only.includes(build.tag)) continue;
    const other = wrapper.builds.find(entry => entry.tag === build.tag);
    if (!other || !existsSync(join(checkDir, other.file))) continue;
    const [cliModule, checkModule] = await Promise.all([compile(cliDir, build.file), compile(checkDir, other.file)]);
    console.log(`\n${build.tag}: cli ${(build.size / 2 ** 20).toFixed(1)} MiB, check wrapper ${(other.size / 2 ** 20).toFixed(1)} MiB`);
    for (const c of checkCases) {
        const json = typeof c.config === 'string' ? c.config : JSON.stringify(c.config);
        const files = c.files ? geoFiles : {};
        const viaCli = classify(await execute(cliModule, { kind: 'check', args: [], configJson: json, files }).done, build.tag, json);
        const raw = await wrapperCheck(checkModule, json, files);
        // The wrapper's verdict as it was first classified: any missing file → inconclusive.
        const wrapperVerdict = raw.ok ? 'ok' : raw.crashed ? 'crashed'
            : /not supported on (?:your|this) platform/i.test(raw.error ?? '') ? 'inconclusive'
            : raw.missing.length ? 'inconclusive' : 'error';
        const same = viaCli.verdict === wrapperVerdict;
        const sameText = (viaCli.error ?? '') === (raw.error ?? '');
        if (!same) differences++;
        console.log(`  ${same ? 'same' : 'DIFF'} ${c.name}: cli ${viaCli.verdict}, wrapper ${wrapperVerdict}${sameText ? '' : ' (error text differs)'}`);
        if (!sameText) {
            console.log(`      cli:     ${(viaCli.error ?? '').slice(0, 220)}`);
            console.log(`      wrapper: ${(raw.error ?? '').slice(0, 220)}`);
        }
    }
}
console.log(differences ? `\n${differences} verdict(s) differ` : '\nevery verdict is the same');
process.exit(differences ? 1 : 0);
