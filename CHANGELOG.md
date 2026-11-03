# Changelog

## 2026-11-03

- Fix the guarded Compose adapter to inspect running service containers through `docker compose`. Add a regression check for a healthy no-op through the complete adapter.

- Add opt-in guarded project updates for explicitly approved image digests. Keep protected services unchanged, check preconditions and backup capacity, verify PostgreSQL archives, replace application services sequentially, check health after each replacement, and restore the previous application pins on failure. Preserve external configuration edits and retain private recovery journals and locks when automatic recovery cannot complete. Enforce the same policy across project and container controls, block overlapping maintenance, and show guarded controls in the dashboard. Include a Loadout approval recipe, strict image-pull handling, self-maintenance markers, automated safety tests, and deployment/recovery guidance.
