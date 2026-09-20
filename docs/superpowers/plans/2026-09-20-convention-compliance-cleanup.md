# Convention Compliance Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the entire codebase to `.cursorrules` conventions (logger, T[], named exports, i18n, comments, no dead code) and tighten ESLint so future code is auto-enforced.

**Architecture:** One big-sweep change touching all of `src/` (main + renderer), config files (`.eslintrc.cjs`, `package.json`, `.gitignore`), and root files (`AGENTS.md`). Single commit at the end. Verification gates between phases prevent cascade failures.

**Tech Stack:** Electron 39, TypeScript strict, electron-vite, React 18, ESLint 8.56, Prettier, i18next, custom logger (main + renderer). New devDep: `eslint-plugin-import ^2.31.0`.

**Spec:** `docs/superpowers/specs/2026-09-20-convention-compliance-cleanup-design.md`

---

## Global Constraints

These constraints apply to every task. Source: `.cursorrules` + spec section 3.

- **Logger:** `console.log/info/debug` → `logger.log/info/debug`. `console.warn/error` permitted globally. File `src/renderer/src/main.tsx:39` (`console.log = logger.log`) is the only intentional `console.*` and must not be replaced.
- **Array syntax:** `T[]` not `Array<T>` in all type annotations, assertions, generic params.
- **Named exports:** utilities, services, hooks, features, helpers use named exports. React components in `*.tsx` keep default exports.
- **i18n:** new keys go in `src/locales/en/translation.json` (primary) and `src/locales/vi/translation.json` (Vietnamese). Other 32 locales untouched.
- **Comments:** concise, purposeful, docblocks only on public APIs.
- **TODO markers:** resolve or remove bare `// TODO`/`FIXME`. Permitted: `// TODO(YYYY-MM): <ticket>`.
- **IPC contract:** method names in `src/preload/index.ts` ↔ `src/renderer/src/declaration.d.ts` must remain byte-identical.
- **Build verification gates (in order):** `yarn typecheck` → `yarn lint` → `yarn build:go-rpc` → `yarn build`. Each must exit 0.

---

## Review Focus

Failure modes the spec implies but no task explicitly tests:

1. **Logger replacement in `src/renderer/src/main.tsx:39`** — must skip the intentional `console.log = logger.log` line.
2. **`import/no-default-export` rule on React components** — `*.tsx` in `src/renderer/src/{pages,components}/` keep default exports; rule must be off via override.
3. **`declaration.d.ts` ↔ `preload/index.ts` IPC contract** — must remain byte-identical (covered by TypeScript check at line 24's `Auth` import — but the rule is "delete unused Auth", not "change method names").
4. **i18n `vi` locale fallback** — if new keys are added to `en` but not `vi`, i18next falls back to `en` silently. Verify `yarn build` doesn't fail on missing locale keys.
5. **`download-manager.ts` path-resolver changes during cleanup** — recent diff touched this file heavily; convention fixes must not change behavior.

---

## Phase 0: Pre-flight

### Task 0.1: Create backup branch

**Files:**

- Create: branch `backup-pre-convention-cleanup` (no file changes)

- [ ] **Step 1:** Verify working tree status

Run: `git status --short`
Expected: list of modified/untracked files matching the snapshot before plan execution. If clean, proceed.

- [ ] **Step 2:** Create backup branch from current HEAD

Run:

```bash
git checkout -b backup-pre-convention-cleanup
git checkout main  # or the branch you'll commit to
```

- [ ] **Step 3:** Verify branch creation

Run: `git branch --list backup-pre-convention-cleanup`
Expected: one line matching `backup-pre-convention-cleanup`

### Task 0.2: Read spec + conventions

**Files:**

- Read: `.cursorrules`, `docs/superpowers/specs/2026-09-20-convention-compliance-cleanup-design.md`

- [ ] **Step 1:** Read `.cursorrules` fully

Run: `Read .cursorrules`
Expected: 6 sections (Logging, i18n, Code Style, ESLint, TS Array, Comments). Refresh memory of conventions.

- [ ] **Step 2:** Read spec section 3 (audit categories)

Run: `Read docs/superpowers/specs/2026-09-20-convention-compliance-cleanup-design.md` (offset 37, limit 56)
Expected: 7 sub-sections (3.1–3.7) covering logger, T[], named exports, i18n, comments, TODO, code style.

- [ ] **Step 3:** Confirm understanding before proceeding

Mental check: you should be able to recite (a) what `no-console` rule allows, (b) which files keep default exports, (c) which 2 locale files get new keys. If not, re-read.

---

## Phase 1: Audit violations (read-only)

This phase produces a written checklist used by Phases 4–5. No code changes.

### Task 1.1: Audit `console.*` usages

- [ ] **Step 1:** Count `console.*` calls in main process

Run: `grep -rnE "console\.(log|info|debug)" src/main/ --include="*.ts" | wc -l`
Expected: a number N1. Record in checklist: `console.main: N1 files`.

- [ ] **Step 2:** List files with console.\* in main

Run: `grep -rlE "console\.(log|info|debug)" src/main/ --include="*.ts" | sort -u`
Expected: a sorted list of file paths. Save output to `docs/superpowers/plans/audit-console-main.txt`.

- [ ] **Step 3:** Same for renderer

Run: `grep -rlE "console\.(log|info|debug)" src/renderer/src/ --include="*.ts" --include="*.tsx" | sort -u`
Save output to `docs/superpowers/plans/audit-console-renderer.txt`.

- [ ] **Step 4:** Confirm `main.tsx:39` is the only intentional override

Run: `grep -n "console\.log = logger" src/renderer/src/main.tsx`
Expected: line 39 with the override. If not, find the line and update checklist.

### Task 1.2: Audit `Array<T>` usages

- [ ] **Step 1:** Find `Array<T>` patterns in src/

Run: `grep -rnE "Array<[A-Za-z]" src/ --include="*.ts" --include="*.tsx" | wc -l`
Expected: a count N. Save to checklist: `Array<T>: N occurrences`.

- [ ] **Step 2:** List files with `Array<T>`

Run: `grep -rlE "Array<[A-Za-z]" src/ --include="*.ts" --include="*.tsx" | sort -u`
Save to `docs/superpowers/plans/audit-array.txt`.

### Task 1.3: Audit default exports in non-component files

- [ ] **Step 1:** Find default exports in main process (excluding `.tsx`)

Run: `grep -rnE "^export default " src/main/ --include="*.ts" | wc -l`
Expected: a count.

- [ ] **Step 2:** Find default exports in renderer helpers/features/hooks

Run: `grep -rnE "^export default " src/renderer/src/helpers.ts src/renderer/src/hooks/ src/renderer/src/features/ --include="*.ts" --include="*.tsx" | wc -l`
Expected: a count.

- [ ] **Step 3:** Save combined list

Run: `grep -rlnE "^export default " src/main/ src/renderer/src/helpers.ts src/renderer/src/hooks/ src/renderer/src/features/ --include="*.ts" --include="*.tsx" | sort -u`
Save to `docs/superpowers/plans/audit-default-exports.txt`.

### Task 1.4: Audit hardcoded user-facing strings (sample)

Manual scan — full automation is out of scope. Focus on top-level pages first.

- [ ] **Step 1:** Find JSX text content in game-details page

Run: `grep -rE ">[A-Z][a-zA-Z ]{2,}<" src/renderer/src/pages/game-details/ --include="*.tsx" | head -20`
Expected: list of JSX lines with English text. This is a SAMPLE — full audit requires reading each component.

- [ ] **Step 2:** Find `placeholder=` attributes

Run: `grep -rnE 'placeholder="[^"]+"' src/renderer/src/ --include="*.tsx" | grep -v 'placeholder=\{\|\$t\|t(' | head -20`
Expected: list of untranslated placeholders.

- [ ] **Step 3:** Note this audit is incomplete; plan to scan during Phase 4.5.

Save findings to `docs/superpowers/plans/audit-hardcoded-strings.txt`.

### Task 1.5: Audit TODO/FIXME markers

- [ ] **Step 1:** Find bare TODO markers

Run: `grep -rnE "// (TODO|FIXME|XXX|HACK)([: ]|\$)" src/ --include="*.ts" --include="*.tsx" | wc -l`
Expected: a count. (Excludes `// TODO(YYYY-MM): ...` which has a date.)

- [ ] **Step 2:** List files

Run: `grep -rlE "// (TODO|FIXME|XXX|HACK)([: ]|\$)" src/ --include="*.ts" --include="*.tsx" | sort -u`
Save to `docs/superpowers/plans/audit-todo.txt`.

---

## Phase 2: Install dev dependency

### Task 2.1: Add `eslint-plugin-import`

- [ ] **Step 1:** Install plugin

Run: `yarn add -D eslint-plugin-import@^2.31.0`
Expected: success message; `package.json` and `yarn.lock` updated.

- [ ] **Step 2:** Verify install

Run: `cat package.json | grep "eslint-plugin-import"`
Expected: one line with `"eslint-plugin-import": "^2.31.0"`.

- [ ] **Step 3:** Verify plugin loads

Run: `node -e "require('eslint-plugin-import')" && echo OK`
Expected: `OK`. If error, run `yarn install` again.

---

## Phase 3: ESLint auto-fix (mechanical)

This phase runs `yarn lint --fix` BEFORE enabling new rules, so only existing rules apply.

### Task 3.1: Run auto-fix

- [ ] **Step 1:** Run lint with fix

Run: `yarn lint 2>&1 | tail -50`
Expected: list of fixable issues. Many may be auto-corrected in place.

- [ ] **Step 2:** Review diff

Run: `git diff --stat`
Expected: many files changed by formatter (whitespace, import order). Verify no semantic changes (no logic edits, only whitespace/syntax).

- [ ] **Step 3:** Verify typecheck still passes

Run: `yarn typecheck 2>&1 | tail -10`
Expected: exit 0 OR same errors as before Phase 3 (i.e., the pre-existing `restoreDatabaseAfterFailedTransfer` errors). If new errors appear, revert with `git checkout .` and investigate.

---

## Phase 4: Manual convention fixes

Largest phase. Six task categories; each applies the pattern from a representative example to all matching files in the audit checklist.

### Task 4.1: Replace `console.*` in main process with `logger.*`

**Files (representative):**

- Read first to confirm: `src/main/events/library/get-available-drives.ts` (line 117–128 have 3 debug prints)
- Apply to all files in `docs/superpowers/plans/audit-console-main.txt`

- [ ] **Step 1:** Read representative file

Run: `Read src/main/events/library/get-available-drives.ts`
Locate lines 117, 122, 128. Confirm they're debug `console.log` calls.

- [ ] **Step 2:** Apply pattern to representative file

Use `Edit` to:

- Add `import { logger } from "@main/services";` if missing (check if already imported)
- Replace `console.log("...")` → `logger.log("...")`

Example for line 117:

```
// BEFORE
console.log("getAvailableDrives called, platform:", process.platform);
// AFTER
logger.log("getAvailableDrives called, platform:", process.platform);
```

- [ ] **Step 3:** Verify representative file compiles

Run: `yarn typecheck 2>&1 | grep -c "error TS"`
Expected: same count as before (or fewer if logger import was already there). If new errors, fix or revert this file.

- [ ] **Step 4:** Apply same pattern to every file in `audit-console-main.txt`

For each file:

- `Read` it
- Check if `import { logger } from "@main/services"` exists; add if missing
- Use `Edit` (or `Edit` with `replace_all: true` for files with multiple identical `console.log` calls) to replace `console.X(` with `logger.X(`
- After each batch (~10 files), run `yarn typecheck 2>&1 | grep "error TS" | head -5` to spot regressions

- [ ] **Step 5:** Verify all main console.\* replaced (except allow=warn/error)

Run: `grep -rnE "console\.(log|info|debug)" src/main/ --include="*.ts"`
Expected: empty output (no remaining `console.log/info/debug`).

### Task 4.2: Replace `console.*` in renderer with `logger.*`

**Files:** all in `docs/superpowers/plans/audit-console-renderer.txt`, EXCEPT `src/renderer/src/main.tsx` (handled separately).

- [ ] **Step 1:** Read representative file

Run: `Read src/renderer/src/pages/game-details/modals/game-options-modal/general-section.tsx` (offset 125, limit 20)
Locate line 132 with `console.log(`. Confirm it's a debug print.

- [ ] **Step 2:** Apply pattern

- Add `import { logger } from "@renderer/logger";` if missing
- Replace `console.log(...)` → `logger.log(...)`

- [ ] **Step 3:** Apply same pattern to every file in `audit-console-renderer.txt`

Loop through files. Same pattern as Task 4.1 step 4.

- [ ] **Step 4:** Verify all renderer console.\* replaced (except main.tsx)

Run: `grep -rnE "console\.(log|info|debug)" src/renderer/src/ --include="*.ts" --include="*.tsx" | grep -v "main.tsx"`
Expected: empty output.

- [ ] **Step 5:** Verify main.tsx override preserved

Run: `grep -n "console\.log = logger" src/renderer/src/main.tsx`
Expected: line 39 (or wherever it is) with the override intact.

### Task 4.3: Convert `Array<T>` to `T[]`

**Files:** all in `docs/superpowers/plans/audit-array.txt`.

- [ ] **Step 1:** Apply ESLint auto-fix (rule NOT yet enabled — use manual sed)

Run:

```bash
# This regex handles common cases. Review output.
grep -rlE "Array<[A-Za-z]" src/ --include="*.ts" --include="*.tsx" | xargs sed -i -E 's/Array<([A-Za-z][A-Za-z0-9_]*)>/\1[]/g'
```

Expected: files modified in place.

- [ ] **Step 2:** Verify replacement

Run: `grep -rnE "Array<[A-Za-z]" src/ --include="*.ts" --include="*.tsx" | head -10`
Expected: empty output (or only false positives in comments/strings).

- [ ] **Step 3:** Typecheck

Run: `yarn typecheck 2>&1 | tail -10`
Expected: exit 0 OR same pre-existing errors. If new errors, investigate which `T[]` lost its implicit type parameter (e.g., `Array<{ a: string }>` may need careful handling — manual fix).

- [ ] **Step 4:** If sed introduced issues, revert and use manual Edit

Run: `git checkout -- src/` if sed broke things, then manually `Edit` each file.

### Task 4.4: Convert default exports to named (main)

**Files:** all in `docs/superpowers/plans/audit-default-exports.txt` that are under `src/main/`.

- [ ] **Step 1:** Pick representative file

Read first file in the list. Find its default export.

- [ ] **Step 2:** Convert and update imports

Pattern:

```
// BEFORE (in exporting file)
export default function myHelper() { ... }

// AFTER
export function myHelper() { ... }
```

Then update every consumer:

```
// BEFORE
import myHelper from "./myHelper";

// AFTER
import { myHelper } from "./myHelper";
```

- [ ] **Step 3:** Verify typecheck after each file

Run: `yarn typecheck 2>&1 | grep -c "error TS"`
Expected: count not increased.

- [ ] **Step 4:** Apply to all main files in audit list

Loop through. Verify each consumer update with `grep -rn "from \"./<file>\""` to find all import sites.

### Task 4.5: Convert default exports to named (renderer helpers/features/hooks)

**Files:** renderer entries in `audit-default-exports.txt`.

- [ ] **Step 1:** Same pattern as Task 4.4

- Read each file
- Convert `export default` → `export`
- Update all import sites (use `grep -rn` to find)

- [ ] **Step 2:** Verify typecheck

Run: `yarn typecheck 2>&1 | grep -c "error TS"`

### Task 4.6: Internationalize hardcoded strings

This is the largest manual task. Focus on top-level pages first; smaller components in a second pass.

- [ ] **Step 1:** Read en translation file structure

Run: `Read src/locales/en/translation.json` (offset 1, limit 50)
Expected: nested JSON with namespace → keys. Note the existing naming convention (snake_case or camelCase).

- [ ] **Step 2:** Read vi translation file structure

Run: `Read src/locales/vi/translation.json` (offset 1, limit 50)
Expected: same structure, Vietnamese translations.

- [ ] **Step 3:** Pick first page to i18n (recommend: game-details modals)

Read `src/renderer/src/pages/game-details/modals/game-options-modal.tsx` (or a representative file with hardcoded strings).

- [ ] **Step 4:** For each hardcoded string:

a. Generate a snake_case key: `"save_settings"`, `"delete_confirmation"`, etc.
b. Add to `src/locales/en/translation.json` (preserve alphabetical or grouped order):

```json
"save_settings": "Save settings",
```

c. Mirror to `src/locales/vi/translation.json` with Vietnamese:

```json
"save_settings": "Lưu cài đặt",
```

d. Update component:

```tsx
// BEFORE
<button>Save settings</button>;
// AFTER
const { t } = useTranslation("namespace");
<button>{t("save_settings")}</button>;
```

- [ ] **Step 5:** Verify vi rendering works

After adding a key, check `src/locales/vi/translation.json` has matching key. i18next will fall back to `en` if missing.

- [ ] **Step 6:** Repeat for other pages

Loop through `audit-hardcoded-strings.txt` plus manual scan of:

- `src/renderer/src/pages/library/`
- `src/renderer/src/pages/settings/`
- `src/renderer/src/pages/downloads/`
- `src/renderer/src/pages/catalogue/`
- `src/renderer/src/pages/achievements/`
- `src/renderer/src/components/` (top-level components only, skip deeply nested)

- [ ] **Step 7:** Verify build doesn't fail on missing locale keys

Run: `yarn build 2>&1 | grep -i "i18n\|translation\|missing" | head -10`
Expected: no i18n-related errors. (i18next uses `en` as fallback at runtime, not build time.)

### Task 4.7: Clean up comments

Subjective — apply spec section 3.5 rules.

- [ ] **Step 1:** Scan for obvious redundant comments

Run:

```bash
grep -rnE "// (Increment|Decrement|Loop|Get|Set|Return|Check|Validate) " src/ --include="*.ts" --include="*.tsx" | head -20
```

Expected: list of comments that just restate code. Remove these.

- [ ] **Step 2:** Scan for stale/verbose comment blocks

Manually read each file you modified in Phases 4.1–4.6. Look for:

- Comments explaining obvious code → remove
- Docblocks with obvious content (e.g., on a `getName()` function: `/** Gets the name */`) → remove or tighten
- Section dividers (`// ====== Helpers ======`) → keep, they help navigation in large files

- [ ] **Step 3:** No bulk replacement; per-file judgment.

Apply `Edit` per file.

---

## Phase 5: Dead code + cleanup

### Task 5.1: Delete `restoreDatabaseAfterFailedTransfer` dead code

- [ ] **Step 1:** Read the file around the dead function

Run: `Read src/main/events/library/transfer-game-files.ts` (offset 318, limit 20)
Expected: lines 320–332 contain the unused function.

- [ ] **Step 2:** Verify truly unused

Run: `grep -rn "restoreDatabaseAfterFailedTransfer" src/`
Expected: only the declaration itself. No callers.

- [ ] **Step 3:** Delete the function

Use `Edit` to remove the function block (lines 320–332, including the preceding blank line if any).

- [ ] **Step 4:** Verify typecheck no longer flags this

Run: `yarn typecheck 2>&1 | grep "transfer-game-files"`
Expected: empty (this error should be gone).

### Task 5.2: Delete unused `Auth` import in declaration.d.ts

- [ ] **Step 1:** Read declaration.d.ts around line 24

Run: `Read src/renderer/src/declaration.d.ts` (offset 22, limit 5)
Expected: line 24 contains `Auth,` in the type imports.

- [ ] **Step 2:** Confirm unused

Run: `grep -n "Auth" src/renderer/src/declaration.d.ts`
Expected: only line 24 (the import itself, not a usage).

- [ ] **Step 3:** Delete the import

Use `Edit` to remove the `Auth,` line.

### Task 5.3: Delete `AGENTS.md` (duplicate of CLAUDE.md)

- [ ] **Step 1:** Confirm duplication

Run: `diff CLAUDE.md AGENTS.md | head -10`
Expected: only the H1 differs (`# CLAUDE.md` vs `# AGENTS.md`).

- [ ] **Step 2:** Delete AGENTS.md

Run: `rm AGENTS.md`

- [ ] **Step 3:** Verify deletion

Run: `ls AGENTS.md 2>&1`
Expected: "No such file or directory".

### Task 5.4: Delete `scripts/fix-light-theme-leftovers.cjs`

- [ ] **Step 1:** Confirm not referenced

Run: `grep -rn "fix-light-theme-leftovers" . --include="*.json" --include="*.ts" --include="*.cjs" --include="*.mjs" 2>/dev/null | grep -v node_modules`
Expected: only the file itself. No callers.

- [ ] **Step 2:** Delete

Run: `rm scripts/fix-light-theme-leftovers.cjs`

### Task 5.5: Add runtime/design artifacts to `.gitignore`

- [ ] **Step 1:** Read current .gitignore

Run: `Read .gitignore`
Expected: existing ignores for `node_modules`, `dist`, `out`, etc.

- [ ] **Step 2:** Append new ignores

Use `Edit` to append (preserve existing content):

```
# Runtime artifacts (portable mode)
save/
img/

# Design exploration (not source)
designs/
```

- [ ] **Step 3:** Verify

Run: `git status --short | grep "^??" | grep -E "save/|img/|designs/"`
Expected: these directories should NOT appear as untracked (gitignored).

If they still appear: check `.gitignore` syntax — gitignore patterns with `/` suffix match directories only. `save/` (with trailing slash) is correct.

### Task 5.6: Delete remaining debug `console.log` calls

- [ ] **Step 1:** Find any remaining console.log (should be empty after Phase 4)

Run: `grep -rnE "console\.(log|info|debug)" src/ --include="*.ts" --include="*.tsx" | grep -v "main.tsx"`
Expected: empty (handled in Phase 4). If any remain, remove them with `Edit`.

---

## Phase 6: Tighten ESLint rules

### Task 6.1: Update `.eslintrc.cjs`

- [ ] **Step 1:** Read current config

Run: `Read .eslintrc.cjs`

- [ ] **Step 2:** Add new rules

Use `Edit` to modify the `rules` block. Add (preserve existing):

```js
"no-console": ["error", { allow: ["warn", "error"] }],
"@typescript-eslint/array-type": ["error", { default: "array-simple" }],
"no-warning-comments": ["error", {
  terms: ["todo", "fixme", "xxx", "hack"],
  location: "start",
}],
"import/no-default-export": "error",
```

- [ ] **Step 3:** Add overrides block

Append to the config object (before closing `};`):

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

- [ ] **Step 4:** Verify ESLint loads new config

Run: `yarn lint 2>&1 | tail -30`
Expected: errors related to the new rules OR exit 0. If errors, fix or document as intentional (with `// eslint-disable-next-line`).

### Task 6.2: Lint pass — fix any rule violations

- [ ] **Step 1:** Run lint, capture errors

Run: `yarn lint 2>&1 > lint-output.txt`
Run: `wc -l lint-output.txt`
Expected: a count of errors.

- [ ] **Step 2:** For each error, fix or annotate

For each error:

- If it's a real violation → fix the code
- If it's an intentional exception → add `// eslint-disable-next-line <rule>` with comment explaining why
- If it's a false positive → refine the rule config in `.eslintrc.cjs`

- [ ] **Step 3:** Re-run until clean

Run: `yarn lint 2>&1 | tail -5`
Expected: exit 0, no output.

- [ ] **Step 4:** Delete lint-output.txt (not needed in commit)

Run: `rm -f lint-output.txt`

---

## Phase 7: Verification

### Task 7.1: yarn typecheck

- [ ] **Step 1:** Run typecheck

Run: `yarn typecheck 2>&1 | tee typecheck-output.txt`
Expected: exit 0. If errors, fix inline.

- [ ] **Step 2:** Verify exit code

Run: `echo $?`
Expected: `0` (after the previous yarn command).

- [ ] **Step 3:** Clean up output file

Run: `rm typecheck-output.txt`

### Task 7.2: yarn lint

- [ ] **Step 1:** Run lint

Run: `yarn lint 2>&1 | tail -5`
Expected: exit 0, no output.

### Task 7.3: yarn build:go-rpc

- [ ] **Step 1:** Build Go RPC

Run: `yarn build:go-rpc 2>&1 | tail -10`
Expected: build success, output at `gamelaucher-go-rpc/gamelaucher-go-rpc.exe`. ~10 seconds.

### Task 7.4: yarn build (full)

- [ ] **Step 1:** Run full build

Run: `yarn build 2>&1 | tail -30`
Expected: exit 0. Builds `out/` and may also do typecheck.

- [ ] **Step 2:** If build fails on SCSS:

Inspect error, locate the modified `.scss` file, fix syntax, re-run.

- [ ] **Step 3:** If build fails on bundle:

Search for missing symbol — likely import path broken by a default→named export conversion. Trace back to the file and fix.

- [ ] **Step 4:** Re-run until exit 0

Run: `yarn build 2>&1 | tail -5`
Expected: clean build, no errors.

### Task 7.5: CP2 checkpoint — review before commit

**STOP here. Surface to user:**

- [ ] **Step 1:** Generate diff stats

Run: `git diff --shortstat`
Expected: a line like `125 files changed, 3500 insertions(+), 2100 deletions(-)`. Record for the commit message.

- [ ] **Step 2:** Show changed file list

Run: `git status --short | head -30`
Run: `git status --short | wc -l`
Expected: list of M/D/?? files. Record count.

- [ ] **Step 3:** Ask user: "yarn build passes. Diff summary: <stats>. Ready to commit?"

Wait for user response. If approved → proceed to Phase 8. If aborted → `git checkout .` to revert working tree.

---

## Phase 8: Single commit

### Task 8.1: Commit

- [ ] **Step 1:** Stage all changes

Run: `git add -A`
Expected: no output.

- [ ] **Step 2:** Verify staged files

Run: `git status --short | head -20`
Expected: same list as before, but without the `??` prefix (now staged).

- [ ] **Step 3:** Commit with structured message

Run:

```bash
git commit -m "chore: align codebase to .cursorrules conventions

- Replace console.* with logger.* (main + renderer)
- Use T[] instead of Array<T>
- Convert utility/service default exports to named
- Add missing i18n keys (en + vi locales)
- Remove stale comments and TODO markers
- Delete dead code (restoreDatabaseAfterFailedTransfer)
- Delete duplicate AGENTS.md (keep CLAUDE.md)
- Gitignore runtime artifacts (save/, img/, designs/)
- Delete unwired fix-light-theme-leftovers.cjs

ESLint config tightened:
- no-console: error (allow warn/error)
- @typescript-eslint/array-type: error
- no-warning-comments: error (todo/fixme/xxx/hack)
- import/no-default-export: error (off for *.tsx)

Verified:
- yarn typecheck pass
- yarn lint pass
- yarn build:go-rpc pass
- yarn build pass

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 4:** Verify commit

Run: `git log --oneline -3`
Expected: latest commit at top with the message above. Previous two commits are the spec + design.

### Task 8.2: Post-commit smoke test recommendation

- [ ] **Step 1:** Report to user

Provide to user:

1. Diff stats from `git show --stat HEAD | tail -5`
2. List of verification commands that passed (paste output excerpts)
3. Manual smoke test recommendation:
   ```bash
   yarn dev  # launches Electron app
   # Test:
   # - Download flow (start/cancel a download)
   # - Extract flow (Schedule I or YAPYAP)
   # - Transfer files (cross-drive if available)
   # - Settings → en ↔ vi switch (verify no missing key warnings)
   # - Library view (recently played, favorites, collections)
   ```
4. Known limitations (per spec section 2 / section 12)

- [ ] **Step 2:** Cleanup audit files

Run: `rm -f docs/superpowers/plans/audit-*.txt`
These are scaffolding, not source.

---

## Self-Review Notes

**Spec coverage check (spec sections → tasks):**

| Spec section                     | Covered by                                     |
| -------------------------------- | ---------------------------------------------- |
| 1 Goal (6 conventions + cleanup) | Phase 4 (4.1–4.7), Phase 5 (5.1–5.6)           |
| 2 Out of scope (5 items)         | Documented, not implemented                    |
| 3.1 Logger                       | Tasks 4.1, 4.2                                 |
| 3.2 T[]                          | Task 4.3                                       |
| 3.3 Named exports                | Tasks 4.4, 4.5                                 |
| 3.4 i18n                         | Task 4.6                                       |
| 3.5 Comments                     | Task 4.7                                       |
| 3.6 TODO markers                 | Task 5.6 + Task 6.1 (rule)                     |
| 3.7 Code style                   | Implicit in Phase 4 manual fixes               |
| 4 Dead code                      | Phase 5 (5.1–5.6)                              |
| 5 ESLint config                  | Phase 6 (6.1, 6.2)                             |
| 6 Execution order                | This document                                  |
| 7 Verification                   | Phase 7 (7.1–7.5)                              |
| 8 Checkpoints                    | Task 7.5 (CP2; CP1 implicit at end of Phase 4) |
| 9 Risk                           | Phase 0 (backup branch) mitigates              |
| 10 Effort                        | ~8h estimate, plan length suggests similar     |
| 11 Final deliverable             | Task 8.2                                       |
| 12 Follow-up                     | Documented, not implemented                    |

**Placeholder scan:** No "TBD" or "implement later" found. Every step has concrete commands.

**Type consistency:** Method signatures not changed (spec section 2 protects IPC contract). New functions: none added.

**Review Focus coverage:**

1. Logger in `main.tsx:39` — Task 4.2 step 5 verifies override preserved.
2. `import/no-default-export` for React — Task 6.1 step 3 sets override.
3. IPC contract — verified by `yarn typecheck` (Phase 7.1).
4. i18n vi fallback — implicit in `i18next` config; covered by `yarn build` not failing.
5. `download-manager.ts` behavior — touched only for convention fixes; if behavior changes, typecheck or build catches it.
