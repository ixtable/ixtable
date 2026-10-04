# Windows support

Status: accepted, pending Windows CI. Windows is a release-blocking platform (PRD §6.1).

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

**Test bridge load error 127 (medium confidence).** napi-sys 2 resolves `napi_*`
functions at runtime through `libloading` on Windows, so N-API imports are not the
cause. `tauri-runtime-wry` and `rfd` import `TaskDialogIndirect` from `comctl32.dll`.
Only Common Controls v6 exports it, and v6 is bound only when the host executable's
manifest asks for it. `tauri-build` adds that manifest to the app binary. `node.exe`
does not have one, so Windows binds v5 and the load fails. `build.rs` now passes
`/DELAYLOAD:comctl32.dll` for the cdylib on MSVC when the `test-bridge` feature is
on. The import is then resolved only if a dialog is shown, which tests never do.

## Not yet verified

None of this has run on Windows. The Windows golden job now prints the bridge
DLL's imports with `dumpbin /imports` (non-blocking). If the load still fails, that
output names the DLL and function. If the cause is not `comctl32`, delay-load that
DLL in the same way or remove the import. We also checked directory renames and
open handles in the installation paths (`install_fresh`, `update_existing`,
`checkpoint`). SQLite connections are closed before every rename, and no rename
targets an existing directory. We made no changes there.
