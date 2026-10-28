/**
 * One request to a binary — a check or a command line — as both executors
 * (the worker and the in-thread one) run it, and the evaluation of
 * wasm_exec.js. No fetching here: that is loader.ts, on the caller's side.
 */
import { CHECK_ARGS, CHECK_CONFIG_NAME } from './commands.js';
import { normalizePath } from './memfs.js';
import { startGo } from './runner.js';
import { ASSET_DIR, WORK_DIR } from './types.js';

export interface ExecRequest {
    kind: 'check' | 'run';
    /** For `run`: the arguments after `xray`. Ignored for a check. */
    args: string[];
    /** For a check: the config. */
    configJson?: string;
    files: Record<string, Uint8Array>;
    stdin?: Uint8Array;
    cwd?: string;
}

export interface ExecResult {
    /** null: aborted without exiting. */
    exitCode: number | null;
    stdout: Uint8Array;
    stderr: Uint8Array;
    /** stdout and stderr interleaved, as text. */
    text: string;
    /** Files created or changed (`run` only). */
    files: Record<string, Uint8Array>;
    missing: string[];
    durationMs: number;
}

/** Files keyed by absolute path; a relative key goes under `base`. */
export function resolveFiles(files: Record<string, Uint8Array>, base: string): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    for (const [path, data] of Object.entries(files)) out[normalizePath(path.startsWith('/') ? path : `${base}/${path}`)] = data;
    return out;
}

export function execute(module: WebAssembly.Module, request: ExecRequest): { done: Promise<ExecResult>; abort(): void } {
    const check = request.kind === 'check';
    const cwd = normalizePath(check ? WORK_DIR : request.cwd ?? WORK_DIR);
    const files = check
        ? {
            ...resolveFiles(request.files, ASSET_DIR),
            [`${WORK_DIR}/${CHECK_CONFIG_NAME}`]: new TextEncoder().encode(request.configJson ?? ''),
        }
        : resolveFiles(request.files, cwd);
    const argv = ['xray', ...(check ? CHECK_ARGS : request.args)];
    // A check sees a read-only tree, as the verdicts were first measured with;
    // the CLI may write (tls cert -file, convert pb -o) and gets the files back.
    const handle = startGo(module, argv, { files, cwd, writable: !check, stdin: request.stdin });
    return {
        abort: handle.abort,
        done: handle.done.then(run => ({
            exitCode: run.exitCode,
            stdout: run.fs.stdout(),
            stderr: run.fs.stderr(),
            text: run.fs.output().join('\n'),
            files: check ? {} : run.fs.changedFiles(),
            missing: run.fs.missing,
            durationMs: run.durationMs,
        })),
    };
}

const evaluated = new Set<string>();

/**
 * Evaluate wasm_exec.js (a classic script that assigns globalThis.Go) once
 * per distinct text. It also installs `fs`, `process` and `path` stubs on
 * the global object when they are missing; those are removed again, so a page
 * running in-thread does not suddenly look like Node to other code. The
 * runner installs its own `fs`/`process` for the length of each run.
 */
export function evaluateWasmExec(source: string): void {
    if (evaluated.has(source) && (globalThis as { Go?: unknown }).Go) return;
    const scope = globalThis as Record<string, unknown>;
    const absent = ['fs', 'process', 'path'].filter(name => !(name in scope));
    new Function(source)();
    for (const name of absent) delete scope[name];
    evaluated.add(source);
}
