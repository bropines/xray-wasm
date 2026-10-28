/**
 * xray-wasm: Xray-core's own `xray` command, compiled to WebAssembly from an
 * unmodified release tag, run in the browser (or Node/Bun).
 *
 *   const xray = createXray({ baseUrl: 'https://bropines.github.io/xray-wasm/' });
 *   const result = await xray.check(configJson, { tag: 'v26.10.21' });
 *   const { stdout } = await xray.run(['x25519'], { tag: 'v26.10.21' });
 *
 * check() is `xray run -test -c config.json`: decode, every Build(), then
 * core.New(), never Start(). Each call gets a fresh Go instance; a tag's
 * binary is downloaded and compiled once, when it is first asked for.
 */
import { classify } from './classify.js';
import { refusal } from './commands.js';
import type { ExecRequest, ExecResult } from './exec.js';
import { InlineExecutor, WorkerExecutor, type Executor, type Loaded } from './executor.js';
import { fetchBinary, fetchWasmExec, folderUrl, loadManifest } from './loader.js';
import type { BuildInfo, CallOptions, CheckResult, Manifest, RunOptions, RunResult, Xray, XrayOptions } from './types.js';

export { loadManifest } from './loader.js';
export { refusal } from './commands.js';
export { ASSET_DIR, CERT_DIR, WORK_DIR } from './types.js';
export type {
    BuildInfo, CallOptions, Channel, CheckResult, Manifest, RunOptions, RunResult, Verdict, Xray, XrayOptions,
} from './types.js';

const CHECK_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 60_000;

const bytesOf = (value: string | Uint8Array | undefined) =>
    value === undefined ? undefined : typeof value === 'string' ? new TextEncoder().encode(value) : value;

export function createXray(opts: XrayOptions): Xray {
    const f: typeof fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const base = folderUrl(opts.baseUrl);
    const useWorker = (opts.worker ?? true) && typeof Worker !== 'undefined';
    let executor: Executor = useWorker ? new WorkerExecutor(opts.workerUrl) : new InlineExecutor();

    let manifestPromise: Promise<Manifest> | null = null;
    let wasmExecPromise: Promise<string> | null = null;
    const binaries = new Map<string, Promise<Loaded>>();
    let chain: Promise<unknown> = Promise.resolve();

    const manifest = () => {
        manifestPromise ??= loadManifest(base, f);
        // A failed fetch is retried next time.
        manifestPromise.catch(() => { manifestPromise = null; });
        return manifestPromise;
    };
    const wasmExec = async () => {
        wasmExecPromise ??= manifest().then(m => fetchWasmExec(base, m, f));
        wasmExecPromise.catch(() => { wasmExecPromise = null; });
        return wasmExecPromise;
    };
    const findBuild = async (tag: string): Promise<BuildInfo> => {
        const m = await manifest();
        const build = m.builds.find(entry => entry.tag === tag);
        if (!build) throw new Error(`no build for ${tag} (this manifest has ${m.builds.map(entry => entry.tag).join(', ') || 'none'})`);
        return build;
    };

    const prepare = async (tag: string, onProgress?: (loaded: number, total: number) => void): Promise<void> => {
        let pending = binaries.get(tag);
        if (!pending) {
            pending = (async () => {
                const build = await findBuild(tag);
                const [bytes] = await Promise.all([fetchBinary(base, build, f, onProgress), wasmExec()]);
                return { module: await WebAssembly.compile(bytes as BufferSource) };
            })();
            binaries.set(tag, pending);
            pending.catch(() => { if (binaries.get(tag) === pending) binaries.delete(tag); });
        } else if (onProgress) {
            void pending.then(() => findBuild(tag)).then(build => onProgress(build.gzip, build.gzip), () => {});
        }
        await pending;
    };

    /** Run `task` after every earlier request has settled: one Go instance at a time. */
    const serial = <T>(task: () => Promise<T>): Promise<T> => {
        const next = chain.then(task, task);
        chain = next.catch(() => undefined);
        return next;
    };

    const exec = async (tag: string, request: ExecRequest, timeoutMs: number): Promise<ExecResult | 'timeout'> => {
        const loaded = await binaries.get(tag)!;
        return executor.exec(tag, loaded, await wasmExec(), request, timeoutMs);
    };

    return {
        manifest,
        prepare,

        check(configJson: string, call: CallOptions): Promise<CheckResult> {
            const { tag } = call;
            const unavailable = (error: string): CheckResult => ({ verdict: 'unavailable', ok: false, error, tag, durationMs: 0, log: [] });
            if (typeof WebAssembly === 'undefined') return Promise.resolve(unavailable('this environment has no WebAssembly'));
            return serial(async () => {
                // Download and compile outside the check's timeout: on a slow
                // connection the first download alone can take longer than a check.
                try {
                    await prepare(tag);
                } catch (error) {
                    return unavailable(error instanceof Error ? error.message : String(error));
                }
                const timeoutMs = call.timeoutMs ?? CHECK_TIMEOUT_MS;
                const started = performance.now();
                let result: ExecResult | 'timeout';
                try {
                    result = await exec(tag, { kind: 'check', args: [], configJson, files: call.files ?? {} }, timeoutMs);
                } catch (error) {
                    return unavailable(error instanceof Error ? error.message : String(error));
                }
                if (result === 'timeout') {
                    return { verdict: 'timeout', ok: false, error: `no answer from the core in ${Math.round(timeoutMs / 1000)} s`, tag, durationMs: Math.round(performance.now() - started), log: [] };
                }
                const verdict = classify(result, tag, configJson);
                if (!verdict.coreVersion) verdict.coreVersion = (await findBuild(tag)).version;
                return verdict;
            });
        },

        run(args: string[], call: RunOptions): Promise<RunResult> {
            const { tag } = call;
            const refused = refusal(args);
            if (refused) {
                return Promise.resolve({ exitCode: 1, stdout: '', stderr: `${refused}\n`, files: {}, durationMs: 0, tag });
            }
            return serial(async () => {
                await prepare(tag);
                const timeoutMs = call.timeoutMs ?? RUN_TIMEOUT_MS;
                const started = performance.now();
                const result = await exec(tag, {
                    kind: 'run', args, files: call.files ?? {},
                    ...(call.stdin !== undefined ? { stdin: bytesOf(call.stdin)! } : {}),
                    ...(call.cwd !== undefined ? { cwd: call.cwd } : {}),
                }, timeoutMs);
                if (result === 'timeout') {
                    return { exitCode: -1, stdout: '', stderr: `xray-wasm: no exit in ${Math.round(timeoutMs / 1000)} s; the instance was stopped\n`, files: {}, durationMs: Math.round(performance.now() - started), tag, timedOut: true };
                }
                const decoder = new TextDecoder();
                return {
                    exitCode: result.exitCode ?? -1,
                    stdout: decoder.decode(result.stdout),
                    stderr: decoder.decode(result.stderr),
                    files: result.files,
                    durationMs: Math.round(result.durationMs),
                    tag,
                    stdoutBytes: result.stdout,
                };
            });
        },

        dispose() {
            executor.dispose();
            executor = useWorker ? new WorkerExecutor(opts.workerUrl) : new InlineExecutor();
            binaries.clear();
        },
    };
}
