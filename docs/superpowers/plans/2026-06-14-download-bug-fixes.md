# Download System Bug Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 bugs in the download system: stuck queue after JS download failure, Real-Debrid not polling magnets, AllDebrid batch silent failure, float comparison for progress, double error handler call, and no rollback on activate failure.

**Architecture:** All fixes are localized to 4 files: `download-manager.ts`, `real-debrid.ts`, `js-http-downloader.ts`, `download-orchestrator.ts`. No new files. No circular dependency changes.

**Tech Stack:** TypeScript, Node.js streams, axios, LevelDB

---

## File Structure

| File | Changes |
|------|---------|
| `src/main/services/download/download-manager.ts` | Fix 1 (stuck queue), Fix 3 (AllDebrid silent fail), Fix 4 (float comparison) |
| `src/main/services/download/real-debrid.ts` | Fix 2 (polling loop) |
| `src/main/services/download/js-http-downloader.ts` | Fix 5 (double error call) |
| `src/main/services/download-orchestrator.ts` | Fix 6 (rollback on activate failure) |

---

### Task 1: Fix JS download error not resetting `downloadingGameId` (stuck queue)

**Files:**
- Modify: `src/main/services/download/download-manager.ts:1296-1301`
- Modify: `src/main/services/download/download-manager.ts:1276-1277`

**Problem:** When `jsDownloader.startDownload(options)` fails permanently, the `.catch()` nulls `jsDownloader` but leaves `downloadingGameId` set. The `watchDownloads()` poll sees `downloadingGameId != null` but `jsDownloader == null` → returns early forever. The download is stuck and no queue processing happens.

- [ ] **Step 1: Fix the `.catch()` handler for regular JS downloads**

Replace lines 1296-1301 with a `.catch()` that resets all state and triggers failure handling.

In `src/main/services/download/download-manager.ts`, find the block starting at line 1296:

```typescript
          this.jsDownloader.startDownload(options).catch((err) => {
            logger.error("[DownloadManager] JS download error:", err);
            this.usingJsDownloader = false;
            this.jsDownloader = null;
            this.allDebridBatch = null;
          });
```

Replace with:

```typescript
          this.jsDownloader.startDownload(options).catch(async (err) => {
            logger.error("[DownloadManager] JS download error:", err);
            this.usingJsDownloader = false;
            this.jsDownloader = null;
            this.allDebridBatch = null;
            this.isPreparingDownload = false;
            this.downloadingGameId = null;
            WindowManager.sendToAppWindows("on-download-progress", null);
            WindowManager.mainWindow?.setProgressBar(-1);

            try {
              await downloadsSublevel.put(downloadId, {
                ...download,
                status: "error",
                queued: false,
                pinnedToHero: false,
              });
              WindowManager.sendDownloadsUpdated();
            } catch (dbErr) {
              logger.error(
                "[DownloadManager] Failed to persist error status",
                dbErr
              );
            }

            void this.processNextQueuedDownload();
          });
```

- [ ] **Step 2: Fix AllDebrid batch `.catch()` missing — same pattern**

Replace lines 1276-1277:

```typescript
          this.isPreparingDownload = false;
          void this.runAllDebridBatch();
```

Replace with:

```typescript
          this.isPreparingDownload = false;
          void this.runAllDebridBatch().catch(async (err) => {
            logger.error(
              "[DownloadManager] AllDebrid batch error:",
              err
            );
            this.usingJsDownloader = false;
            this.jsDownloader = null;
            this.allDebridBatch = null;
            this.isPreparingDownload = false;
            this.downloadingGameId = null;
            WindowManager.sendToAppWindows("on-download-progress", null);
            WindowManager.mainWindow?.setProgressBar(-1);

            try {
              await downloadsSublevel.put(downloadId, {
                ...download,
                status: "error",
                queued: false,
                pinnedToHero: false,
              });
              WindowManager.sendDownloadsUpdated();
            } catch (dbErr) {
              logger.error(
                "[DownloadManager] Failed to persist error status",
                dbErr
              );
            }

            void this.processNextQueuedDownload();
          });
```

- [ ] **Step 3: Run typecheck**

```bash
yarn typecheck
```

Expected: No new type errors. `WindowManager` and `downloadsSublevel` are already imported.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/download/download-manager.ts
git commit -m "fix: reset downloadingGameId on JS download failure, prevent stuck queue"
```

---

### Task 2: Add polling loop to Real-Debrid magnet downloads

**Files:**
- Modify: `src/main/services/download/real-debrid.ts:89-121`

**Problem:** `getDownloadUrl()` checks magnet status exactly once. If the magnet is still downloading, it returns `null` → `NotCachedOnRealDebrid` error. Premiumize and AllDebrid both poll until ready. Real-Debrid needs the same.

- [ ] **Step 1: Add polling constants to `RealDebridClient`**

In `src/main/services/download/real-debrid.ts`, add these constants right after the class declaration line (`export class RealDebridClient {`):

```typescript
  private static readonly TORRENT_POLL_INTERVAL_MS = 5000;
  private static readonly TORRENT_MAX_ATTEMPTS = 120; // 10 minutes
```

- [ ] **Step 2: Add `waitForTorrentDownload` method**

Add the following method to the `RealDebridClient` class (after the existing methods, before `getDownloadUrl`):

```typescript
  private static async waitForTorrentDownload(
    torrentId: string
  ): Promise<RealDebridTorrentInfo> {
    for (
      let attempt = 1;
      attempt <= this.TORRENT_MAX_ATTEMPTS;
      attempt++
    ) {
      const torrentInfo = await this.getTorrentInfo(torrentId);

      if (torrentInfo.status === "downloaded") {
        return torrentInfo;
      }

      if (
        torrentInfo.status === "error" ||
        torrentInfo.status === "virus" ||
        torrentInfo.status === "dead" ||
        torrentInfo.status === "magnet_error"
      ) {
        throw new Error(
          `[RealDebrid] Torrent ${torrentId} failed: ${torrentInfo.status}`
        );
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.TORRENT_POLL_INTERVAL_MS)
      );
    }

    throw new Error(
      `[RealDebrid] Torrent ${torrentId} timed out after ${this.TORRENT_MAX_ATTEMPTS} attempts`
    );
  }
```

- [ ] **Step 3: Modify `getDownloadUrl` to use polling**

Replace lines 96-114 (the block starting with `if (realDebridTorrentId) {` through `return null;`):

Current code:
```typescript
    if (realDebridTorrentId) {
      let torrentInfo = await this.getTorrentInfo(realDebridTorrentId);

      if (torrentInfo.status === "waiting_files_selection") {
        await this.selectAllFiles(realDebridTorrentId);

        torrentInfo = await this.getTorrentInfo(realDebridTorrentId);
      }

      const { links, status } = torrentInfo;

      if (status === "downloaded") {
        const [link] = links;

        const { download } = await this.unrestrictLink(link);
        return decodeURIComponent(download);
      }

      return null;
    }
```

Replace with:
```typescript
    if (realDebridTorrentId) {
      let torrentInfo = await this.getTorrentInfo(realDebridTorrentId);

      if (torrentInfo.status === "waiting_files_selection") {
        await this.selectAllFiles(realDebridTorrentId);

        torrentInfo = await this.getTorrentInfo(realDebridTorrentId);
      }

      if (torrentInfo.status !== "downloaded") {
        torrentInfo = await this.waitForTorrentDownload(realDebridTorrentId);
      }

      const [link] = torrentInfo.links;
      const { download } = await this.unrestrictLink(link);
      return decodeURIComponent(download);
    }
```

- [ ] **Step 4: Run typecheck**

```bash
yarn typecheck
```

Expected: No new type errors. `RealDebridTorrentInfo` is already imported from `@types`.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/download/real-debrid.ts
git commit -m "fix: add polling loop for Real-Debrid magnet downloads"
```

---

### Task 3: Fix AllDebrid batch silent failure not notifying orchestrator

**Files:**
- Modify: `src/main/services/download/download-manager.ts:887-957`

**Problem:** `runAllDebridBatch()` calls `cleanupBatch()` on error which nulls everything but never sets the download to "error" in LevelDB and never starts the next queued download.

**Note:** This is partially addressed by Task 1 Step 2 (the `.catch()` on `runAllDebridBatch()`), but `cleanupBatch()` is also called from within `runAllDebridBatch()` on entry errors and size mismatches. Those internal calls won't reach the outer `.catch()`. We need to add failure notification in `cleanupBatch()` itself.

- [ ] **Step 1: Redesign `cleanupBatch` to handle failure properly**

`cleanupBatch` is called in error paths inside `runAllDebridBatch` where we don't have direct access to the download ID. We need to store the download ID in the batch state so cleanup can reference it.

Add `gameId` to `AllDebridBatchState` interface (line 44-54). Replace:

```typescript
interface AllDebridBatchState {
  downloadId: string;
  savePath: string;
  entries: AllDebridBatchEntry[];
  currentIndex: number;
  completedBytes: number;
  totalBytes: number;
  lastSpeedUpdate: number;
  bytesAtLastSpeedUpdate: number;
  batchSpeed: number;
}
```

With:

```typescript
interface AllDebridBatchState {
  downloadId: string;
  gameId: string;
  savePath: string;
  entries: AllDebridBatchEntry[];
  currentIndex: number;
  completedBytes: number;
  totalBytes: number;
  lastSpeedUpdate: number;
  bytesAtLastSpeedUpdate: number;
  batchSpeed: number;
}
```

- [ ] **Step 2: Store `gameId` when creating AllDebrid batch**

In `startDownload`, find the AllDebrid batch creation (around line 1255-1270). Add `gameId` field:

```typescript
          this.allDebridBatch = {
            downloadId,
            gameId: levelKeys.game(download.shop, download.objectId),
            savePath: download.downloadPath,
            entries: entries.map((entry) => ({
```

- [ ] **Step 3: Rewrite `cleanupBatch` to set error status and process queue**

Replace `cleanupBatch` (lines 949-957):

Current code:
```typescript
  private static cleanupBatch() {
    this.usingJsDownloader = false;
    this.jsDownloader?.cancelDownload();
    this.jsDownloader = null;
    this.allDebridBatch = null;
    this.downloadingGameId = null;
    this.isPreparingDownload = false;
    WindowManager.mainWindow?.setProgressBar(-1);
  }
```

Replace with:
```typescript
  private static cleanupBatch() {
    const batch = this.allDebridBatch;
    this.usingJsDownloader = false;
    this.jsDownloader?.cancelDownload();
    this.jsDownloader = null;
    this.allDebridBatch = null;
    this.downloadingGameId = null;
    this.isPreparingDownload = false;
    WindowManager.mainWindow?.setProgressBar(-1);
    WindowManager.sendToAppWindows("on-download-progress", null);

    if (batch?.gameId) {
      const gameId = batch.gameId;
      downloadsSublevel
        .get(gameId)
        .then((download) => {
          if (!download || download.status === "complete") return;
          return downloadsSublevel.put(gameId, {
            ...download,
            status: "error",
            queued: false,
            pinnedToHero: false,
          });
        })
        .then(() => {
          WindowManager.sendDownloadsUpdated();
          void this.processNextQueuedDownload();
        })
        .catch((err) => {
          logger.error(
            "[DownloadManager] Failed to persist batch error status",
            err
          );
        });
    }
  }
```

- [ ] **Step 4: Run typecheck**

```bash
yarn typecheck
```

Expected: No new type errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/download/download-manager.ts
git commit -m "fix: AllDebrid batch failure now sets error status and processes queue"
```

---

### Task 4: Fix float comparison `progress === 1` for RPC downloads

**Files:**
- Modify: `src/main/services/download/download-manager.ts:483`

**Problem:** `progress === 1` is a strict float comparison. Libtorrent might report `0.999999` instead of exactly `1.0`. The RPC code only sets `status: "active"` (never "complete"), so the fallback `download.status === "complete"` won't help for RPC downloads.

- [ ] **Step 1: Change comparison to use `>= 0.999`**

In `src/main/services/download/download-manager.ts`, line 483, change:

```typescript
      (progress === 1 || download.status === "complete");
```

To:

```typescript
      (progress >= 0.999 || download.status === "complete");
```

- [ ] **Step 2: Run typecheck**

```bash
yarn typecheck
```

Expected: No errors (trivial change).

- [ ] **Step 3: Commit**

```bash
git add src/main/services/download/download-manager.ts
git commit -m "fix: use >= 0.999 instead of === 1 for download progress completion check"
```

---

### Task 5: Remove duplicate `handleDownloadError` call

**Files:**
- Modify: `src/main/services/download/js-http-downloader.ts:538-550`
- Modify: `src/main/services/download/js-http-downloader.ts:229-234`

**Problem:** For non-abort, non-retryable errors, `handleDownloadErrorWithRetry` calls `handleDownloadError` which throws. The throw skips `return false` and propagates up. The code flow is: set status="error" → throw → caller catch → set status again. Clean this up so `handleDownloadError` doesn't throw for terminal errors.

- [ ] **Step 1: Remove `throw err` from `handleDownloadError`**

In `src/main/services/download/js-http-downloader.ts`, replace lines 538-550:

Current code:
```typescript
  private handleDownloadError(err: Error): void {
    if (
      err.name === "AbortError" ||
      (err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE"
    ) {
      logger.log("[JsHttpDownloader] Download aborted");
      this.status = "paused";
    } else {
      logger.error("[JsHttpDownloader] Download error:", err);
      this.status = "error";
      throw err;
    }
  }
```

Replace with:
```typescript
  private handleDownloadError(err: Error): void {
    if (
      err.name === "AbortError" ||
      (err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE"
    ) {
      logger.log("[JsHttpDownloader] Download aborted");
      this.status = "paused";
    } else {
      logger.error("[JsHttpDownloader] Download error:", err);
      this.status = "error";
    }
  }
```

- [ ] **Step 2: Clean up `handleDownloadErrorWithRetry` to not rely on throw-from-callee**

In `src/main/services/download/js-http-downloader.ts`, lines 229-236. The `else` branch now correctly handles terminal errors since `handleDownloadError` no longer throws. Replace lines 229-236:

Current code:
```typescript
    if (isAbortError && !wasStallRetry) {
      logger.log("[JsHttpDownloader] Download aborted");
      this.status = "paused";
    } else {
      this.handleDownloadError(err);
    }

    return false;
```

Replace with:
```typescript
    if (isAbortError && !wasStallRetry) {
      logger.log("[JsHttpDownloader] Download aborted");
      this.status = "paused";
    } else {
      this.handleDownloadError(err);
    }

    return false;
```

(No functional change here — `handleDownloadError` just doesn't throw anymore, so `return false` is now reliably reached.)

- [ ] **Step 3: Run typecheck**

```bash
yarn typecheck
```

Expected: No new type errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/download/js-http-downloader.ts
git commit -m "fix: remove duplicate error throw in handleDownloadError, simplify retry flow"
```

---

### Task 6: Add rollback when `activateDownload` fails after pausing current download

**Files:**
- Modify: `src/main/services/download-orchestrator.ts:355-367`
- Modify: `src/main/services/download-orchestrator.ts:455-460`

**Problem:** In `resumeDownload` and `moveDownloadPlacement`, when there's an active download, it gets paused first, then the requested download is activated. If `activateDownload` throws, the paused download is lost and nothing is active.

- [ ] **Step 1: Fix `resumeDownload` to restore previous active on failure**

In `src/main/services/download-orchestrator.ts`, replace lines 354-367:

Current code:
```typescript
    if (currentActiveDownload) {
      await this.pauseDownload(currentActiveDownload, {
        reason: "paused",
        startNextQueued: false,
      });
    }

    await this.activateDownload(download);
    const nextDownloads = await this.getAllDownloads();
    await removeDownloadFromLayoutState(download, nextDownloads);
    WindowManager.sendDownloadsUpdated();

    return true;
```

Replace with:
```typescript
    if (currentActiveDownload) {
      await this.pauseDownload(currentActiveDownload, {
        reason: "paused",
        startNextQueued: false,
      });
    }

    try {
      await this.activateDownload(download);
    } catch (err) {
      logger.error(
        "[DownloadOrchestrator] Failed to activate download, restoring previous",
        err
      );

      if (currentActiveDownload) {
        await this.activateDownload(currentActiveDownload).catch(
          (restoreErr) => {
            logger.error(
              "[DownloadOrchestrator] Failed to restore previous download",
              restoreErr
            );
            void this.startNextQueuedDownload();
          }
        );
      } else {
        void this.startNextQueuedDownload();
      }

      throw err;
    }

    const nextDownloads = await this.getAllDownloads();
    await removeDownloadFromLayoutState(download, nextDownloads);
    WindowManager.sendDownloadsUpdated();

    return true;
```

- [ ] **Step 2: Fix `moveDownloadPlacement` (hero target) to restore on failure**

In `src/main/services/download-orchestrator.ts`, replace lines 454-461:

Current code:
```typescript
      await this.activateDownload(download);
      const nextDownloads = await this.getAllDownloads();
      await setDownloadLayoutQueues(nextDownloads, queueIds, pausedIds);
      WindowManager.sendDownloadsUpdated();
      return true;
```

Replace with:
```typescript
      try {
        await this.activateDownload(download);
      } catch (err) {
        logger.error(
          "[DownloadOrchestrator] Failed to activate download in move placement",
          err
        );

        if (currentActiveDownload) {
          await this.activateDownload(currentActiveDownload).catch(
            (restoreErr) => {
              logger.error(
                "[DownloadOrchestrator] Failed to restore previous download",
                restoreErr
              );
              void this.startNextQueuedDownload();
            }
          );
        } else {
          void this.startNextQueuedDownload();
        }

        throw err;
      }

      const nextDownloads = await this.getAllDownloads();
      await setDownloadLayoutQueues(nextDownloads, queueIds, pausedIds);
      WindowManager.sendDownloadsUpdated();
      return true;
```

- [ ] **Step 3: Run typecheck**

```bash
yarn typecheck
```

Expected: No new type errors. `logger` is already imported.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/download-orchestrator.ts
git commit -m "fix: restore previous active download if activateDownload fails"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full typecheck**

```bash
yarn typecheck
```

Expected: PASS, zero errors.

- [ ] **Step 2: Run linter**

```bash
yarn lint
```

Expected: PASS, zero errors. If there are pre-existing lint errors unrelated to these changes, note them but do not fix.

- [ ] **Step 3: Review final diff**

```bash
git diff --stat
```

Expected: Only 4 files changed: `download-manager.ts`, `real-debrid.ts`, `js-http-downloader.ts`, `download-orchestrator.ts`.
