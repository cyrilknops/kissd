# Changelog

## 2026-11-03

- Fix false guarded-update backup failures for larger PostgreSQL dumps: drain archive input after `pg_restore --list` finishes, preserve its failure status, and keep all service changes gated on successful verification. Name the failing backup step without exposing database stderr. Add regressions for early successful exit and invalid archives.

- Allow guarded projects to track `latest` without approving every release. Resolve each application tag once to immutable digests, reject mixed release revisions and failed pulls, preserve the protected configuration, and retain verified backups, sequential health gates and image rollback.

- Fix the guarded Compose adapter to inspect running service containers through `docker compose`. Add a regression check for a healthy no-op through the complete adapter.

- Add opt-in guarded project updates for explicitly approved image digests. Keep protected services unchanged, check preconditions and backup capacity, verify PostgreSQL archives, replace application services sequentially, check health after each replacement, and restore the previous application pins on failure. Preserve external configuration edits and retain private recovery journals and locks when automatic recovery cannot complete. Enforce the same policy across project and container controls, block overlapping maintenance, and show guarded controls in the dashboard. Include a Loadout approval recipe, strict image-pull handling, self-maintenance markers, automated safety tests, and deployment/recovery guidance.
