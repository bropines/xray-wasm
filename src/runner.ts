/**
 * Run one `xray` command in one fresh Go instance. Shared by the Web Worker,
 * the in-thread executor and the smoke runner (scripts/smoke.ts), which runs
 * the same code under Bun.
 *
 * Fresh, not reused: core.New mutates process-wide state — the config's `env`
 * object calls os.Setenv, geodata keeps matcher caches, and a panic on any
 * goroutine ends the runtime — and the CLI parses its flags into package
 * globals and ends with os.Exit, so one instance runs one command. Compiling
 * is the slow part and the WebAssembly.Module is reused; instantiating and
 * starting Go costs a fraction of a second.
 *
 * Requires `globalThis.Go` (wasm_exec.js of the toolchain that built the
 * binary). One command at a time per global scope: the instance captures
 * `globalThis.fs`, `process` and `path` when it starts, and the runtime's
 * own writes (a panic's stack) go through `globalThis.fs` while it runs.
 */
import { createMemFs, type MemFs, type MemFsOptions } from './memfs.js';
import { ASSET_DIR, CERT_DIR } from './types.js';

interface GoInstance {
    argv: string[];
    env: Record<string, string>;
    exit: (code: number) => void;
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
    /** wasm_exec.js internals: the runtime's pending setTimeout handles. */
    _scheduledTimeouts?: Map<number, ReturnType<typeof setTimeout>>;
}

type GoConstructor = new () => GoInstance;

const g = globalThis as unknown as { Go?: GoConstructor; fs?: unknown; process?: unknown; path?: unknown };

/** What a Linux node has and a program may read (`dns.hosts`, the system resolver). */
export const STOCK_FILES: Record<string, Uint8Array> = {
    '/etc/hosts': new TextEncoder().encode('127.0.0.1 localhost\n::1 localhost\n'),
};

export const DEFAULT_ENV: Record<string, string> = {
    HOME: '/root',
    TMPDIR: '/tmp',
    XRAY_LOCATION_ASSET: ASSET_DIR,
    XRAY_LOCATION_CERT: CERT_DIR,
};

export interface GoRun {
    /** null: still running (only seen after `abort`). */
    exitCode: number | null;
    fs: MemFs;
    durationMs: number;
}

export interface GoRunHandle {
    done: Promise<GoRun>;
    /** Stop waking the instance and give the globals back (for a run that never exits). */
    abort(): void;
}

export function startGo(module: WebAssembly.Module, argv: string[], fsOptions: MemFsOptions, env: Record<string, string> = {}): GoRunHandle {
    const Go = g.Go;
    if (!Go) throw new Error('wasm_exec.js is not loaded (globalThis.Go is missing)');

    const memfs = createMemFs({ dirs: ['/tmp'], ...fsOptions, files: { ...STOCK_FILES, ...fsOptions.files } });
    const previous = { fs: g.fs, process: g.process, path: g.path };
    g.fs = memfs.fs;
    g.process = memfs.process;
    g.path = memfs.path;
    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        g.fs = previous.fs;
        g.process = previous.process;
        g.path = previous.path;
    };

    const go = new Go();
    go.argv = argv;
    go.env = { ...DEFAULT_ENV, ...env };
    const started = performance.now();
    let settle: (run: GoRun) => void = () => {};
    const done = new Promise<GoRun>(resolve => { settle = resolve; });
    const stopTimers = () => {
        // Timers the runtime scheduled (wasm_exec.js keeps them here) would
        // fire into an exited instance and throw "Go program has already
        // exited" — uncaught, which in a worker is an `error` event on the page.
        for (const handle of go._scheduledTimeouts?.values() ?? []) clearTimeout(handle);
        go._scheduledTimeouts?.clear();
    };
    go.exit = code => {
        stopTimers();
        restore();
        settle({ exitCode: code, fs: memfs, durationMs: performance.now() - started });
    };

    WebAssembly.instantiate(module, go.importObject)
        .then(instance => go.run(instance))
        .catch(error => {
            // A trap (unreachable, out of memory) ends the instance without exit().
            stopTimers();
            restore();
            const message = `\n${error instanceof Error ? error.message : String(error)}\n`;
            (memfs.fs.writeSync as (fd: number, buf: Uint8Array) => number)(2, new TextEncoder().encode(message));
            settle({ exitCode: 2, fs: memfs, durationMs: performance.now() - started });
        });

    return {
        done,
        abort() {
            stopTimers();
            restore();
            settle({ exitCode: null, fs: memfs, durationMs: performance.now() - started });
        },
    };
}
