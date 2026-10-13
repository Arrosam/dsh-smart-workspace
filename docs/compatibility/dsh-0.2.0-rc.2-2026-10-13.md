# DSH compatibility report: 0.2.0-rc.2 · 2026-10-13

Release: 2.3.0. Desktop results below are user-reported partial verification; they do not claim a full real-runtime smoke pass.

## Matrix

| Environment | Node | Result | Scope |
| --- | --- | --- | --- |
| DSH Desktop 0.2.0-rc.2 | pending | partial: user confirmed idle-session migration and snapshot reuse; initial return-preview failures and corrections are documented below | adapter status, v4 move, preview; queue resume still pending |
| DSH Web 0.2.0-rc.2 | pending | pending user verification | same smoke flow on web connection |
| Local sandbox fixtures | 22.23.2 | passed: `npm run check`, 171/171 tests, `npm pack --dry-run` | v3/v4 Zstd, plain JSONL, format diagnostics, rollback, queue state transitions, return preview, drop-target identity, explicit target selection, snapshot deduplication |
| Node 24 fixtures | 24 | not run | CI/runtime matrix remains pending |

## Implemented checks

- `filesystem-fallback`, `official-handle`, and `unavailable` adapter modes are reported through `mover.status` and `mover_doctor`.
- Physical operations fail with a stable `unsupported` error when the provider exposes no raw-byte path.
- A running session is persisted in `migrations.json` as `waiting-for-idle`; the queue drains after idle and after plugin re-mount. Process-restart validation remains pending.
- `mover.preview` reports source, target, collision, running state, adapter mode, warnings, and estimated new snapshot bytes; a matching snapshot is reported as reused.
- Recovery snapshots use a SHA-256 fingerprint of session content with migration-only `cwd` normalized. Legacy timestamp-only backup names remain readable. Each migration still records its source, target, and snapshot reference in history.
- Mixed compression is rejected explicitly; no format upgrade is performed. Header-generation mismatch detection only applies when the header declares a recognized generation field.
- The local queue test covers plugin re-mount. A full DSH process restart with a waiting task has not been exercised yet.
- The user confirmed snapshot reuse for an old idle session after moving it; local fixtures cover Zstd, plain JSONL, round trips, and content changes.

## Still requiring a real DSH run

- Official-runtime plain JSONL and v3/v4 fixtures, including mismatch and mixed-layout diagnostics. The local sandbox fixtures are not official DSH runtime evidence.
- Desktop and Web smoke flow with a real session: create, preview, move, verify id/cwd/events, conflict, attach failure and byte-exact rollback.
- Restart DSH while a queue item is waiting, then verify it completes after the session becomes idle.

The next report should replace the pending rows with the exact DSH build, Node version, successful scenarios, and known limits.

## Desktop feedback and correction

The user restarted Desktop and reported all doctor checks passing except the expected filesystem adapter warning. A session moved from `E:\DeepSeekHarness` to `E:\VSCode_Project\quant_research`. Read-only inspection found one `session.v4.jsonl.zstd` primary archive at the destination (419,562 bytes) and no primary archive for that ID at the source. The return preview nevertheless showed both source and target as `quant_research` and incorrectly labelled the session's own archive as a conflict.

The candidate now resolves drop targets from the rendered `data-row-key` workspace ID before React group props and unique text evidence. It refreshes workspace data at drop time and rejects ambiguous text matches. Same-workspace previews distinguish existing membership from an unregistered archive, and report no recovery backup for those operations. Doctor adapter explanations and preview notices are localized; the recovery backup copy is explicitly described as separate from the registered primary session.

The user retested after restart and still received a same-workspace return preview. The exact Desktop event target has not been captured, so the identity-based correction alone is not considered verified. Further changes remove the stale last-hover fallback when dropping outside a header and clear the hover target when leaving a header. Single-session confirmation now offers an explicit workspace selector, refreshes the preview for the selected target and fork scope, and keeps execution disabled while loading or on preview failure. Late preview responses are ignored. These flows have DOM regression coverage; The latest user feedback confirms migration and snapshot reuse, but does not separately document every selector/drag scenario.

## Release checks

- Version 2.3.0: local Node 22.23.2 checks passed, 171/171 tests, syntax checks and npm pack dry-run.
- Regression coverage now includes newest/default versus explicitly selected backup restoration, attachment space estimates, and insufficient-space import refusal before writing.
- README_EN.md and CHANGELOG.md are included in the npm package.
