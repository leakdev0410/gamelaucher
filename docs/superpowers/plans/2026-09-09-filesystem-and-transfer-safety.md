# Filesystem and Transfer Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent arbitrary filesystem access and ensure archive deletion and game transfer report truthful outcomes.

**Architecture:** A shared containment helper becomes the single rule for root-bounded paths. Existing IPC handlers consume it without changing their public API. Transfer is made transactional at the metadata layer: copy, remove source, then persist destination.

**Tech Stack:** Electron 39, TypeScript strict, Node.js filesystem APIs, Yarn.

**Spec:** `docs/superpowers/specs/2026-09-09-filesystem-and-transfer-safety-design.md`

## Global Constraints

- Preserve the portable runtime layout and existing renderer IPC method names.
- Do not write or delete outside the explicitly intended root.
- Use `logger`, never `console`.
- Do not add a test dependency solely for this patch.

---

### Task 1: Root-contained path helper and filesystem IPCs

**Files:**

- Create: `src/main/helpers/path-within-root.ts`
- Modify: `src/main/events/misc/save-temp-file.ts`
- Modify: `src/main/events/library/update-custom-game.ts`
- Modify: `src/main/events/library/update-game-custom-assets.ts`
- Modify: `src/main/events/library/remove-game-from-library.ts`

- [x] Add a `resolvePathWithinRoot(root, candidate)` helper that uses resolved, platform-normalized paths and returns null unless candidate is beneath root.
- [x] Sanitize supplied temp file names with `path.basename`, reject empty or dot names, and verify the result remains below the temp path.
- [x] Guard every local asset unlink with `ASSETS_PATH` containment.
- [x] Run `yarn typecheck`.

### Task 2: Archive ownership validation

**Files:**

- Modify: `src/main/events/library/delete-archive.ts`

- [x] Find the matching download by checking that the archive path is contained in its download folder.
- [x] Require a regular file before unlinking and retain the installer-size update after successful deletion.
- [x] Run `yarn typecheck`.

### Task 3: Truthful game transfer lifecycle

**Files:**

- Modify: `src/main/events/library/transfer-game-files.ts`

- [x] Detect symbolic links and junctions while traversing source content and reject before copy.
- [x] Replace silent source-delete failure with an error result and retain the original database record.
- [x] Persist the destination paths only after source removal succeeds.
- [x] Run `yarn typecheck`.

### Task 4: Image proxy address validation

**Files:**

- Modify: `src/main/events/misc/get-image-data-url.ts`

- [x] Resolve and validate the destination immediately before every fetch, including redirects.
- [x] Extend private-address filtering for IPv4 mapped IPv6 and carrier-grade/private ranges.
- [x] Run `yarn typecheck` and `yarn build`.
