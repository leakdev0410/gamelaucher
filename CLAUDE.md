# CLAUDE.md

Architecture map for this repo so a fresh session has context without re-scanning all of `src/`.
Conventions live in `.cursorrules` (read it too) — key ones summarized at the bottom.

## What this is

**Hydra** — an Electron game launcher (Steam-like): browse a catalogue, download games via
torrent/debrid/hosters, manage a library, track playtime & achievements, and sync saves. (Friends/social
were stripped from this fork — see fork traits.)

This checkout is a **personal fork** (`package.json` name `gamelaucher`, version 3.9.8, author "Lê Quân";
upstream remote still `hydralauncher/hydra`). Key fork traits to keep in mind:

- **Torrent RPC migrated Python → Go.** Upstream `python_rpc/` is deleted. The Go RPC source lives in
  `go_rpc/` and is built into `gamelaucher-go-rpc/gamelaucher-go-rpc.exe`. **But the code that spawns it
  is still named `PythonRPC` / `python-rpc.ts`** (only the binary path changed). Error strings still say
  "Hydra Python Instance". Treat "PythonRPC" as "the Go torrent RPC".
- **Big Picture mode removed.** Upstream's `src/big-picture/` gamepad/TV app is **entirely deleted** — no
  files, no `/big-picture/*` routes, no `big-picture` IPC events, no `dev:big-picture` script. The renderer
  is Redux-only now; ignore any lingering upstream references to Zustand or spatial-focus navigation.
- **Portable storage.** DB, saves and the default download dir live **next to the executable**, NOT in the
  system `userData` folder (see `src/main/constants.ts`): LevelDB at `<exe>/save/dp`, saves at `<exe>/save`,
  default downloads at `<exe>/game`. `executableBaseDir` = `PORTABLE_EXECUTABLE_DIR` in a portable build,
  the install dir when installed, the project root in dev. Logs/Backups/Assets/CommonRedist still live
  under `userData`.
- **Rebranded to "Game Launcher"** (window title in renderer is hardcoded).
- **Fork-added features**: a pure-Node HTTP downloader (`js-http-downloader.ts`), multi download-directory
  support (`shared/download-directories.ts`), cross-drive game transfer (`transferGameFiles`), a Vietnamese
  locale (`src/locales/vi`). Hand-added preload APIs are below the `//UPDATEDD` comment (line ~850) in
  `src/preload/index.ts`.
- **`go_defender/` is a standalone tool, not part of the app.** A one-shot Windows utility (Go; prebuilt
  `setup.exe`) that adds a folder to the Windows Defender exclusion list — self-elevates via UAC and calls
  `Add-MpPreference`. It has **no** yarn build script and is **not** spawned by the app; run it manually.
- **Upstream Hydra features stripped + de-branded in this fork.** Removed entirely: the **WorkWonders**
  changelog ("Welcome back" modal) / help-center / feedback widgets; the **Hydra Decky** (Steam Deck) plugin
  installer; the **Nimbus** debrid downloader (`Downloader.Hydra`); **all friends/social** (friend requests,
  activity, notifications, WS events); and the **hydrathemes.shop** online theme store (the local theme
  editor / paste-CSS import are kept). Dead deps removed: `workwonders-sdk`, `zustand`,
  `@atlaskit/pragmatic-drag-and-drop` (run `yarn install` to prune the lockfile). Internal identifiers
  de-branded: `HydraApi`→`ApiClient` (file `services/api-client.ts`, renderer bridge `window.electron.api`,
  IPC channel `apiCall`), `HydraIcon`→`PointsIcon` (octopus → neutral `star.svg`), `hydra_cloud`→`cloud_save`,
  `hydra:`→`gl:` CustomEvents, `data-hydra-dialog`→`data-gl-dialog`, plus the Sentry release tag and the
  outbound `User-Agent` strings. The **auto-updater is fully removed** (`electron-updater` dep, the
  `UpdateManager` service, the `events/autoupdater/*` handlers, and the `hydralauncher/hydra` GitHub update
  feed) — the fork no longer self-updates from upstream. The **Rust native addon is removed** too (the
  `native/` crate, `build:native` / `scripts/build-native-addon.cjs`, and the `hydra-native` packaging entry);
  `services/native-addon.ts` is now a pure-TS no-op stub, so playtime / running-game detection
  (`process-watcher`), in-app game-close, and native profile-image processing are **disabled** (images pass
  through unprocessed). The non-native `game-executables.json` lookup used for library scanning still works.
- **Irreducible Hydra coupling that REMAINS (the backend was deliberately kept).** Server contracts, not
  branding — can't be removed without replacing or cutting the backend: the `appConfig` server URLs in
  `src/shared/config.ts` (`*.hydralauncher.gg`, `losbroxas.org`); the `hydralauncher://` protocol (auth
  callback + game-shortcut URLs — must match the auth server); the `Hydra-If-Modified-Since` request header the
  API reads; the `hydralauncher/hydra-common-redist` download URL; and the `hydraScore` catalogue API sort key.
  Unused i18n keys for removed features remain in `src/locales/*` (harmless).

## Tech stack

Electron 39 · TypeScript (strict) · electron-vite + electron-builder · React 18 · Redux Toolkit ·
React Router v6 · `classic-level` (LevelDB, the ONLY persistence — no SQL) · i18next (34 locales) ·
`@protobuf-ts` (WebSocket message framing only, NOT gRPC) · Sass · Yarn 1.

## Commands

```
yarn dev              # run app (electron-vite dev)
yarn build            # typecheck + electron-vite build
yarn build:go-rpc     # build Go torrent RPC: go_rpc/ -> gamelaucher-go-rpc/gamelaucher-go-rpc.exe
yarn build:win|mac|linux   # build:go-rpc + vite build + electron-builder
yarn build:unpack     # build + build:go-rpc + electron-builder --dir + set-win-icon.cjs
yarn typecheck        # tsc for node + web projects (run after changes)
yarn lint             # eslint --fix
yarn format           # prettier --write .
yarn protoc           # regen src/main/generated/* from proto/*.proto (proto/ is now empty — effectively unused)
```

`go_defender/` has no yarn script — build it manually with `cd go_defender && go build`.

## Repo layout (top level)

- `src/` — all app code (see below).
- `go_rpc/` — **Go source** for the torrent RPC (`main.go`, `torrent_downloader.go`).
- `gamelaucher-go-rpc/` — **built Go binary** the app spawns at runtime.
- `go_defender/` — standalone Windows Defender-exclusion tool (`main.go` + prebuilt `setup.exe`); not wired into build/app.
- `binaries/`, `ludusavi/` — bundled binaries; `proto/` — protobuf defs (now empty). (The `native/` Rust addon was removed.)
- `scripts/` — `set-win-icon.cjs` is wired as the electron-builder `afterPack` hook; `upload-build.cjs` and
  `postinstall.cjs` are manual/not wired (see gotchas).
- `resources/`, `build/`, `electron-builder.yml` — packaging.

## Import aliases

`@main` → `src/main` · `@renderer` → `src/renderer/src` · `@shared` → `src/shared` ·
`@types` → `src/types` (tsconfig path) · `@locales` → `src/locales` · `@resources` → `resources`.
(Defined in `electron.vite.config.ts` + tsconfig.)

## src/ structure

| Area        | Role                                                                        |
| ----------- | --------------------------------------------------------------------------- |
| `main/`     | Electron main process (backend). ~271 files.                                |
| `renderer/` | Main React UI. ~293 files.                                                  |
| `preload/`  | `window.electron` IPC bridge (single file `index.ts`, ~868 lines).          |
| `shared/`   | Code shared by main+renderer: enums, helpers, download-directories, config. |
| `types/`    | TypeScript type definitions (`@types`).                                     |
| `locales/`  | 34 languages × `translation.json` (i18n; fork added `vi`).                  |

## Core data contracts (read these first when touching data)

- `src/types/level.types.ts` — **what LevelDB stores**: `Game`, `Download`, `UserPreferences`,
  `GameAchievement`, `DownloadLayoutState`, `Auth`, `Subscription`, `ScreenState`.
- `src/main/constants.ts` — **runtime paths (portable layout — see fork traits)**: `executableBaseDir`,
  `levelDatabasePath` (`<exe>/save/dp`), `savesPath` (`<exe>/save`), `defaultDownloadsPath` (`<exe>/game`).
- `src/shared/constants.ts` — `Downloader` enum (13: RealDebrid, Torrent, Gofile, PixelDrain, Datanodes,
  Mediafire, TorBox, Buzzheavier, FuckingFast, VikingFile, Rootz, Premiumize, AllDebrid — numeric values are
  **pinned explicitly with a gap at 7** where Hydra/Nimbus was removed, so persisted `download.downloader`
  numbers keep their meaning), `Cracker` (15), `DownloadError`, `SteamContentDescriptor`, `AuthPage`.
- `src/shared/index.ts` — `getDownloadersForUri()` (URI → which downloaders can handle it),
  `formatName/formatBytes/parseBytes`.
- `src/shared/config.ts` — `appConfig`: hardcoded service URLs (api/auth/ws/nimbus/external resources).
  `launcherSubdomain` is now `""`, so the packaged app loads the **local** bundled renderer instead of
  Hydra's remote renderer-by-version. Replaced the old `MAIN_VITE_*`/`RENDERER_VITE_*` env vars so builds are
  self-contained and need no `.env`. Edit here to point at different servers.
- `src/types/index.ts` — API/UI DTOs (catalogue, profile, achievements, notifications, etc.). Type defs are
  split across `index.ts`, `download.types.ts`, `download-contract.ts`, `game.types.ts`, `steam.types.ts`,
  `theme.types.ts`, `ludusavi.types.ts`, `how-long-to-beat.types.ts`.
- `src/types/download-contract.ts` — download placement/bucket helpers.
- `src/preload/index.ts` — the entire IPC surface (`window.electron.*`).

## Main process (`src/main`)

**Bootstrap**: `index.ts` (single-instance lock, `hydralauncher://` deep links, `local:`/`gradient:`
protocols) → `main.ts:loadState()` (LevelDB lock, authorize debrid clients, `ApiClient.setupApi()`,
library sync, WS connect, `DownloadOrchestrator.bootstrapDownloadsOnStartup()`, start Go RPC,
`startMainLoop()` — a 2s polling loop in `services/main-loop.ts`).

**Download system (the core; two transports):**

- Dispatch in `services/download/download-manager.ts`, keyed on `download.downloader`.
  - `Downloader.Torrent` → **Go RPC** (`services/python-rpc.ts` spawns `gamelaucher-go-rpc`; JSON over
    stdin/stdout, NOT gRPC; BitTorrent port 5881; random rpcPassword). Methods: `status`, `seed_status`,
    `torrent_files`, `action`.
  - everything else → **`services/download/js-http-downloader.ts`** (pure Node fetch + Range resume +
    stall detection + retry backoff + token-bucket throttle).
- `services/download-orchestrator.ts` = public facade: queue/layout management (order persisted in
  LevelDB `downloadLayoutState`), pause/cancel/resume, startup bootstrap.
- URL resolvers per provider: `services/download/{real-debrid,all-debrid,premiumize,torbox}.ts`
  and `services/hosters/{gofile,pixeldrain,datanodes,buzzheavier,fuckingfast,mediafire,vikingfile,rootz}.ts`.
  AllDebrid has a special multi-file batch path (`runAllDebridBatch`).
- Post-download: `services/game-files-manager.ts` (7-Zip extract w/ passwords `online-fix.me`,
  `steamrip.com`; auto-detect exe; create shortcut).
- Note: `getDownloadPayload()` for HTTP downloaders is **dead code** from the all-RPC era.

**Persistence — LevelDB** (`src/main/level`, `classic-level` at **`<exe>/save/dp`** — portable, next to the
executable, NOT the system `userData` folder): root keys `auth`, `user`, `userPreferences`, `language`,
`rpcPassword`. Sublevels: `games`, `downloads`, `downloadLayoutState`, `gameShopAssets` (8h TTL),
`gameShopCache`, `gameStatsAssets` (30m TTL), `gameAchievements`, `downloadSources`, `themes`,
`localNotifications`. Renderer reads/writes sublevels directly via the `leveldb*` IPC bridge.

**IPC events** (`src/main/events`, ~136 handlers): registered via `registerEvent` (deep-clones results
through JSON). Grouped by folder: `auth`, `catalogue`, `cloud-save`, `download-sources`, `library`
(largest — launch/close game, Proton/Wine/MangoHUD/GameMode, shortcuts, scan, cross-drive transfer),
`torrenting` (download/queue/seed control), `themes`, `user-preferences`, `user`, `leveldb`,
`notifications`, `profile`, `misc`, `hardware`, `helpers`.

**Other services** (`src/main/services`): `window-manager` (windows; patches CORS/User-Agent headers;
loads the **local bundled renderer** — the remote-renderer-by-version path is disabled now that
`appConfig.launcherSubdomain` is `""`), `process-watcher` (game playtime / running-game detection —
now **disabled**: its native process-listing addon was removed, so `services/native-addon.ts` is a no-op
stub), `achievements/*` (scan cracker files → parse → merge with
remote → notify), `cloud-sync` (Ludusavi → tar to `savesPath` = `<exe>/save`, **local only** despite the
"cloud" name — the `cloud-save` events now do full local-artifact management: list / preview / download /
delete / upload via `get-game-artifacts`, `get-game-backup-preview`, `download-game-artifact`,
`delete-game-artifact`, `upload-save-game`), `library-sync/*` (sync with Hydra API), `ws/ws-client`
(WebSocket, protobuf `Envelope` framing, exponential reconnect), `hosters/*`, `api-client.ts` (`ApiClient` — JWT REST
client w/ refresh).

## Renderer (`src/renderer/src`)

- **Bootstrap** `main.tsx` (Sentry, i18next, cookie→localStorage shim) → `Redux Provider → HashRouter →
App` shell (Sidebar + Header + Outlet + BottomPanel).
- **Routes**: `/`, `/catalogue`, `/library`, `/downloads`, `/game/:shop/:objectId`, `/settings`,
  `/achievements`, `/notifications`; standalone: `/theme-editor`, `/achievement-notification`,
  `/game-launcher`. (No profile or big-picture routes — `profile`/`user` IPC events still exist in main,
  but there is no profile page in the renderer.)
- **State (`store.ts`)**: 9 Redux slices in `features/` — `window`, `library`, `userPreferences`,
  `download` (tracks speed history/peaks), `toast`, `userDetails`, `gameRunning`, `catalogueSearch`,
  `collections`. (Upstream `subscription` and `repacks` slices are gone.)
- **IPC**: everything via `window.electron` (no raw `ipcRenderer`). Two embedded clients: `api`
  (REST proxy, `needsAuth`/`needsSubscription` flags) and `leveldb` (generic CRUD). `on*` subscriptions
  return an unsubscribe fn. `levelDBService` wraps the leveldb bridge.
- **IPC-wrapping hooks** (`hooks/`): `useDownload`, `useLibrary`, `useUserDetails`, `useGameActions`,
  `useDownloadLayout`, `useCatalogue`, `useGameCollections`, `useFeature`.
- **Contexts** (per-page): `GameDetailsContext`, `CloudSyncContext`, `SettingsContext`.
- Intra-renderer bus uses `window` `CustomEvent`s (`hydra:openGameOptions`, …).

## Conventions (from `.cursorrules`)

- **Logging**: use `logger`, never `console`. Main: `import { logger } from "@main/services"`. Renderer:
  `import { logger } from "@renderer/logger"`.
- **i18n**: no hardcoded user-facing strings; `useTranslation("ns")`; add keys to
  `src/locales/en/translation.json`.
- **Types**: `T[]` not `Array<T>`. Prefer named exports for utils/services. async/await over `.then`.
- **ESLint**: fix properly before disabling; if disabling, comment why.
- After code changes run `yarn typecheck` (and `yarn lint`).

## Known tech debt / gotchas

- "PythonRPC" naming is the Go RPC (see top).
- Dead code: `getDownloadPayload()` has unreachable HTTP switch branches (download-manager) — only the torrent path is live.
- `CloudSync` is local-only despite the name (writes tars to `savesPath` = `<exe>/save`, **not** `~/Documents/HydraSaves`).
- `scripts/postinstall.cjs` is NOT wired (no `postinstall` script in package.json) and is effectively dead now that the Rust native addon it built has been removed.
- `@protobuf-ts/runtime` (used by `generated/envelope.ts`) is only present transitively via the `@protobuf-ts/plugin` devDep — should be a direct dependency.
- `build:go-rpc` always outputs `gamelaucher-go-rpc.exe` even on Linux; CI now installs Go (`setup-go`) but cross-platform Go binary naming/packaging may still need work.
- `go_defender/` is unreferenced by the app/build — a manual standalone utility (see fork traits).
