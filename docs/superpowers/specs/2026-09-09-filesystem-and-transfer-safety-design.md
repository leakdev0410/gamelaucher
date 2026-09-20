# Filesystem and Transfer Safety Design

## Goal

Eliminate the identified path-escape, archive cleanup, transfer consistency,
and image-proxy risks without changing the renderer-facing IPC contracts.

## Design

Introduce a small main-process path helper that resolves a candidate path and
accepts it only when it is contained by an explicitly supplied root. It uses
case-insensitive comparison on Windows and rejects the root itself when a file
is expected. Temp-file creation will reduce the supplied file name to a base
name, while all asset deletion paths will be constrained to `ASSETS_PATH`.

Archive deletion will locate the owning download by testing containment within
that download's persisted `downloadPath/folderName` directory. It will only
delete regular archive files, leaving directories and unrelated files alone.

Game transfers will treat symlinks/junctions as unsupported and fail before
copying, preserve source ownership until the old root is removed, and return a
specific cleanup error if removal fails. The LevelDB record is changed only
after source removal succeeds, so a successful result is a true move.

The image proxy will retain the HTTPS, redirect, byte-limit and address checks,
but resolve the target immediately before every fetch and reject addresses that
are private, loopback, link-local, multicast, unspecified, or carrier-grade
NAT. This narrows DNS-rebinding exposure without adding a custom network stack.

## Error Handling

IPC calls reject unsafe paths. Archive deletion retains its existing boolean
failure result. Transfers emit the existing error event and return `ok: false`
when encountering links or when source cleanup fails; source data remains
intact in the latter case.

## Verification

This repository has no automated test runner. Verification will use TypeScript
checking, ESLint, a production build, and focused static checks over each
security invariant. Future unit tests should be added with Node's test runner
once TypeScript test execution is configured.
