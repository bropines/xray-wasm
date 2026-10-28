import { describe, expect, test } from 'bun:test';
import { classify, platformCaveats, significantMissing, versionFromOutput } from '../src/classify';

const HEAD = 'Xray 26.10.21 (Xray, Penetrates Everything.) Custom (go1.27.0 js/wasm)\nA unified platform for anti-censorship.\n';
const raw = (exitCode: number | null, text: string, missing: string[] = []) => ({ exitCode, text: HEAD + text, missing, durationMs: 12.4 });

describe('classify', () => {
    test('"Configuration OK." with exit 0 is ok, even when optional files were probed', () => {
        const result = classify(raw(0, 'Configuration OK.\n', ['/usr/share/xray/geoip.dat']), 'v26.10.21', '{}');
        expect(result).toMatchObject({ verdict: 'ok', ok: true, tag: 'v26.10.21', coreVersion: '26.10.21', durationMs: 12 });
        expect(result.missingFiles).toBeUndefined();
        expect(result.log[0]).toStartWith('Xray 26.10.21');
    });

    test('exit 23 is a config error; the message loses the CLI prefix', () => {
        const result = classify(raw(23, 'Failed to start: main: failed to load config files: [config.json] > invalid "privateKey"\n'), 'v26.9.9', '{}');
        expect(result).toMatchObject({ verdict: 'error', ok: false, error: 'main: failed to load config files: [config.json] > invalid "privateKey"' });
    });

    test('a refusal after a missing asset is inconclusive and names the file once', () => {
        const missing = ['/usr/share/xray/geosite.dat', '/usr/local/share/xray/geosite.dat', '/opt/share/xray/geosite.dat'];
        const result = classify(raw(23, 'Failed to start: failed to open geosite.dat\n', missing), 'v26.9.9', '{}');
        expect(result.verdict).toBe('inconclusive');
        expect(result.missingFiles).toEqual(['/usr/share/xray/geosite.dat']);
    });

    test('a missing file the config does not name does not make a refusal inconclusive', () => {
        expect(classify(raw(23, 'Failed to start: bad\n', ['/etc/resolv.conf']), 'v26.9.9', '{"log":{}}').verdict).toBe('error');
    });

    test('a missing certificate the config names is inconclusive', () => {
        const config = JSON.stringify({ inbounds: [{ streamSettings: { tlsSettings: { certificates: [{ certificateFile: '/etc/ssl/x/cert.pem' }] } } }] });
        expect(classify(raw(23, 'Failed to start: open /etc/ssl/x/cert.pem\n', ['/etc/ssl/x/cert.pem']), 'v26.9.9', config).verdict).toBe('inconclusive');
    });

    test('a refusal about the platform, not the config, is inconclusive', () => {
        // v26.3.27 proxy/tun/tun_default.go, reached from core.New under GOOS=js.
        const text = 'Failed to start: main: failed to create server > proxy/tun: Tun is not supported on your platform\n';
        const result = classify(raw(23, text), 'v26.3.27', '{"inbounds":[{"protocol":"tun"}]}');
        expect(result.verdict).toBe('inconclusive');
        expect(result.skipped).toHaveLength(2);
    });

    test('a panic is a crash', () => {
        const result = classify(raw(2, 'panic: boom\n\ngoroutine 1 [running]:\n'), 'v26.10.10', '{}');
        expect(result.verdict).toBe('crashed');
        expect(result.error).toContain('panic: boom');
    });

    test('an instance that never exited is a crash, not ok', () => {
        expect(classify(raw(null, ''), 'v26.10.21', '{}').verdict).toBe('crashed');
    });

    test('the CLI refusing before the core ran (exit 1) is an error', () => {
        const result = classify(raw(1, '2026/01/01 00:00:00 open /x: no such file\n'), 'v26.10.21', '{}');
        expect(result.verdict).toBe('error');
        expect(result.error).toContain('no such file');
    });

    test('a tun inbound is reported as partly unchecked', () => {
        const config = JSON.stringify({ inbounds: [{ protocol: 'tun' }] });
        expect(classify(raw(0, 'Configuration OK.\n'), 'v26.10.10', config).skipped).toHaveLength(1);
        expect(platformCaveats({ inbounds: [{ protocol: 'vless' }] })).toEqual([]);
        expect(platformCaveats(null)).toEqual([]);
    });

    test('reads the version line', () => {
        expect(versionFromOutput(HEAD)).toBe('26.10.21');
        expect(versionFromOutput('nothing')).toBeUndefined();
    });
});

describe('significantMissing', () => {
    test('keeps a fallback probe only when the primary path was not probed', () => {
        expect(significantMissing(['/opt/share/xray/x.dat'])).toEqual(['/opt/share/xray/x.dat']);
        expect(significantMissing(['/etc/ssl/a.pem', '/etc/ssl/a.pem'], 'a.pem')).toEqual(['/etc/ssl/a.pem']);
    });
});
