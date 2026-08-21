/**
 * Headless integration-test mode (`EQ_E2E=1`), used by `npm run test:e2e`.
 *
 * The user plays EQ while the app runs, so an integration test must never take the
 * screen. This flag makes exactly three behavior changes in the main process — every window
 * stays hidden (`show:false` + no `show()`/`showInactive()` call, in `windows.ts`), the
 * single-instance lock is skipped (so the test instance doesn't quit against the running dev
 * app, in `index.ts`), and the background sound-pack provisioning (network) is suppressed
 * (also `index.ts`). Everything else — the
 * real log scan, the engine, every IPC channel, the renderer bundle — runs untouched, so
 * the test asserts against production behavior.
 *
 * The fourth is newer and narrower (JOS-381): the overlay cursor watchdog takes its cursor from a
 * probe object the harness writes (`globalThis.__eqOverlayPointerWatch`, installed only under this
 * flag — src/main/overlayPointerWatch.ts) instead of from `screen`. A headless run drives
 * Chromium's SYNTHETIC pointer over windows that are never on screen, so the real OS cursor is
 * wherever the machine's owner left it and reading it would tell every hover step in the suite
 * that the pointer had left the window it just entered. Nothing in the product reads the probe.
 *
 * The fifth behavior — `userData` pointed at a fresh temp dir before electron-store is
 * constructed, so a run can never read or clobber the user's real store / errors.log —
 * now lives in `channel.ts`, which owns that decision for all three channels (prod / dev
 * / e2e). This module is a pure flag: zero side effects, zero footprint when the env var
 * is absent, and safe to import from anywhere.
 */
export const E2E = process.env.EQ_E2E === '1'
