/**
 * The build set, read from versions.json. Shared by the build script, the
 * smoke runner, the release matrix and the upstream workflow, so there is one
 * place that says which releases are built.
 *
 * versions.json holds the rule (`floor`: every release from this tag up,
 * stable and prerelease alike; `extra`: built besides those) and `releases`,
 * a snapshot of XTLS/Xray-core's releases at or above the floor that
 * scripts/upstream.ts refreshes from the GitHub API. Builds read the snapshot, never the API, so
 * a given commit of this repo always builds the same set.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Channel = 'stable' | 'prerelease' | 'withdrawn';

export interface Release { tag: string; prerelease: boolean; publishedAt: string }

export interface VersionsFile {
    /** Every release from this tag up is built. */
    floor: string;
    /** `tag`, or `tag@commit` for a release whose tag was deleted upstream (built from that commit, channel `withdrawn`). */
    extra: string[];
    /** Tags that do not build, with the reason; left out of the set and listed in the README. */
    unsupported: Record<string, string>;
    releases: Release[];
}

export interface BuildTarget {
    tag: string;
    /** What `git archive` takes: the tag, or the commit of a withdrawn one. */
    ref: string;
    channel: Channel;
    publishedAt?: string;
}

export const VERSIONS_PATH = join(import.meta.dir, '..', 'versions.json');

export function readVersions(path = VERSIONS_PATH): VersionsFile {
    return JSON.parse(readFileSync(path, 'utf8')) as VersionsFile;
}

/** `v26.10.21` → comparable number; anything that is not vX.Y.Z sorts first. */
export function tagOrder(tag: string): number {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    if (!match) return -1;
    return (Number(match[1]) * 1000 + Number(match[2])) * 1000 + Number(match[3]);
}

export const compareTags = (a: string, b: string) => tagOrder(a) - tagOrder(b);

/** Every release at or above the floor, plus the extra ones, oldest first. */
export function buildTargets(versions: VersionsFile = readVersions()): BuildTarget[] {
    const byTag = new Map(versions.releases.map(release => [release.tag, release]));
    const targets = new Map<string, BuildTarget>();
    for (const release of versions.releases) {
        if (compareTags(release.tag, versions.floor) < 0 || release.tag in versions.unsupported) continue;
        targets.set(release.tag, { tag: release.tag, ref: release.tag, channel: release.prerelease ? 'prerelease' : 'stable', publishedAt: release.publishedAt });
    }
    for (const spec of versions.extra) {
        const [tag, commit] = spec.split('@') as [string, string | undefined];
        if (tag in versions.unsupported) continue;
        const release = byTag.get(tag);
        if (commit) targets.set(tag, { tag, ref: commit, channel: 'withdrawn' });
        else targets.set(tag, { tag, ref: tag, channel: release?.prerelease ? 'prerelease' : 'stable', ...(release ? { publishedAt: release.publishedAt } : {}) });
    }
    return [...targets.values()].sort((a, b) => compareTags(a.tag, b.tag));
}

/** The target for one tag, in the set or not (`--tags` may name any release). */
export function targetFor(tag: string, versions: VersionsFile = readVersions()): BuildTarget {
    const known = buildTargets(versions).find(target => target.tag === tag);
    if (known) return known;
    const release = versions.releases.find(entry => entry.tag === tag);
    return { tag, ref: tag, channel: release?.prerelease === false ? 'stable' : 'prerelease', ...(release ? { publishedAt: release.publishedAt } : {}) };
}

if (import.meta.main) {
    // `bun scripts/versions.ts` prints the set, one per line; `--json` as a JSON array of tags (a CI matrix).
    const tags = buildTargets().map(target => target.tag);
    console.log(process.argv.includes('--json') ? JSON.stringify(tags) : tags.join('\n'));
}
