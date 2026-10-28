import { describe, expect, test } from 'bun:test';
import { buildTargets, compareTags, readVersions, targetFor, type VersionsFile } from '../scripts/versions';

const file: VersionsFile = {
    floor: 'v26.3.27',
    extra: ['v26.10.10@701af607'],
    unsupported: { 'v26.5.3': 'example' },
    releases: [
        { tag: 'v26.10.21', prerelease: false, publishedAt: '2026-10-21T00:00:00Z' },
        { tag: 'v26.9.30', prerelease: true, publishedAt: '2026-09-30T00:00:00Z' },
        { tag: 'v26.5.3', prerelease: true, publishedAt: '2026-05-03T00:00:00Z' },
        { tag: 'v26.3.27', prerelease: false, publishedAt: '2026-03-27T00:00:00Z' },
        { tag: 'v26.3.23', prerelease: true, publishedAt: '2026-03-23T00:00:00Z' },
    ],
};

describe('build set', () => {
    test('every release from the floor up, the extras, minus unsupported, oldest first', () => {
        expect(buildTargets(file)).toEqual([
            { tag: 'v26.3.27', ref: 'v26.3.27', channel: 'stable', publishedAt: '2026-03-27T00:00:00Z' },
            { tag: 'v26.9.30', ref: 'v26.9.30', channel: 'prerelease', publishedAt: '2026-09-30T00:00:00Z' },
            { tag: 'v26.10.10', ref: '701af607', channel: 'withdrawn' },
            { tag: 'v26.10.21', ref: 'v26.10.21', channel: 'stable', publishedAt: '2026-10-21T00:00:00Z' },
        ]);
    });

    test('any other tag can still be named', () => {
        expect(targetFor('v26.3.23', file)).toMatchObject({ tag: 'v26.3.23', ref: 'v26.3.23', channel: 'prerelease' });
    });

    test('tags compare numerically', () => {
        expect(compareTags('v26.10.21', 'v26.9.30')).toBeGreaterThan(0);
        expect(compareTags('v26.4.13', 'v26.4.13')).toBe(0);
    });

    test('versions.json is well-formed and keeps the floor and the withdrawn release', () => {
        const tags = buildTargets(readVersions()).map(target => target.tag);
        expect(tags[0]).toBe('v26.3.27');
        expect(tags).toContain('v26.10.10');
        expect(new Set(tags).size).toBe(tags.length);
    });
});
