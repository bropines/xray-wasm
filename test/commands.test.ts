import { describe, expect, test } from 'bun:test';
import { effectiveArgs, refusal } from '../src/commands';

describe('effectiveArgs (main.go getArgsV4Compatible)', () => {
    test('maps the v4 forms', () => {
        expect(effectiveArgs([])).toEqual(['run']);
        expect(effectiveArgs(['-version'])).toEqual(['version']);
        expect(effectiveArgs(['-h'])).toEqual(['help']);
        expect(effectiveArgs(['-test', '-c', 'x.json'])).toEqual(['run', '-test', '-c', 'x.json']);
        expect(effectiveArgs(['uuid'])).toEqual(['uuid']);
    });
});

describe('refusal', () => {
    test('a server is never started', () => {
        expect(refusal([])).toContain('-test');
        expect(refusal(['run', '-c', 'config.json'])).toContain('-test');
        expect(refusal(['-c', 'config.json'])).toContain('-test');
        expect(refusal(['run', '-test', '-c', 'config.json'])).toBeNull();
        expect(refusal(['run', '--test=true'])).toBeNull();
        expect(refusal(['run', '-dump'])).toBeNull();
        expect(refusal(['-test'])).toBeNull();
        expect(refusal(['run', '-h'])).toBeNull();
    });

    test('nothing goes to the network', () => {
        expect(refusal(['run', '-test', '-c', 'https://example.com/c.json'])).toContain('URL');
        expect(refusal(['run', '-test', '-config=http://example.com/c.json'])).toContain('URL');
        expect(refusal(['api', 'statsquery'])).toContain('gRPC');
        expect(refusal(['tls', 'ping', 'example.com'])).toContain('tls ping');
    });

    test('help for those commands still runs', () => {
        expect(refusal(['api'])).toBeNull();
        expect(refusal(['api', 'statsquery', '-h'])).toBeNull();
        expect(refusal(['tls', 'ping', '-h'])).toBeNull();
        expect(refusal(['help', 'api'])).toBeNull();
        expect(refusal(['tls', 'cert', '-domain', 'example.com'])).toBeNull();
    });
});
