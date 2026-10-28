/**
 * Public types. Plain English, no i18n: the library reports facts, a UI that
 * shows them translates.
 */

/**
 *  - `ok`            the core built every part of the config and constructed
 *                    the instance (`xray run -test` printed "Configuration OK.").
 *  - `error`         the core refused it; `error` is its message.
 *  - `inconclusive`  the core refused it after looking for a file it was not
 *                    given (`missingFiles`: a geo .dat file, a certificate), or
 *                    stopped at a part that only builds on another platform
 *                    (`skipped`). The refusal may be about nothing else, so it
 *                    is not called a config error.
 *  - `crashed`       the Go runtime died (a panic); `error` holds the tail of its output.
 *  - `timeout`       no answer in time; the worker was replaced.
 *  - `unavailable`   no build for that tag, or the environment could not load it.
 */
export type Verdict = 'ok' | 'error' | 'inconclusive' | 'crashed' | 'timeout' | 'unavailable';

/** GitHub's release flag, or `withdrawn` for a release whose tag was deleted upstream. */
export type Channel = 'stable' | 'prerelease' | 'withdrawn';

export interface BuildInfo {
    /** Release tag, e.g. "v26.10.21". */
    tag: string;
    /** What the binary reports (core.Version()), e.g. "26.10.21". */
    version: string;
    /** The gzip binary, relative to the manifest's folder. */
    file: string;
    /** Uncompressed size in bytes. */
    size: number;
    /** Size of `file` in bytes: the download. */
    gzip: number;
    /** sha256 of the uncompressed binary (what is compiled), hex. */
    sha256: string;
    /** The uncompressed binary, when the host keeps one (used only without DecompressionStream). */
    rawFile?: string;
    /** sha256 of `file`, hex. */
    gzipSha256?: string;
    /** Xray-core commit the binary was built from. */
    commit?: string;
    channel?: Channel;
    /** When GitHub published the release (ISO 8601); for a withdrawn one, its commit date. */
    publishedAt?: string;
    /** Go release that built it, e.g. "go1.27.0". */
    go?: string;
    /** Files added to packages the js port lacks names in (see go/shims). */
    shims?: string[];
}

export interface Manifest {
    builds: BuildInfo[];
    /** wasm_exec.js of the Go release that built every binary; another one does not run them. */
    wasmExec: { file: string; sha256: string; go: string };
    format?: number;
    generatedBy?: string;
}

export interface CheckResult {
    verdict: Verdict;
    /** `verdict === 'ok'`. */
    ok: boolean;
    /** The core's own message, without the CLI's "Failed to start: " prefix. */
    error?: string;
    /** Release tag the check ran on. */
    tag: string;
    /** Version the binary reports, e.g. "26.10.21". */
    coreVersion?: string;
    /**
     * Files the core looked for and did not get, as absolute paths (assets
     * under ASSET_DIR, certificates as written). Only when the verdict is not `ok`.
     */
    missingFiles?: string[];
    /** What this check could not cover for this config, as short English sentences. */
    skipped?: string[];
    /** Wall time of the check, not counting download and compile. */
    durationMs: number;
    /** What the core printed while loading (stdout and stderr), by line. */
    log: string[];
}

export interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    /** Files the command created or changed, by absolute path. */
    files: Record<string, Uint8Array>;
    durationMs: number;
    tag: string;
    /** The command did not exit within `timeoutMs`; `exitCode` is -1. */
    timedOut?: boolean;
    /** stdout as bytes, for a command that prints binary (e.g. `convert pb` without -o). */
    stdoutBytes?: Uint8Array;
}

export interface XrayOptions {
    /** Folder holding manifest.json; the manifest's `file` values are relative to it. */
    baseUrl: string | URL;
    fetch?: typeof fetch;
    /** Run in a Web Worker (default true where `Worker` exists). Without one, work runs on the calling thread. */
    worker?: boolean;
    /** Override where the worker script is (default: worker.js next to this module). */
    workerUrl?: string | URL;
}

export interface CallOptions {
    tag: string;
    /**
     * Files the core may read. Absolute paths, or relative ones: under the
     * CLI's cwd (default /work) for `run`, under ASSET_DIR for `check`
     * (geoip.dat, geosite.dat, `ext:` files).
     */
    files?: Record<string, Uint8Array>;
    /** Give up after this long. Default 30 s for `check`, 60 s for `run`. */
    timeoutMs?: number;
}

export interface RunOptions extends CallOptions {
    stdin?: string | Uint8Array;
    /** Working directory, default /work. */
    cwd?: string;
}

export interface Xray {
    manifest(): Promise<Manifest>;
    /** Download and compile a tag ahead of the first call; cached for the instance's life. */
    prepare(tag: string, onProgress?: (loaded: number, total: number) => void): Promise<void>;
    /** `xray run -test` on one config, classified. */
    check(configJson: string, opts: CallOptions): Promise<CheckResult>;
    /** The `xray` command line: `run(['uuid'], { tag })`. */
    run(args: string[], opts: RunOptions): Promise<RunResult>;
    /** End the worker and drop every compiled binary. */
    dispose(): void;
}

/** Where the core looks for geoip.dat, geosite.dat and `ext:` files (`XRAY_LOCATION_ASSET`). */
export const ASSET_DIR = '/usr/share/xray' as const;
/** `XRAY_LOCATION_CERT`: where a relative certificate path is looked up. */
export const CERT_DIR = '/etc/xray' as const;
/** Default working directory of `run`, and where `check` puts the config. */
export const WORK_DIR = '/work' as const;
