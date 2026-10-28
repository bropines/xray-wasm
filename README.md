# xray-wasm

**Xray-core's own `xray` command, compiled to WebAssembly from unmodified release tags.** A web page can check a config exactly the way `xray run -test` does on a server, and run the CLI's offline commands (`x25519`, `uuid`, `vlessenc`, `tls cert`, …), on any of 16 Xray-core releases side by side.

[Русская версия](README.ru.md)

```ts
import { createXray } from 'xray-wasm';

const xray = createXray({ baseUrl: 'https://bropines.github.io/xray-wasm/' });

const result = await xray.check(configJson, { tag: 'v26.10.21' });
// { verdict: 'error', error: 'main: failed to load config files: [config.json] > … invalid "privateKey": …', … }

const keys = await xray.run(['x25519'], { tag: 'v26.10.21' });
console.log(keys.stdout); // PrivateKey: …  Password (PublicKey): …
```

Install from a release tarball (no npm registry yet; zero runtime dependencies):

```sh
bun add https://github.com/bropines/xray-wasm/releases/download/v0.1.0/xray-wasm-0.1.0.tgz
```

## Pick the version you need

`manifest.json` lists every build. A page downloads **only the tag it asks for** — one `.wasm.gz` of about 12 MiB, inflated in the browser, checked against the manifest's sha256 and compiled once. Asking for another tag downloads that one too; nothing else is fetched.

```ts
const { builds } = await xray.manifest();     // [{ tag, version, channel, publishedAt, gzip, sha256, … }]
await xray.prepare('v26.7.28', (loaded, total) => showProgress(loaded / total)); // optional: download ahead of time
await xray.check(configJson, { tag: 'v26.7.28' });
```

## API

| | |
|---|---|
| `createXray({ baseUrl, fetch?, worker?, workerUrl? })` | `baseUrl`: the folder holding `manifest.json`. `fetch`: your own (auth, cache, mirror); all downloads go through it. `worker` (default `true`): run in a Web Worker so a check never blocks the page; without one (Node, or `worker: false`) it runs on the calling thread. |
| `xray.check(json, { tag, files?, timeoutMs? })` | `xray run -test -c config.json`, classified. Never throws. |
| `xray.run(args, { tag, files?, stdin?, cwd?, timeoutMs? })` | The command line after `xray`. Returns `{ exitCode, stdout, stderr, files, durationMs, tag, timedOut?, stdoutBytes? }`. `files` holds what the command wrote. Rejects only when the tag cannot be loaded. |
| `xray.prepare(tag, onProgress?)` | Download and compile ahead of the first call. Cached. |
| `xray.manifest()`, `loadManifest(baseUrl, fetch?)` | The list of builds. |
| `xray.dispose()` | End the worker, drop compiled binaries. |
| `ASSET_DIR` | `/usr/share/xray`, where the core looks for `geoip.dat`, `geosite.dat` and `ext:` files. |

`files` maps paths to bytes. Absolute paths are used as they are; a relative path goes under `ASSET_DIR` for `check` (so `{ 'geosite.dat': bytes }` just works) and under the working directory (default `/work`) for `run`.

### Verdicts

| `verdict` | Meaning |
|---|---|
| `ok` | The core decoded the config, built every part and constructed the instance: `Configuration OK.` |
| `error` | The core refused it. `error` is its own message, without the CLI's `Failed to start:` prefix. |
| `inconclusive` | The core refused it after looking for a file it was not given (`missingFiles`: a geo `.dat`, a certificate), or stopped at a part that only builds on another platform (`skipped`). The refusal may be about nothing else, so it is not called a config error. |
| `crashed` | The Go runtime died (a panic). `error` holds the tail of its output. |
| `timeout` | No answer within `timeoutMs` (default 30 s); the worker was replaced. |
| `unavailable` | No build for that tag, or the environment could not load it. |

Every result carries `log` (what the core printed), `coreVersion`, `durationMs`, and `skipped` when part of the config was not covered.

## What it can and cannot check

It runs what `xray run -test` runs, in every built tag (`main/run.go`): decode the JSON (comments allowed), `Build()` every inbound, outbound, transport, routing rule and app, then `core.New()`, which constructs every feature without starting it. That catches type errors, unknown protocols, removed features, bad keys (REALITY, VLESS Encryption, WireGuard), routing rules that point at nothing, geosite codes a file lacks, and whatever else the core itself refuses at load.

It cannot see:

- **Anything that happens in `Start()`**: ports already in use, network interfaces, DNS resolution, whether a server is reachable. Nothing listens and nothing dials.
- **Files it is not handed.** Pass `geoip.dat`/`geosite.dat` and certificates in `files`; a refusal after a missing one is `inconclusive`, never `error`.
- **Branches of `Build()` that depend on the operating system.** The core runs as `GOOS=js`, so platform-specific checks (for example tun's Linux- and Windows-only settings) do not run; `skipped` says so. Up to v26.6.1 the tun device is opened in `core.New()`, so a tun inbound there is `inconclusive` ("Tun is not supported on your platform"); from v26.6.22 it is opened in `Start()`.

## The command line

`run()` executes the tag's real CLI with argv, an in-memory file system the command can read and write, stdin, and the exit code. Everything offline works as on a server: `version`, `help`, `uuid`, `x25519`, `wg`, `mldsa65`, `mlkem768`, `vlessenc`, `tls cert` (`-file` writes `name.crt`/`name.key`, returned in `files`), `tls hash`, `run -test` (also from `stdin:`), `run -dump`, `convert pb -outpbfile`, `help <command>`, and whatever else a tag has (`base64`, from v26.10.21).

Refused before the binary starts, with a message on stderr and exit code 1: `run` without `-test`/`-dump` (it would start a server; nothing can listen in WebAssembly), configs loaded from `http(s)://` URLs, `api …` subcommands (they talk gRPC to a running Xray), and `tls ping` (it opens a TCP connection). `xray help api` and `xray help tls ping` still print their help. Anything else that does not exit within `timeoutMs` (default 60 s) returns `timedOut: true`.

## One binary per release

The library ships **one** binary per tag: the tag's `main` package, built unmodified — the same `xray` you would build from that tag. `check()` is that binary run as `xray run -test -c config.json`.

The alternative was a second, smaller binary per tag: a wrapper that calls `serial.DecodeJSONConfig` → `Build()` → `core.New()` directly (`go/check`, kept for the comparison). The evidence, from `bun scripts/compare.ts` on v26.7.28 and v26.10.21 over the 14 smoke configs:

- **Every verdict is the same.**
- **Error text is identical** except for one layer of a decode failure, which the wrapper only imitated: the CLI says `failed to decode config: &{Name:config.json Format:json}`, the wrapper said `failed to decode config: config.json`. The CLI's text is the one a server prints.
- **The CLI binary is 0.5 MiB larger** (58.2 vs 57.6 MiB raw on v26.10.21, 12.0 vs 11.9 MiB gzip).

So one binary it is: one download serves both `check` and `run`, and what the check says is what the real CLI says. A small difference in behaviour: a panic now exits the process (`crashed`), as it would on a server, where the wrapper recovered it into an `error`. None of the smoke cases panics.

## Builds

Every Xray-core release from **v26.3.27** up, stable and prerelease, plus v26.10.10, whose tag was deleted upstream (built from commit `701af607`, channel `withdrawn`). All 16 build with Go 1.27.0 and pass the smoke tests; none is unsupported.

| Tag | Channel | Published | Raw | Download (gzip) |
|---|---|---|---|---|
| v26.10.21 | stable | 2026-10-21 | 58.2 MiB | 12.0 MiB |
| v26.10.10 | withdrawn | 2026-10-10 | 65.0 MiB | 13.1 MiB |
| v26.9.30 | prerelease | 2026-09-30 | 62.4 MiB | 12.5 MiB |
| v26.9.9 | prerelease | 2026-09-08 | 61.7 MiB | 12.4 MiB |
| v26.7.28 | prerelease | 2026-07-28 | 61.1 MiB | 12.2 MiB |
| v26.7.11 | prerelease | 2026-07-11 | 60.9 MiB | 12.2 MiB |
| v26.6.27 | prerelease | 2026-06-27 | 60.6 MiB | 12.1 MiB |
| v26.6.22 | prerelease | 2026-06-22 | 60.6 MiB | 12.1 MiB |
| v26.6.1 | prerelease | 2026-06-01 | 60.5 MiB | 12.1 MiB |
| v26.5.9 | prerelease | 2026-05-09 | 59.6 MiB | 12.0 MiB |
| v26.5.3 | prerelease | 2026-05-03 | 59.6 MiB | 12.0 MiB |
| v26.4.25 | prerelease | 2026-04-25 | 59.6 MiB | 12.0 MiB |
| v26.4.17 | prerelease | 2026-04-17 | 59.2 MiB | 11.9 MiB |
| v26.4.15 | prerelease | 2026-04-15 | 59.2 MiB | 11.9 MiB |
| v26.4.13 | prerelease | 2026-04-13 | 59.0 MiB | 11.8 MiB |
| v26.3.27 | stable | 2026-03-27 | 59.5 MiB | 11.9 MiB |

About 194 MiB in all, gzip only. The set is defined in [`versions.json`](versions.json) (`floor`, `extra`, and a snapshot of the GitHub releases); `bun scripts/versions.ts` prints it.

## Hosting

- **GitHub Pages: `https://bropines.github.io/xray-wasm/`** — every build, gzip copies only. GitHub Pages answers every file with `Access-Control-Allow-Origin: *` (checked with `curl -I` against existing `*.github.io` files, on 200 and on 404 responses), so a page on any origin can load from it. It serves `.gz` as a plain file, without `Content-Encoding`; the loader inflates it with `DecompressionStream`.
- **Release assets** — `manifest.json`, `wasm_exec.js`, `<tag>.xray.wasm.gz` (flat names; that manifest references them by asset name) and the npm tarball. Download URLs redirect to `release-assets.githubusercontent.com`, which sends **no** CORS headers, so a browser cannot load them cross-origin. Use them to mirror.
- **Self-host** — put a release's assets (or `bun scripts/publish.ts --pages <dir>`) in any static folder and point `baseUrl` at it. A host that keeps the uncompressed `.wasm` may list it as `rawFile`; it is used only where `DecompressionStream` is missing.

Bundlers: the worker is created with `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`, which Vite and webpack 5 pick up. With Vite, add `optimizeDeps: { exclude: ['xray-wasm'] }` so the worker file is not lost in pre-bundling; or pass `workerUrl` yourself (`xray-wasm/worker.js` is exported).

## Build locally

Needs Bun and Go 1.27, and a clone of Xray-core with its tags (it is read with `git archive`, never modified).

```sh
git clone https://github.com/XTLS/Xray-core.git ../Xray-core
bun install
bun scripts/build.ts --repo ../Xray-core --tags v26.10.21   # or no --tags: the whole set
bun scripts/smoke.ts                                        # every built tag
bun run typecheck && bun test && bun run build && npm pack
bun scripts/serve.ts                                        # examples/browser.html against dist-wasm/
```

Output: `dist-wasm/<tag>/xray.wasm`, `xray.wasm.gz`, `build.json`, plus `dist-wasm/wasm_exec.js` and `dist-wasm/manifest.json`. Binaries are never committed. Each build takes about half a minute once the module cache is warm.

How a tag is built: a scratch module requires `github.com/xtls/xray-core`, replaced by the tag's extracted source, with the tag's own `go.sum`, and runs `GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" github.com/xtls/xray-core/main`. `wasm_exec.js` is copied from the GOROOT that built the binaries — one from another Go release does not run them.

The js port of Go lacks a few names the core refers to, so a handful of files are **added** (never replaced) to packages for this build only, from [`go/shims`](go/shims): `syscall.RawSockaddrUnix`, `unix.Flock`, the writev/sendmsg names sing uses, and sing's `ToSockaddr`. Each file says why it cannot change a verdict: every one is behind a Linux-only branch or on the I/O path after `Start()`. A shim joins a build only when its package is in that tag's dependency graph (sing is gone from v26.9.30 on) and the tag is within its range in [`go/shims.json`](go/shims.json); `build.json` lists the shims each build got. The source code of Xray-core, the module cache and GOROOT are not touched.

## When Xray-core releases

[`upstream.yml`](.github/workflows/upstream.yml) runs weekly and by hand. It refreshes the release snapshot in `versions.json` from the GitHub API (`bun scripts/upstream.ts --write`), builds and smoke-tests any new tag, and opens a pull request — or an issue, when a new tag does not build or pass. Nothing is released automatically: merge the PR and push a tag of this repo, and [`release.yml`](.github/workflows/release.yml) builds every tag in parallel jobs, assembles the manifest, attaches the assets to a GitHub Release, and [`pages.yml`](.github/workflows/pages.yml) publishes them to Pages.

By hand: `bun scripts/upstream.ts --write`, then `bun scripts/build.ts --repo <clone> --tags <new tag>` and `bun scripts/smoke.ts --tags <new tag>`. If a smoke expectation changes because the core changed, update [`scripts/smoke-cases.ts`](scripts/smoke-cases.ts) and cite the source file and line, as the existing cases do. A tag that cannot be built goes into `unsupported` in `versions.json` with the reason.

## Prior art

- **[mmmray/xray-online](https://github.com/mmmray/xray-online)** (announced in [XTLS/Xray-core discussion #3779](https://github.com/XTLS/Xray-core/discussions/3779)) was first to put Xray's config parser in a browser. From its source: it pins one Xray-core tag (`xray-version.txt`: v24.12.31), applies `xray-wasm.patch` (47 files, mostly `//go:build !wasm` exclusions in `app/`, `transport/internet` and the Shadowsocks packages, plus edits in `infra/conf`), and its `main.go` decodes the JSON into `conf.Config` and calls `Build()` — not `core.New()` — with v2fly's geoip/geosite embedded in the binary. Last pushed in February 2025.
- **[remnawave/xray-monaco-editor](https://github.com/remnawave/xray-monaco-editor)** builds on that idea with a Monaco editor; its `go/` folder carries the same approach (a patch, 51 files, against v26.7.28; decode + `Build()`).

What this project does differently: unmodified upstream source at exact release tags (additions only, where the js port lacks a name), the full `run -test` path including `core.New()`, the real CLI, many releases side by side, and a fresh Go instance per call so one check can never depend on the one before it.

## License and credits

[MPL-2.0](LICENSE), the license of Xray-core. The binaries are built from unmodified [XTLS/Xray-core](https://github.com/XTLS/Xray-core) source at the release tags (and, for v26.10.10, commit `701af60772cda123492f86e383e1fdba066614a9`), with the shims in `go/shims`; `build.json` and the manifest record the commit of every build. Xray-core is the work of Project X and its contributors. `wasm_exec.js` is part of Go (BSD-3-Clause). The browser side started as the WASM checker of [Xray Config UI Editor](https://github.com/bropines/xray-config-ui-editor).
