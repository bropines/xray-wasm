/**
 * Refresh the `releases` snapshot in versions.json from the GitHub API and say
 * what changed in the build set.
 *
 *   bun scripts/upstream.ts [--write] [--github-output <file>]
 *
 * Reads https://api.github.com/repos/XTLS/Xray-core/releases (GITHUB_TOKEN, if
 * set, lifts the anonymous rate limit). Drafts are skipped. Without --write it
 * only prints. With --github-output it appends `added=<json tags>`,
 * `removed=<json tags>` and `changed=true|false` for a workflow step.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { buildTargets, compareTags, readVersions, VERSIONS_PATH, type Release } from './versions';

const argv = process.argv.slice(2);
const outputIndex = argv.indexOf('--github-output');
const githubOutput = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;

async function fetchReleases(): Promise<Release[]> {
    const releases: Release[] = [];
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'xray-wasm-upstream' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    // Newest first: stop once a page reaches below the floor.
    for (let page = 1; page <= 10; page++) {
        const response = await fetch(`https://api.github.com/repos/XTLS/Xray-core/releases?per_page=100&page=${page}`, { headers });
        if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status} ${await response.text()}`);
        const batch = await response.json() as { tag_name: string; prerelease: boolean; draft: boolean; published_at: string }[];
        for (const item of batch) if (!item.draft) releases.push({ tag: item.tag_name, prerelease: item.prerelease, publishedAt: item.published_at });
        if (batch.length < 100 || batch.some(item => compareTags(item.tag_name, floor) < 0)) break;
    }
    return releases.sort((a, b) => compareTags(b.tag, a.tag));
}

const versions = readVersions();
const floor = versions.floor;
const before = buildTargets(versions).map(target => target.tag);
const releases = await fetchReleases();
// The snapshot holds what the rule can reach: releases at or above the floor.
const next = { ...versions, releases: releases.filter(release => compareTags(release.tag, floor) >= 0) };
const after = buildTargets(next).map(target => target.tag);
const added = after.filter(tag => !before.includes(tag));
const removed = before.filter(tag => !after.includes(tag));

console.log(`build set: ${after.length} tags`);
console.log(`added: ${added.join(', ') || '-'}`);
console.log(`removed: ${removed.join(', ') || '-'}`);
if (argv.includes('--write')) {
    // One release per line: the diff of an update reads as the list of new releases.
    const lines = next.releases.map(release => `    ${JSON.stringify(release)}`).join(',\n');
    const { releases: _, ...head } = next;
    const text = JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "releases": [\n${lines}\n  ]\n}\n`);
    writeFileSync(VERSIONS_PATH, text);
}
if (githubOutput) {
    appendFileSync(githubOutput, `added=${JSON.stringify(added)}\nremoved=${JSON.stringify(removed)}\nchanged=${added.length || removed.length ? 'true' : 'false'}\n`);
}
