# xray-wasm

**Собственная команда `xray` из Xray-core, собранная в WebAssembly из немодифицированных релизных тегов.** Веб-страница может проверить конфиг ровно так, как это делает `xray run -test` на сервере, и запускать офлайн-команды CLI (`x25519`, `uuid`, `vlessenc`, `tls cert`, …) — на любом из 16 релизов Xray-core, бок о бок.

[English version](README.md)

```ts
import { createXray } from 'xray-wasm';

const xray = createXray({ baseUrl: 'https://bropines.github.io/xray-wasm/' });

const result = await xray.check(configJson, { tag: 'v26.10.21' });
// { verdict: 'error', error: 'main: failed to load config files: [config.json] > … invalid "privateKey": …', … }

const keys = await xray.run(['x25519'], { tag: 'v26.10.21' });
console.log(keys.stdout); // PrivateKey: …  Password (PublicKey): …
```

Установка из tarball релиза (в npm-реестре пакета пока нет; зависимостей во время выполнения — ноль):

```sh
bun add https://github.com/bropines/xray-wasm/releases/download/v0.1.0/xray-wasm-0.1.0.tgz
```

## Выберите нужную версию

`manifest.json` перечисляет все сборки. Страница скачивает **только тот тег, который запросила** — один `.wasm.gz` примерно на 12 МиБ; он распаковывается в браузере, сверяется с sha256 из манифеста и компилируется один раз. Запросили другой тег — скачается и он; больше ничего не загружается.

```ts
const { builds } = await xray.manifest();     // [{ tag, version, channel, publishedAt, gzip, sha256, … }]
await xray.prepare('v26.7.28', (loaded, total) => showProgress(loaded / total)); // по желанию: скачать заранее
await xray.check(configJson, { tag: 'v26.7.28' });
```

## API

| | |
|---|---|
| `createXray({ baseUrl, fetch?, worker?, workerUrl? })` | `baseUrl` — папка с `manifest.json`. `fetch` — свой (авторизация, кэш, зеркало); все загрузки идут через него. `worker` (по умолчанию `true`) — работа в Web Worker, проверка никогда не блокирует страницу; без воркера (Node или `worker: false`) — в вызывающем потоке. |
| `xray.check(json, { tag, files?, timeoutMs? })` | `xray run -test -c config.json` с классификацией результата. Никогда не бросает исключений. |
| `xray.run(args, { tag, files?, stdin?, cwd?, timeoutMs? })` | Командная строка после `xray`. Возвращает `{ exitCode, stdout, stderr, files, durationMs, tag, timedOut?, stdoutBytes? }`; в `files` — то, что команда записала. Отклоняется, только если тег не удалось загрузить. |
| `xray.prepare(tag, onProgress?)` | Скачать и скомпилировать до первого вызова. Кэшируется. |
| `xray.manifest()`, `loadManifest(baseUrl, fetch?)` | Список сборок. |
| `xray.dispose()` | Завершить воркер, выбросить скомпилированные бинарники. |
| `ASSET_DIR` | `/usr/share/xray` — здесь ядро ищет `geoip.dat`, `geosite.dat` и файлы `ext:`. |

`files` — это пути и байты. Абсолютный путь берётся как есть; относительный для `check` кладётся в `ASSET_DIR` (так что `{ 'geosite.dat': bytes }` просто работает), для `run` — в рабочий каталог (по умолчанию `/work`).

### Вердикты

| `verdict` | Значение |
|---|---|
| `ok` | Ядро разобрало конфиг, собрало каждую часть и создало экземпляр: `Configuration OK.` |
| `error` | Ядро отказалось. В `error` — его собственное сообщение без префикса CLI `Failed to start:`. |
| `inconclusive` | Ядро отказалось после того, как искало файл, которого ему не дали (`missingFiles`: geo `.dat`, сертификат), или остановилось на части, которая собирается только на другой платформе (`skipped`). Отказ может быть ни о чём другом, поэтому ошибкой конфига он не считается. |
| `crashed` | Рантайм Go упал (panic). В `error` — хвост его вывода. |
| `timeout` | Нет ответа за `timeoutMs` (по умолчанию 30 с); воркер заменён. |
| `unavailable` | Нет сборки для этого тега, или окружение не смогло её загрузить. |

В каждом результате есть `log` (что напечатало ядро), `coreVersion`, `durationMs`, и `skipped`, когда часть конфига не проверялась.

## Что можно и чего нельзя проверить

Выполняется то же, что выполняет `xray run -test` в каждом собранном теге (`main/run.go`): разбор JSON (комментарии допустимы), `Build()` каждого inbound, outbound, транспорта, правила маршрутизации и приложения, затем `core.New()`, который создаёт все компоненты, не запуская их. Это ловит ошибки типов, неизвестные протоколы, удалённые возможности, неверные ключи (REALITY, VLESS Encryption, WireGuard), правила, ведущие в никуда, коды geosite, которых нет в файле, и всё остальное, от чего ядро отказывается при загрузке.

Не видно:

- **Ничего из того, что происходит в `Start()`**: занятые порты, сетевые интерфейсы, DNS, доступность сервера. Ничего не слушает и никуда не подключается.
- **Файлов, которые не переданы.** Передавайте `geoip.dat`/`geosite.dat` и сертификаты в `files`; отказ после отсутствующего файла — `inconclusive`, никогда не `error`.
- **Ветвей `Build()`, зависящих от операционной системы.** Ядро работает как `GOOS=js`, поэтому платформенные проверки (например, настройки tun только для Linux и Windows) не выполняются; об этом говорит `skipped`. До v26.6.1 включительно устройство tun открывается в `core.New()`, поэтому tun-inbound там — `inconclusive` («Tun is not supported on your platform»); начиная с v26.6.22 оно открывается в `Start()`.

## Командная строка

`run()` запускает настоящий CLI тега: argv, файловая система в памяти, которую команда может читать и писать, stdin и код выхода. Всё офлайновое работает как на сервере: `version`, `help`, `uuid`, `x25519`, `wg`, `mldsa65`, `mlkem768`, `vlessenc`, `tls cert` (`-file` пишет `name.crt`/`name.key`, они вернутся в `files`), `tls hash`, `run -test` (в том числе из `stdin:`), `run -dump`, `convert pb -outpbfile`, `help <команда>` и всё, что ещё есть в теге (`base64` — с v26.10.21).

Отклоняется до запуска бинарника, с сообщением в stderr и кодом выхода 1: `run` без `-test`/`-dump` (он запустил бы сервер, а в WebAssembly ничего не может слушать), конфиги по `http(s)://`-адресам, подкоманды `api …` (они ходят по gRPC в работающий Xray) и `tls ping` (открывает TCP-соединение). `xray help api` и `xray help tls ping` по-прежнему печатают справку. Всё прочее, что не завершилось за `timeoutMs` (по умолчанию 60 с), возвращает `timedOut: true`.

## Один бинарник на релиз

Библиотека поставляет **один** бинарник на тег: пакет `main` этого тега, собранный без изменений, — тот же `xray`, который вы собрали бы из тега сами. `check()` — это он же, запущенный как `xray run -test -c config.json`.

Альтернатива — второй, чуть меньший бинарник на тег: обёртка, которая сама вызывает `serial.DecodeJSONConfig` → `Build()` → `core.New()` (`go/check`, оставлена для сравнения). Доказательства — `bun scripts/compare.ts` на v26.7.28 и v26.10.21 по 14 smoke-конфигам:

- **Все вердикты совпадают.**
- **Текст ошибок совпадает**, кроме одного слоя ошибки разбора, который обёртка лишь имитировала: CLI пишет `failed to decode config: &{Name:config.json Format:json}`, обёртка писала `failed to decode config: config.json`. Текст CLI — тот, что печатает сервер.
- **Бинарник CLI больше на 0,5 МиБ** (58,2 против 57,6 МиБ на v26.10.21, в gzip 12,0 против 11,9 МиБ).

Поэтому — один бинарник: одна загрузка обслуживает и `check`, и `run`, а проверка говорит ровно то, что сказал бы настоящий CLI. Небольшое отличие в поведении: panic теперь завершает процесс (`crashed`), как на сервере, а обёртка перехватывала её и возвращала `error`. Ни один smoke-случай не паникует.

## Сборки

Все релизы Xray-core начиная с **v26.3.27**, стабильные и предварительные, плюс v26.10.10, чей тег удалён в апстриме (собирается из коммита `701af607`, канал `withdrawn`). Все 16 собираются Go 1.27.0 и проходят smoke-тесты; неподдерживаемых нет.

| Тег | Канал | Опубликован | Размер | Загрузка (gzip) |
|---|---|---|---|---|
| v26.10.21 | stable | 2026-10-21 | 58,2 МиБ | 12,0 МиБ |
| v26.10.10 | withdrawn | 2026-10-10 | 65,0 МиБ | 13,1 МиБ |
| v26.9.30 | prerelease | 2026-09-30 | 62,4 МиБ | 12,5 МиБ |
| v26.9.9 | prerelease | 2026-09-08 | 61,7 МиБ | 12,4 МиБ |
| v26.7.28 | prerelease | 2026-07-28 | 61,1 МиБ | 12,2 МиБ |
| v26.7.11 | prerelease | 2026-07-11 | 60,9 МиБ | 12,2 МиБ |
| v26.6.27 | prerelease | 2026-06-27 | 60,6 МиБ | 12,1 МиБ |
| v26.6.22 | prerelease | 2026-06-22 | 60,6 МиБ | 12,1 МиБ |
| v26.6.1 | prerelease | 2026-06-01 | 60,5 МиБ | 12,1 МиБ |
| v26.5.9 | prerelease | 2026-05-09 | 59,6 МиБ | 12,0 МиБ |
| v26.5.3 | prerelease | 2026-05-03 | 59,6 МиБ | 12,0 МиБ |
| v26.4.25 | prerelease | 2026-04-25 | 59,6 МиБ | 12,0 МиБ |
| v26.4.17 | prerelease | 2026-04-17 | 59,2 МиБ | 11,9 МиБ |
| v26.4.15 | prerelease | 2026-04-15 | 59,2 МиБ | 11,9 МиБ |
| v26.4.13 | prerelease | 2026-04-13 | 59,0 МиБ | 11,8 МиБ |
| v26.3.27 | stable | 2026-03-27 | 59,5 МиБ | 11,9 МиБ |

Всего около 194 МиБ, только gzip. Набор задаётся в [`versions.json`](versions.json) (`floor`, `extra` и снимок релизов GitHub); `bun scripts/versions.ts` печатает его.

## Где брать бинарники

- **GitHub Pages: `https://bropines.github.io/xray-wasm/`** — все сборки, только gzip-копии. GitHub Pages отвечает на любой файл с `Access-Control-Allow-Origin: *` (проверено `curl -I` на существующих файлах `*.github.io`, и на 200, и на 404), так что загружать оттуда может страница с любого origin. `.gz` отдаётся как обычный файл, без `Content-Encoding`; загрузчик распаковывает его через `DecompressionStream`.
- **Ассеты релиза** — `manifest.json`, `wasm_exec.js`, `<tag>.xray.wasm.gz` (плоские имена; манифест релиза ссылается на них по имени ассета) и npm-tarball. Ссылки на загрузку перенаправляют на `release-assets.githubusercontent.com`, который **не** отдаёт CORS-заголовков, поэтому браузер не загрузит их с другого origin. Они нужны для зеркал.
- **Свой хостинг** — положите ассеты релиза (или результат `bun scripts/publish.ts --pages <dir>`) в любую статическую папку и укажите её в `baseUrl`. Хост, где лежит и несжатый `.wasm`, может указать его в `rawFile`; он используется, только если нет `DecompressionStream`.

Сборщики: воркер создаётся как `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`, это понимают Vite и webpack 5. В Vite добавьте `optimizeDeps: { exclude: ['xray-wasm'] }`, чтобы файл воркера не потерялся при пре-бандлинге, или передайте `workerUrl` сами (`xray-wasm/worker.js` экспортируется).

## Локальная сборка

Нужны Bun, Go 1.27 и клон Xray-core с тегами (он читается через `git archive` и никогда не меняется).

```sh
git clone https://github.com/XTLS/Xray-core.git ../Xray-core
bun install
bun scripts/build.ts --repo ../Xray-core --tags v26.10.21   # без --tags — весь набор
bun scripts/smoke.ts                                        # все собранные теги
bun run typecheck && bun test && bun run build && npm pack
bun scripts/serve.ts                                        # examples/browser.html против dist-wasm/
```

Результат: `dist-wasm/<tag>/xray.wasm`, `xray.wasm.gz`, `build.json`, а также `dist-wasm/wasm_exec.js` и `dist-wasm/manifest.json`. Бинарники никогда не коммитятся. Сборка тега занимает около полуминуты при прогретом кэше модулей.

Как собирается тег: временный модуль требует `github.com/xtls/xray-core`, заменённый (`replace`) распакованным исходником тега, с собственным `go.sum` тега, и выполняет `GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" github.com/xtls/xray-core/main`. `wasm_exec.js` копируется из того GOROOT, которым собраны бинарники: файл из другого релиза Go их не запустит.

В js-порте Go нет нескольких имён, на которые ссылается ядро, поэтому в пакеты только для этой сборки **добавляется** (никогда не заменяется) несколько файлов из [`go/shims`](go/shims): `syscall.RawSockaddrUnix`, `unix.Flock`, имена writev/sendmsg, которыми пользуется sing, и `ToSockaddr` из sing. В каждом файле объяснено, почему он не может изменить вердикт: все они стоят за веткой только для Linux или на пути ввода-вывода после `Start()`. Шим попадает в сборку, только если его пакет есть в графе зависимостей тега (sing исчез начиная с v26.9.30) и тег входит в его диапазон в [`go/shims.json`](go/shims.json); `build.json` перечисляет шимы каждой сборки. Исходный код Xray-core, кэш модулей и GOROOT не трогаются.

## Когда выходит релиз Xray-core

[`upstream.yml`](.github/workflows/upstream.yml) запускается еженедельно и вручную. Он обновляет снимок релизов в `versions.json` из GitHub API (`bun scripts/upstream.ts --write`), собирает и прогоняет smoke-тесты для каждого нового тега и открывает pull request — или issue, если новый тег не собрался или не прошёл тесты. Автоматически ничего не публикуется: слейте PR и запушьте тег этого репозитория, тогда [`release.yml`](.github/workflows/release.yml) соберёт все теги параллельными джобами, сложит манифест и приложит ассеты к GitHub Release, а [`pages.yml`](.github/workflows/pages.yml) опубликует их на Pages.

Вручную: `bun scripts/upstream.ts --write`, затем `bun scripts/build.ts --repo <клон> --tags <новый тег>` и `bun scripts/smoke.ts --tags <новый тег>`. Если ожидание smoke-теста изменилось, потому что изменилось ядро, обновите [`scripts/smoke-cases.ts`](scripts/smoke-cases.ts) со ссылкой на файл и строку исходника, как в существующих случаях. Тег, который не собирается, заносится в `unsupported` в `versions.json` с причиной.

## Предшественники

- **[mmmray/xray-online](https://github.com/mmmray/xray-online)** (анонс — [обсуждение XTLS/Xray-core #3779](https://github.com/XTLS/Xray-core/discussions/3779)) первым перенёс разбор конфигов Xray в браузер. По его исходникам: он закрепляет один тег Xray-core (`xray-version.txt`: v24.12.31), применяет `xray-wasm.patch` (47 файлов, в основном исключения `//go:build !wasm` в `app/`, `transport/internet` и пакетах Shadowsocks, плюс правки в `infra/conf`), а его `main.go` разбирает JSON в `conf.Config` и вызывает `Build()` — без `core.New()`, — со встроенными в бинарник geoip/geosite от v2fly. Последний push — февраль 2025.
- **[remnawave/xray-monaco-editor](https://github.com/remnawave/xray-monaco-editor)** развивает эту идею с редактором Monaco; в его папке `go/` тот же подход (патч на 51 файл против v26.7.28; разбор + `Build()`).

Чем отличается этот проект: немодифицированный исходник апстрима на точных релизных тегах (только добавления там, где в js-порте нет имени), полный путь `run -test` вместе с `core.New()`, настоящий CLI, много релизов бок о бок и свежий экземпляр Go на каждый вызов, чтобы одна проверка никогда не зависела от предыдущей.

## Лицензия и благодарности

[MPL-2.0](LICENSE) — лицензия Xray-core. Бинарники собираются из немодифицированного исходника [XTLS/Xray-core](https://github.com/XTLS/Xray-core) на релизных тегах (а для v26.10.10 — из коммита `701af60772cda123492f86e383e1fdba066614a9`) с шимами из `go/shims`; `build.json` и манифест записывают коммит каждой сборки. Xray-core — работа Project X и его участников. `wasm_exec.js` — часть Go (BSD-3-Clause). Браузерная часть выросла из WASM-проверки [Xray Config UI Editor](https://github.com/bropines/xray-config-ui-editor).
