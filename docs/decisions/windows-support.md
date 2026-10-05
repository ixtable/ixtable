# Windows support

Status: accepted, pending Windows CI. Windows is a release-blocking platform (PRD §6.1).
Green Desktop CI on Windows, macOS, and Linux is the `green-ci-all-os` gate in
[the release gates](../release-checklist.md).

## What failed

On `windows-latest` at commit d4eb6c3:

1. The Rust unit tests: 15 failed with `Access is denied. (os error 5)`. They
   covered checkpoints, installation, cloud install, and the DuckDB extension unpack.
2. Every golden integration file failed to load the NAPI test bridge DLL with
   `The specified procedure could not be found.` That is Windows error 127: the
   DLL was found, but one of its imported functions was not.

## Causes and changes

**`bundle::write_atomic` (high confidence).** It wrote the temp file with
`fs::write`, then reopened it with `File::open` and called `sync_all`. On Windows
`sync_all` calls `FlushFileBuffers`, which needs write access. A read-only handle
gets error 5. Every installation (`bundle.json`) and every checkpoint sidecar goes
through this function, which explains the checkpoint, installation, and cloud
failures. The fix syncs through the handle that wrote the file.
`archive_io::write` already opened its handle read-write.

**DuckDB extension test (high confidence).** DuckDB never unloads an extension it
has loaded, and Windows cannot delete a loaded DLL. The test now drops the
connection and treats cleanup as best-effort on Windows only.

**Missing `icons/icon.ico` (fixed).** `tauri-build` needs `icon.ico` to generate
the Windows resource file, so every Windows Rust build failed before any test ran.
`src-tauri/icons/icon.ico` is now committed.

**Test bridge load error 127 (medium confidence).** napi-sys 2 resolves `napi_*`
functions at runtime through `libloading` on Windows, so N-API imports are not the
cause. `tauri-runtime-wry` and `rfd` import `TaskDialogIndirect` from `comctl32.dll`.
Only Common Controls v6 exports it, and v6 is bound only when the host executable's
manifest asks for it. `tauri-build` adds that manifest to the app binary. `node.exe`
does not have one, so Windows binds v5 and the load fails. `build.rs` now passes
`/DELAYLOAD:comctl32.dll` for the cdylib on MSVC when the `test-bridge` feature is
on. The import is then resolved only if a dialog is shown, which tests never do.

## Not yet verified

None of this has run on Windows, so the delay-load fix is pending Windows CI
verification. The Windows `test` and golden jobs both print the bridge
DLL's imports with `dumpbin /imports` (non-blocking), right after the bridge build. If the load still fails, that
output names the DLL and function. If the cause is not `comctl32`, delay-load that
DLL in the same way or remove the import. We also checked directory renames and
open handles in the installation paths (`install_fresh`, `update_existing`,
`checkpoint`). SQLite connections are closed before every rename, and no rename
targets an existing directory. We made no changes there.

## First Windows runs (2026-10-05)

Runners came back on 2026-10-05. The first Windows runs of `desktop.yml` showed
that the Rust unit tests and the test bridge DLL load now pass, so the
`write_atomic`, extension-cleanup and `comctl32` delay-load changes above work.
The integration and golden jobs failed for these reasons:

- **`global.db` setup race (product bug, fixed).** `GlobalStorage::connection`
  in `storage.rs` checked for the recovery `dirty` column and ran `ALTER TABLE`
  on every connection. Two connections opening at once both ran it, and the
  second failed with `duplicate column name: dirty`, so creating an app from a
  template showed `IO_ERROR`. Fresh databases now create the columns, older
  ones are upgraded inside an `IMMEDIATE` transaction that checks again, and
  setup retries on `SQLITE_BUSY`. Windows timing exposed it, but the bug was not
  Windows-specific.
- **Path splitting in a test (fixed).** `persistence.test.tsx` took a file name
  with `split("/")`. It now uses `path.basename`.
- **State directory cleanup (fixed).** `tests/integration/setup.ts` deletes its
  temporary state directory after each file. Windows refuses while the process
  holds the unpacked DuckDB extension DLLs, so that cleanup is best-effort on
  Windows only.
- **Not yet diagnosed:** an async-trigger test in `automation.test.tsx` timing
  out, `migrations.test.tsx` not finding the second migration editor, and
  `sql-and-metadata.test.tsx` not finding the query status. None showed an error
  in the UI. The next Windows run with the fixes above decides whether they
  remain.

The `dumpbin /imports` diagnostic step stays until the Windows jobs are green.

## Audit log

- 2026-10-05: added the `icon.ico` fix, the CI status on main (no runner was
  ever assigned), and the link to the release gates. The pending items are
  unchanged.
- 2026-10-05 (later): runners returned. Recorded the first Windows results and
  the three fixes (global.db race, basename, state dir cleanup).
