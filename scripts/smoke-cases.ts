/**
 * Configs with a known verdict on each tag, shared by scripts/smoke.ts and
 * scripts/compare.ts. Each expectation comes from the tag's source; the
 * comment says where when it differs between tags. Synthetic data only.
 */
import { compareTags } from './versions';
import type { Verdict } from '../src/types';

export interface CheckCase {
    name: string;
    config: unknown;
    expect: Verdict | ((tag: string) => Verdict);
    /** Hand the geo files over. */
    files?: boolean;
    /** The error must contain this (the core's own words). */
    errorIncludes?: string;
}

const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

export const vlessOut = (extra: Record<string, unknown> = {}) => ({
    tag: 'proxy',
    protocol: 'vless',
    settings: { vnext: [{ address: 'example.com', port: 443, users: [{ id: UUID, encryption: 'none' }] }] },
    // v26.10.21 refuses plain VLESS to a public address (infra/conf/vless.go).
    streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'example.com' } },
    ...extra,
});

export const minimal = {
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'socks', listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { udp: true } }],
    outbounds: [vlessOut(), { tag: 'direct', protocol: 'freedom' }],
};

const reality = (privateKey: string) => ({
    inbounds: [{
        tag: 'in', port: 443, protocol: 'vless',
        settings: { clients: [{ id: UUID }], decryption: 'none' },
        streamSettings: { network: 'tcp', security: 'reality', realitySettings: { target: 'example.com:443', serverNames: ['example.com'], privateKey, shortIds: [''] } },
    }],
    outbounds: [{ protocol: 'freedom' }],
});

const before = (tag: string, than: string) => compareTags(tag, than) < 0;
/**
 * Up to v26.6.1 the tun handler opens its device in core.New (proxy/tun/handler.go:60
 * NewTun), and under GOOS=js gets proxy/tun/tun_default.go:19 "Tun is not supported on
 * your platform"; v26.6.22 opens it in Start() instead (06b49317, "Start TUN by
 * AlwaysOnInboundHandler", #6275).
 */
const tunInNew = (tag: string) => before(tag, 'v26.6.22');

export const checkCases: CheckCase[] = [
    { name: 'minimal valid config', config: minimal, expect: 'ok' },
    { name: 'not JSON', config: '{ "inbounds": [', expect: 'error' },
    { name: 'JSON with comments (the core strips them)', config: `// a comment\n${JSON.stringify(minimal, null, 1)}`, expect: 'ok' },
    { name: 'unknown outbound protocol', config: { outbounds: [{ protocol: 'no-such-protocol' }] }, expect: 'error', errorIncludes: 'no-such-protocol' },
    {
        name: 'vless outbound with no address',
        config: { ...minimal, outbounds: [{ protocol: 'vless', settings: { vnext: [{ port: 443, users: [{ id: UUID, encryption: 'none' }] }] } }] },
        expect: 'error',
    },
    {
        // 26.9.9 removed proxySettings: up to v26.7.28 it loads, from v26.9.9 on any proxySettings is refused.
        name: 'proxySettings on an outbound',
        config: { ...minimal, outbounds: [vlessOut({ proxySettings: { tag: 'direct' } }), { tag: 'direct', protocol: 'freedom' }] },
        expect: tag => (before(tag, 'v26.9.9') ? 'ok' : 'error'),
    },
    { name: 'REALITY inbound with a bad private key', config: reality('not-a-key'), expect: 'error' },
    { name: 'REALITY inbound with a good private key', config: reality('sEWTw6dNz2IG9vSN8zvIM7Xh8RJmxKJL3Gp2MmpqYmA'), expect: 'ok' },
    {
        name: 'routing rule with geosite:/geoip:, no geo files',
        config: { ...minimal, routing: { rules: [{ type: 'field', domain: ['geosite:cn'], ip: ['geoip:private'], outboundTag: 'direct' }] } },
        expect: 'inconclusive',
    },
    {
        name: 'routing rule with geosite:/geoip:, geo files handed over',
        config: { ...minimal, routing: { rules: [{ type: 'field', domain: ['geosite:cn'], ip: ['geoip:private'], outboundTag: 'direct' }] } },
        expect: 'ok',
        files: true,
    },
    {
        name: 'geosite code the file does not have',
        config: { ...minimal, routing: { rules: [{ type: 'field', domain: ['geosite:no-such-code'], outboundTag: 'direct' }] } },
        expect: 'error',
        files: true,
    },
    {
        name: 'TLS inbound with a certificate file it was not given',
        config: {
            inbounds: [{
                port: 443, protocol: 'trojan', settings: { clients: [{ password: 'x' }] },
                streamSettings: { security: 'tls', tlsSettings: { certificates: [{ certificateFile: '/etc/ssl/xray/cert.pem', keyFile: '/etc/ssl/xray/key.pem' }] } },
            }],
            outbounds: [{ protocol: 'freedom' }],
        },
        expect: 'inconclusive',
    },
    {
        // infra/conf/tun.go:10: v26.3.27 `MTU uint32 json:"MTU"`, v26.4.13 `MTU []uint32 json:"mtu"`,
        // v26.4.15 on `MTU uint32 json:"mtu"` (Go's decoder matches keys case-insensitively).
        name: 'tun inbound with a numeric MTU',
        config: { inbounds: [{ tag: 'tun', protocol: 'tun', settings: { name: 'xray0', mtu: 1500 } }], outbounds: [{ protocol: 'freedom' }] },
        expect: tag => (tag === 'v26.4.13' ? 'error' : tunInNew(tag) ? 'inconclusive' : 'ok'),
    },
    {
        name: 'tun inbound',
        config: { inbounds: [{ tag: 'tun', protocol: 'tun', settings: { name: 'xray0' } }], outbounds: [{ protocol: 'freedom' }] },
        expect: tag => (tunInNew(tag) ? 'inconclusive' : 'ok'),
    },
];

// Minimal protobuf writer for the two geo files (common/geodata/geodat.proto,
// app/router/config.proto before 26.10 — same field numbers): length-delimited
// fields and varints only.
const varint = (n: number) => { const out: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const bytesField = (field: number, data: Uint8Array | number[]) => [...varint((field << 3) | 2), ...varint(data.length), ...data];
const strField = (field: number, s: string) => bytesField(field, [...new TextEncoder().encode(s)]);
const intField = (field: number, n: number) => [...varint(field << 3), ...varint(n)];
/** GeoSiteList { entry: [{ code: "CN", domain: [{ type: Domain(2), value: "example.cn" }] }] } */
const syntheticGeosite = () => new Uint8Array(bytesField(1, [...strField(1, 'CN'), ...bytesField(2, [...intField(1, 2), ...strField(2, 'example.cn')])]));
/** GeoIPList { entry: [{ code: "PRIVATE", cidr: [{ ip: 10.0.0.0, prefix: 8 }] }] } */
const syntheticGeoip = () => new Uint8Array(bytesField(1, [...strField(1, 'PRIVATE'), ...bytesField(2, [...bytesField(1, [10, 0, 0, 0]), ...intField(2, 8)])]));

export const geoFiles: Record<string, Uint8Array> = { 'geosite.dat': syntheticGeosite(), 'geoip.dat': syntheticGeoip() };
