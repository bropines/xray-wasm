/**
 * Build Xray-core's own `xray` command for js/wasm, once per release.
 *
 *   bun scripts/build.ts --repo <Xray-core clone> [--out dist-wasm] [--work .work]
 *        [--tags v26.7.28,v26.10.21 | --tags all] [--keep-going] [--variant cli|check]
 *   bun scripts/build.ts --manifest-only [--out dist-wasm]
 *
 * --repo     a git clone of XTLS/Xray-core with the tags (and, for a release whose
 *            tag was deleted upstream, the commit in versions.json). Nothing in it
 *            is modified: each tag is taken with `git archive` into --work.
 * --work     scratch directory (default .work/, gitignored). Sources and the Go
 *            module cache stay there between runs.
 * --tags     default: the build set of versions.json (scripts/versions.ts). Any
 *            other tag works too; `<tag>@<commit>` builds one whose tag is gone.
 * --variant  `cli` (default, what is shipped): the tag's `main` package, unmodified.
 *            `check`: go/check, the older wrapper that calls DecodeJSONConfig →
 *            Build() → core.New() directly. Kept only to compare the two
 *            (scripts/compare.ts); see README "One binary per release".
 *
 * Per tag it writes <out>/<tag>/xray.wasm, xray.wasm.gz and build.json (this
 * build's manifest entry), then rewrites <out>/manifest.json from every
 * build.json under <out> and copies wasm_exec.js from the GOROOT that built
 * them (a wasm_exec.js from another Go release does not run these binaries).
 *
 * How the `main` package is built unmodified: a scratch module requires
 * github.com/xtls/xray-core, replaced by the tag's extracted source, and runs
 * `go build github.com/xtls/xray-core/main`. Its go.sum is the tag's. The only
 * additions are the shims (go/shims, go/shims.json; see applyShims).
 */
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildTargets, compareTags, readVersions, targetFor, type BuildTarget, type Channel } from './versions';

const ROOT = resolve(import.meta.dir, '..');
const GO_DIR = join(ROOT, 'go');
const versions = readVersions();

/**
 * Imports of main/distro/all the `check` variant leaves out (the `cli`
 * variant is the tag's main package and takes all of them). Each is about the
 * command line around the core, not about what a config may say.
 */
const CHECK_EXCLUDED_IMPORTS = new Set([
    'github.com/xtls/xray-core/main/commands/all',
    'github.com/xtls/xray-core/main/confloader/external',
    'github.com/xtls/xray-core/main/toml',
    'github.com/xtls/xray-core/main/yaml',
]);

type Variant = 'cli' | 'check';
interface Args { repo: string; out: string; work: string; targets: BuildTarget[]; keepGoing: boolean; variant: Variant }

function parseArgs(argv: string[]): Args {
    const get = (name: string) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const repo = get('repo') ?? process.env.XRAY_CORE_REPO;
    if (!repo) {
        console.error('usage: bun scripts/build.ts --repo <Xray-core clone> [--out dir] [--work dir] [--tags a,b|all] [--keep-going]');
        process.exit(2);
    }
    const spec = get('tags');
    const targets = !spec || spec === 'all'
        ? buildTargets(versions)
        : spec.split(',').map(tag => tag.trim()).filter(Boolean).map((item): BuildTarget => {
            const [tag, commit] = item.split('@') as [string, string | undefined];
            return commit ? { tag, ref: commit, channel: 'withdrawn' } : targetFor(tag, versions);
        });
    const variant = (get('variant') ?? 'cli') as Variant;
    if (variant !== 'cli' && variant !== 'check') throw new Error(`--variant ${variant}: cli or check`);
    return {
        repo: resolve(repo),
        out: resolve(get('out') ?? join(ROOT, variant === 'cli' ? 'dist-wasm' : 'dist-wasm-check')),
        work: resolve(get('work') ?? join(ROOT, '.work')),
        targets,
        keepGoing: argv.includes('--keep-going'),
        variant,
    };
}

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): string {
    const proc = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: 'pipe', stderr: 'pipe' });
    const stdout = proc.stdout.toString();
    if (proc.exitCode !== 0) {
        throw new Error(`${cmd.join(' ')} (in ${opts.cwd ?? process.cwd()}) failed:\n${stdout}${proc.stderr.toString()}`);
    }
    return stdout;
}

/** The tag's source tree, extracted once into <work>/src/<tag>. */
function prepareSource(args: Args, tag: string, ref: string): { dir: string; commit: string } {
    const dir = join(args.work, 'src', tag);
    const commit = run(['git', '-C', args.repo, 'rev-parse', `${ref}^{commit}`]).trim();
    if (!existsSync(join(dir, 'go.mod'))) {
        mkdirSync(dir, { recursive: true });
        const tar = join(args.work, 'src', `${tag}.tar`);
        run(['git', '-C', args.repo, 'archive', '-o', tar, commit]);
        // Relative paths: GNU tar on Windows reads `C:` as a remote host.
        run(['tar', '-xf', `../${tag}.tar`], { cwd: dir });
        rmSync(tar);
    }
    return { dir, commit };
}

function coreVersionOf(source: string): string {
    const text = readFileSync(join(source, 'core', 'core.go'), 'utf8');
    const part = (name: string) => new RegExp(`${name}\\s+byte\\s*=\\s*(\\d+)`).exec(text)?.[1];
    return [part('Version_x'), part('Version_y'), part('Version_z')].join('.');
}

function goDirective(source: string): string {
    return /^go\s+(\S+)/m.exec(readFileSync(join(source, 'go.mod'), 'utf8'))?.[1] ?? '1.26';
}

interface ShimRule { from?: string; until?: string }

/**
 * Files added to packages for this build only. go/shims/<import path>/<file>.go
 * joins the package at that import path, at the version the tag pins. Only
 * additions, never replacements: the js port lacks a few names the core uses,
 * and adding them is the one way to compile the core unmodified. Each shim
 * says why it is there and why it cannot change a check's outcome.
 *
 * Which shims a tag gets is data: a shim joins when its package is in the
 * dependency graph of what is built (`go list -deps`) and the tag is within
 * its range in go/shims.json.
 *
 * A standard-library package gets the file through `go build -overlay`. Go
 * refuses overlays beneath GOMODCACHE, so a package of a required module gets
 * a copy of that module under <mod>/shimmed, the file written into the copy,
 * and a `replace` pointing at it. Neither GOROOT, the module cache nor
 * Xray-core's source is touched.
 */
function applyShims(mod: string, target: string, tag: string, env: Record<string, string>): { overlay: Record<string, string>; applied: string[] } {
    const rules = JSON.parse(readFileSync(join(GO_DIR, 'shims.json'), 'utf8')) as Record<string, ShimRule>;
    const inRange = (shim: string) => {
        const rule = rules[shim] ?? {};
        return (!rule.from || compareTags(tag, rule.from) >= 0) && (!rule.until || compareTags(tag, rule.until) <= 0);
    };
    const overlay: Record<string, string> = {};
    const applied: string[] = [];
    const deps = new Set(run(['go', 'list', '-deps', target], { cwd: mod, env }).split('\n').map(line => line.trim()));
    const walk = (dir: string, importPath: string[]) => {
        const entries = readdirSync(dir, { withFileTypes: true });
        const pkg = importPath.join('/');
        const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.go') && inRange(`${pkg}/${entry.name}`));
        if (files.length && deps.has(pkg)) {
            const [standard, pkgDir, modPath, modDir] = run(
                ['go', 'list', '-f', '{{.Standard}}\n{{.Dir}}\n{{with .Module}}{{.Path}}\n{{.Dir}}{{end}}', pkg],
                { cwd: mod, env },
            ).trim().split('\n').map(line => line.trim());
            if (standard === 'true') {
                for (const file of files) overlay[join(pkgDir!, `zz_xraywasm_${file.name}`)] = join(dir, file.name);
            } else {
                if (!modPath || !modDir) throw new Error(`shim ${pkg}: no module`);
                const copy = join(mod, 'shimmed', modPath);
                if (!existsSync(copy)) {
                    cpSync(modDir, copy, { recursive: true });
                    makeWritable(copy); // the module cache is read-only, and cpSync keeps modes
                    run(['go', 'mod', 'edit', `-replace=${modPath}=./shimmed/${modPath}`], { cwd: mod, env });
                }
                const into = join(copy, relative(modDir, pkgDir!));
                for (const file of files) writeFileSync(join(into, `zz_xraywasm_${file.name}`), readFileSync(join(dir, file.name)));
            }
            applied.push(...files.map(file => `${pkg}/${file.name}`));
        }
        for (const entry of entries) if (entry.isDirectory()) walk(join(dir, entry.name), [...importPath, entry.name]);
    };
    walk(join(GO_DIR, 'shims'), []);
    return { overlay, applied };
}

function makeWritable(path: string): void {
    const stat = statSync(path);
    chmodSync(path, stat.mode | 0o200);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** One build's manifest entry; build.json next to the binary. */
export interface BuildEntry {
    tag: string;
    version: string;
    /** The gzip copy, relative to the manifest: what a loader fetches. */
    file: string;
    /** The uncompressed binary, for hosts that keep it (not on Pages, not in releases). */
    rawFile: string;
    size: number;
    gzip: number;
    /** sha256 of the uncompressed binary, i.e. of what is compiled. */
    sha256: string;
    gzipSha256: string;
    commit: string;
    channel: Channel;
    /** When GitHub published the release; for a withdrawn one, the commit's date. */
    publishedAt?: string;
    go: string;
    shims: string[];
}

function buildTag(args: Args, target: BuildTarget): BuildEntry {
    const { tag } = target;
    const { dir: source, commit } = prepareSource(args, tag, target.ref);
    const mod = join(args.work, 'build', args.variant, tag);
    if (existsSync(mod)) makeWritable(mod);
    rmSync(mod, { recursive: true, force: true });
    mkdirSync(mod, { recursive: true });
    const goEnv = { GOOS: 'js', GOARCH: 'wasm', GOFLAGS: '-mod=mod', GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? 'local' };

    writeFileSync(join(mod, 'go.mod'), [
        `// Scratch module for ${tag}, written by scripts/build.ts.`,
        'module xraywasm',
        '',
        `go ${goDirective(source)}`,
        '',
        'require github.com/xtls/xray-core v0.0.0-00010101000000-000000000000',
        '',
        `replace github.com/xtls/xray-core => ${source.replaceAll('\\', '/')}`,
        '',
    ].join('\n'));
    // The tag's go.sum already pins every module the core needs.
    cpSync(join(source, 'go.sum'), join(mod, 'go.sum'));

    let pkg: string;
    if (args.variant === 'cli') {
        pkg = 'github.com/xtls/xray-core/main';
        // Nothing in this module imports the core, so `go mod tidy` would drop
        // the requirement; -mod=mod lets `go build` resolve the rest itself.
        run(['go', 'list', '-deps', pkg], { cwd: mod, env: goEnv });
    } else {
        pkg = '.';
        cpSync(join(GO_DIR, 'check', 'main.go'), join(mod, 'main.go'));
        const text = readFileSync(join(source, 'main', 'distro', 'all', 'all.go'), 'utf8');
        const imports = [...text.matchAll(/^\s*_\s+"([^"]+)"/gm)].map(match => match[1]!).filter(path => !CHECK_EXCLUDED_IMPORTS.has(path));
        if (imports.length < 20) throw new Error(`${tag}: main/distro/all/all.go lists only ${imports.length} imports`);
        writeFileSync(join(mod, 'imports_gen.go'), [
            '//go:build js && wasm', '',
            `// Code generated by scripts/build.ts from ${tag} main/distro/all/all.go. DO NOT EDIT.`, '',
            'package main', '', 'import (', ...imports.map(path => `\t_ "${path}"`), ')', '',
        ].join('\n'));
        run(['go', 'mod', 'tidy'], { cwd: mod, env: goEnv });
    }

    const outDir = join(args.out, tag);
    mkdirSync(outDir, { recursive: true });
    const wasm = join(outDir, 'xray.wasm');
    const { overlay, applied } = applyShims(mod, pkg, tag, goEnv);
    const overlayPath = join(mod, 'overlay.json');
    writeFileSync(overlayPath, JSON.stringify({ Replace: overlay }, null, 2));
    const started = Date.now();
    run(['go', 'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', `-overlay=${overlayPath}`, '-o', wasm, pkg], { cwd: mod, env: goEnv });

    const bytes = readFileSync(wasm);
    // GitHub Pages does not compress application/wasm, so the raw file would
    // cross the wire at full size; the gzip copy is inflated by the loader
    // (DecompressionStream) on any host.
    const gz = gzipSync(bytes, { level: 9 });
    writeFileSync(`${wasm}.gz`, gz);
    const entry: BuildEntry = {
        tag,
        version: coreVersionOf(source),
        file: `${tag}/xray.wasm.gz`,
        rawFile: `${tag}/xray.wasm`,
        size: bytes.length,
        gzip: gz.length,
        sha256: sha256(bytes),
        gzipSha256: sha256(gz),
        commit,
        channel: target.channel,
        publishedAt: target.publishedAt ?? run(['git', '-C', args.repo, 'show', '-s', '--format=%cI', commit]).trim(),
        go: run(['go', 'env', 'GOVERSION']).trim(),
        shims: applied,
    };
    writeFileSync(join(outDir, 'build.json'), `${JSON.stringify(entry, null, 2)}\n`);
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
    console.log(`${tag}: ${mb(entry.size)} raw, ${mb(entry.gzip)} gzip, shims [${applied.join(', ')}] (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    return entry;
}

/** wasm_exec.js of the Go that is on PATH; copied, never vendored. */
export function copyWasmExec(out: string): { file: string; sha256: string; go: string } {
    const goroot = run(['go', 'env', 'GOROOT']).trim();
    const found = [join(goroot, 'lib', 'wasm', 'wasm_exec.js'), join(goroot, 'misc', 'wasm', 'wasm_exec.js')]
        .find(path => existsSync(path) && statSync(path).isFile());
    if (!found) throw new Error(`wasm_exec.js not found under ${goroot}`);
    const bytes = readFileSync(found);
    writeFileSync(join(out, 'wasm_exec.js'), bytes);
    return { file: 'wasm_exec.js', sha256: sha256(bytes), go: run(['go', 'env', 'GOVERSION']).trim() };
}

/** manifest.json from every <out>/<tag>/build.json whose binary is still there. */
export function writeManifest(out: string, wasmExec = copyWasmExec(out)): number {
    const builds: BuildEntry[] = [];
    for (const entry of readdirSync(out, { withFileTypes: true })) {
        const path = join(out, entry.name, 'build.json');
        if (!entry.isDirectory() || !existsSync(path)) continue;
        const build = JSON.parse(readFileSync(path, 'utf8')) as BuildEntry;
        if (existsSync(join(out, build.file))) builds.push(build);
    }
    builds.sort((a, b) => compareTags(a.tag, b.tag));
    const mixed = builds.filter(build => build.go !== wasmExec.go);
    if (mixed.length) throw new Error(`built with another Go than ${wasmExec.go}: ${mixed.map(b => `${b.tag} (${b.go})`).join(', ')}`);
    const manifest = { format: 1, generatedBy: 'xray-wasm scripts/build.ts', wasmExec, builds };
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return builds.length;
}

if (import.meta.main && process.argv.includes('--manifest-only')) {
    // CI's assemble step: the per-tag folders came from a matrix of jobs.
    const i = process.argv.indexOf('--out');
    const out = resolve(i >= 0 ? process.argv[i + 1]! : join(ROOT, 'dist-wasm'));
    console.log(`wrote ${join(out, 'manifest.json')} (${writeManifest(out)} builds)`);
} else if (import.meta.main) {
    const args = parseArgs(process.argv.slice(2));
    mkdirSync(args.out, { recursive: true });
    mkdirSync(args.work, { recursive: true });
    // One module cache for every tag: they share most dependencies.
    process.env.GOMODCACHE ??= join(args.work, 'gomodcache');

    const failed: string[] = [];
    for (const target of args.targets) {
        try {
            buildTag(args, target);
        } catch (error) {
            if (!args.keepGoing) throw error;
            console.error(String(error));
            failed.push(target.tag);
        }
    }
    const count = writeManifest(args.out);
    console.log(`wrote ${join(args.out, 'manifest.json')} (${count} builds)`);
    if (failed.length) {
        console.error(`failed: ${failed.join(', ')}`);
        process.exit(1);
    }
}
