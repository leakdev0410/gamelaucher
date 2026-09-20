# Convention Compliance Cleanup — Design

**Date:** 2026-09-20
**Status:** Draft (awaiting user review)
**Scope:** Full repo (~50k+ lines, 125 modified + 18 untracked files)
**Approach:** Big sweep, single commit, full build verification

## 1. Goal

Align the entire codebase to the conventions declared in `.cursorrules`:

- Replace `console.*` with `logger.*` in main and renderer
- Use `T[]` instead of `Array<T>` everywhere
- Convert utility/service default exports to named exports (React components keep defaults)
- Internationalize all hardcoded user-facing strings (add keys to `en` + `vi`)
- Tighten comments: concise, purposeful, no verbose or stale explanations
- Resolve or remove `TODO`/`FIXME`/`XXX`/`HACK` markers

Plus a cleanup pass:

- Delete `restoreDatabaseAfterFailedTransfer` dead code (causes current typecheck failure)
- Remove unused `Auth` import in `src/renderer/src/declaration.d.ts`
- Delete `AGENTS.md` (byte-identical duplicate of `CLAUDE.md`)
- Delete unwired `scripts/fix-light-theme-leftovers.cjs` (one-shot)
- Add `save/`, `img/`, `designs/` to `.gitignore` (runtime + design artifacts)

End state: ESLint auto-enforces conventions for future code; full `yarn typecheck + lint + build` passes.

## 2. Out of scope (explicit)

- **Restructuring files / splitting large modules** — user chose "Convention compliance" not "Modularization". `download-manager.ts` (1649 lines), `window-manager.ts` (805 lines), `download-settings-modal.tsx` (1654 lines) stay as-is.
- **i18n of main-process `dialog.showErrorBox`** — currently hardcoded Vietnamese. Future follow-up.
- **Renaming `find-achivement-files.ts`** (typo) — would touch git history. Future follow-up.
- **32 non-en/vi locale files** — only `en` and `vi` get new keys. i18next falls back to `en` when missing.
- **IPC contract changes** — method names in `src/preload/index.ts` ↔ `src/renderer/src/declaration.d.ts` stay byte-identical.

## 3. Convention audit categories

### 3.1 Logger (`console.*` → `logger.*`)

| Where | Import | Replace |
|---|---|---|
| `src/main/**/*.ts` | `import { logger } from "@main/services"` | `console.log/info/debug` → `logger.log/info/debug` |
| `src/renderer/src/**/*.{ts,tsx}` | `import { logger } from "@renderer/logger"` | same |

**Exceptions:**
- `src/renderer/src/main.tsx:39` — `console.log = logger.log` (intentional override). ESLint `no-console: off` for this file.
- `console.warn` / `console.error` — permitted globally as fallback when logger not initialized.

### 3.2 `T[]` vs `Array<T>`

Replace all `Array<T>` with `T[]`. Auto-fixed by ESLint rule `@typescript-eslint/array-type: ["error", { default: "array-simple" }]`.

### 3.3 Named exports (no defaults for utils/services)

| Keep default | Convert to named |
|---|---|
| React components (`*.tsx` in `pages/`, `components/`) | `src/main/services/**`, `src/main/helpers/**`, `src/main/events/**` |
| | `src/renderer/src/helpers.ts`, `src/renderer/src/hooks/**`, `src/renderer/src/features/**` |

Convert `export default foo` → `export { foo }` (or `export const foo`). Update all import sites.

### 3.4 i18n (no hardcoded user-facing strings)

User-facing strings must use `useTranslation` hook:

```tsx
const { t } = useTranslation("namespace");
// JSX: {t("key_name")}
// Object: t("key_with_count", { count })
```

Add new keys to `src/locales/en/translation.json` (primary). Mirror to `src/locales/vi/translation.json` with Vietnamese translations. Other 32 locales are left untouched; i18next falls back to `en`.

**Strings to i18n:** JSX text, placeholders, aria-labels, tooltips, toast messages, modal titles, button labels, dynamic count/plural strings.

**Strings NOT to i18n:** `data-*` attributes, className, ids, paths, protocol names (`hydralauncher://`, `local:`, `gradient:`), MIME types, numeric literals.

### 3.5 Comments

Keep: docblocks on public APIs, `// WHY:` notes for non-obvious context.
Remove: redundant restatements of code (`// increment counter` on `i++`), stale comments, headers that just repeat function name.

### 3.6 TODO/FIXME/XXX/HACK markers

Resolve or remove all bare `// TODO` / `// FIXME` markers. Permitted: `// TODO(2026-09): <ticket>` (referenced ticket). One known location: `src/main/services/achievements/find-achivement-files.ts:57` — resolve or convert to a `// WHY:` note.

### 3.7 Code style

`async/await` over `.then()` chains. Convert `.then()` chains that span multiple lines into `async/await`. Prettier handles whitespace (already configured via `.cursorrules` and `yarn format`).

## 4. Dead code + leftover cleanup

| Item | Action |
|---|---|
| `src/main/events/library/transfer-game-files.ts:320-332` `restoreDatabaseAfterFailedTransfer` | Delete entire function (unused; also has type error `{}` not assignable to `Download`) |
| `src/renderer/src/declaration.d.ts:24` `Auth` import | Delete (unused after `getAuth` IPC removal) |
| `AGENTS.md` (root) | Delete (297 lines, identical to `CLAUDE.md` except H1) |
| `scripts/fix-light-theme-leftovers.cjs` | Delete (one-shot, not wired into any yarn script) |
| `save/`, `img/`, `designs/` | Add to `.gitignore` (runtime + design exploration artifacts) |
| `console.log` x4 in `src/main/events/library/get-available-drives.ts` | Delete (debug prints) |
| `console.log` x1 in `src/renderer/src/pages/game-details/modals/game-options-modal/general-section.tsx:132` | Delete |

## 5. ESLint config additions

Append to `rules` in `.eslintrc.cjs`:

```js
"no-console": ["error", { allow: ["warn", "error"] }],
"@typescript-eslint/array-type": ["error", { default: "array-simple" }],
"no-warning-comments": ["error", {
  terms: ["todo", "fixme", "xxx", "hack"],
  location: "start",
}],
"import/no-default-export": "error",
```

Add overrides:

```js
overrides: [
  {
    files: ["src/renderer/src/**/*.tsx"],
    rules: { "import/no-default-export": "off" },
  },
  {
    files: ["src/renderer/src/main.tsx"],
    rules: { "no-console": "off" },
  },
],
```

`eslint-plugin-import` is added as devDep (`^2.31.0`). Already-installed: `eslint ^8.56.0`, `@typescript-eslint/eslint-plugin` (peer dep of `@electron-toolkit/eslint-config-ts`).

## 6. Execution order

```
Phase 1: Audit violations      (read-only, generate checklist)
Phase 2: Install eslint-plugin-import (devDep)
Phase 3: yarn lint --fix        (auto-fixable only)
Phase 4: Manual convention fixes (logger, default→named, i18n, comments)
Phase 5: Dead code + gitignore
Phase 6: Enable new ESLint rules
Phase 7: Verify (yarn typecheck + lint + build)
Phase 8: Single commit
```

**Order rationale:** Manual fixes (Phase 4) happen BEFORE enabling strict rules (Phase 6). If strict rules are enabled first, lint fails on legacy code and masks other issues. Enable at the end so future code is auto-enforced.

## 7. Verification

```bash
yarn typecheck      # exit 0
yarn lint           # exit 0
yarn build:go-rpc   # exit 0
yarn build          # exit 0 (electron-vite + electron-builder)
```

Each gate must pass before next. On any failure:

- Typecheck fail → fix TS errors inline (usually unused imports after default→named convert)
- Lint fail → `yarn lint --fix`, then review and re-run
- Build fail (SCSS) → fix syntax in modified `.scss` files
- Build fail (bundle) → search missing symbol (likely import path broken by rename)

If 2 consecutive failures on same gate: STOP, surface to user.

## 8. Checkpoints

| Checkpoint | After | User asked |
|---|---|---|
| **CP1** | Phase 4 (manual fixes) | "Diff đến giờ OK không? Tiếp tục Phase 5–8?" |
| **CP2** | Phase 7 (verify pass) | "yarn build pass. Diff cuối như dưới. Commit?" |

If user aborts at CP1 or CP2: `git checkout .` to restore working tree.

## 9. Risk + mitigation

| Risk | Mitigation |
|---|---|
| i18n scan misses hardcoded strings | Manual scan of large pages (game-details, library, settings) |
| Default export conversion breaks consumer | Grep all consumers before convert; update import sites atomically |
| Logger replacement breaks in files using different import paths | Verify `@main/services` vs `@main/utils/logger` paths first |
| ESLint rule too strict, blocks future PRs | Per-file overrides where justified; rule config documented |
| `vi` locale falls behind on new keys | Acceptable; i18next fallback to `en` configured |
| Single-commit rollback impossible if mid-flight failure | Suggest `git checkout -b backup-pre-convention-cleanup` before starting |

## 10. Effort estimate

| Phase | Time |
|---|---|
| 1. Audit | 15–30 min |
| 2. Install dep | 1 min |
| 3. ESLint --fix | 1–2 min |
| 4. Manual fixes | 6–9 hours |
| 5. Dead code | 15–30 min |
| 6. ESLint rules | 30 min |
| 7. Verify + fix | 30–60 min |
| 8. Commit | 1 min |
| **Total** | **~8 hours focused work** |

## 11. Final deliverable

After commit, user receives:

1. Diff stats summary (files changed, insertions, deletions)
2. Verification output (typecheck + lint + build all exit 0)
3. Manual smoke test recommendation:
   - `yarn dev`, test core flows (download, extract, library)
   - Pay extra attention to `transfer-game-files` (touched dead-code area)
   - Switch `en` ↔ `vi` to verify no missing keys
4. Known limitations (per Section 2)

## 12. Post-cleanup follow-up (out of scope)

For user to consider in a separate session:

- Rename `find-achivement-files.ts` → `find-achievement-files.ts` (typo + 2 import updates)
- i18n the hardcoded Vietnamese in main-process `dialog.showErrorBox`
- Migrate all 34 locale files to `i18next-parser` for automated key sync
- Split `download-manager.ts` (1649 lines) into focused modules
- Split `download-settings-modal.tsx` (1654 lines) into sections
