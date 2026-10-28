/**
 * Turn what `xray run -test` printed and how it exited into a verdict. Pure,
 * so it is unit-tested without a wasm build (test/classify.test.ts).
 *
 * What main/run.go does under -test, in every built tag: print the version,
 * then startXray() — core.LoadConfig (decode, Build() of every part) and
 * core.New() — and either `fmt.Println("Failed to start:", err)` and
 * os.Exit(23), or `fmt.Println("Configuration OK.")` and os.Exit(0).
 */
import { ASSET_DIR, type CheckResult } from './types.js';

export interface RawCheck {
    exitCode: number | null;
    /** stdout + stderr, in order. */
    text: string;
    /** Paths the core looked for and did not find. */
    missing: string[];
    durationMs: number;
}

/**
 * GetAssetLocation (common/platform/others.go) tries XRAY_LOCATION_ASSET and
 * then these; a file missing from the first is reported once, not four times.
 */
const ASSET_FALLBACKS = ['/usr/local/share/xray/', '/usr/share/xray/', '/opt/share/xray/'];

/**
 * The missing paths that can explain a refusal: assets (geoip:/geosite:/ext:
 * name no path in the config, so any asset counts), and anything else whose
 * file name the config itself mentions (a certificate, a key). A probe the
 * CLI or the runtime makes on its own is not a reason to doubt a verdict.
 */
export function significantMissing(missing: string[], configText = ''): string[] {
    const set = new Set(missing);
    return [...set].filter(path => {
        const fallback = ASSET_FALLBACKS.find(prefix => path.startsWith(prefix));
        if (!fallback) {
            const name = path.slice(path.lastIndexOf('/') + 1);
            return name.length > 0 && configText.includes(name);
        }
        const primary = `${ASSET_DIR}/${path.slice(fallback.length)}`;
        return primary === path || !set.has(primary);
    });
}

/**
 * Parts of a config whose Build() takes a different branch on the core's
 * platform. The browser build runs as GOOS=js, which none of these branches
 * names, so those checks do not run here.
 */
export function platformCaveats(config: unknown): string[] {
    const notes: string[] = [];
    const inbounds = (config as { inbounds?: unknown })?.inbounds;
    if (Array.isArray(inbounds) && inbounds.some(inbound => (inbound as { protocol?: unknown })?.protocol === 'tun')) {
        notes.push('tun inbound: the Linux- and Windows-only checks of its settings did not run (the browser core is not on either platform).');
    }
    return notes;
}

/**
 * The core's own words for "not on this platform" — said about the machine,
 * not the config. Under GOOS=js the core reaches its generic fallbacks, e.g.
 * v26.3.27 proxy/tun/tun_default.go ("Tun is not supported on your platform",
 * from core.New) and the tun's automatic outbound interface ("... is not
 * supported on this platform").
 */
const PLATFORM_REFUSAL = /\bnot supported on (?:your|this) platform\b/i;
const FAILED = 'Failed to start: ';
const CRASH = /^(?:panic: |fatal error: )/m;

/** "Xray 26.10.21 (Xray, Penetrates Everything.) …" → "26.10.21". */
export function versionFromOutput(text: string): string | undefined {
    return /^Xray (\d+\.\d+\.\d+)\b/m.exec(text)?.[1];
}

const lines = (text: string) => text.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.length > 0);
const tail = (text: string, n: number) => lines(text).slice(-n).join('\n');

export function classify(raw: RawCheck, tag: string, configJson: string): CheckResult {
    let parsed: unknown;
    try { parsed = JSON.parse(configJson); } catch { /* JSONC or broken: the core reports that */ }
    const skipped = parsed === undefined ? [] : platformCaveats(parsed);
    const base = {
        tag,
        coreVersion: versionFromOutput(raw.text),
        durationMs: Math.round(raw.durationMs),
        log: lines(raw.text),
    };
    const withSkipped = () => (skipped.length ? { skipped } : {});

    const at = raw.text.lastIndexOf(FAILED);
    const error = at >= 0 ? raw.text.slice(at + FAILED.length).trim() : undefined;
    const missingFiles = significantMissing(raw.missing, configJson);

    if (raw.exitCode === 0 && /^Configuration OK\.$/m.test(raw.text)) return { ...base, verdict: 'ok', ok: true, ...withSkipped() };
    if (raw.exitCode === 23 && error !== undefined) {
        if (PLATFORM_REFUSAL.test(error)) {
            skipped.push('The core stopped at a part that only builds on the platform it runs on; everything after it was not checked.');
            return { ...base, verdict: 'inconclusive', ok: false, error, skipped };
        }
        if (missingFiles.length) return { ...base, verdict: 'inconclusive', ok: false, error, missingFiles, ...withSkipped() };
        return { ...base, verdict: 'error', ok: false, error, ...withSkipped() };
    }
    if (CRASH.test(raw.text) || raw.exitCode === 2 || raw.exitCode === null) {
        return {
            ...base, verdict: 'crashed', ok: false,
            error: `the core crashed (exit code ${raw.exitCode})\n${tail(raw.text, 40)}`,
            ...(missingFiles.length ? { missingFiles } : {}), ...withSkipped(),
        };
    }
    // Anything else (log.Fatalln is exit 1) is the CLI refusing before the core ran.
    return { ...base, verdict: 'error', ok: false, error: error ?? (tail(raw.text, 10) || `exit code ${raw.exitCode}`), ...withSkipped() };
}
