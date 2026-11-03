# Guarded project updates

A project can opt into an owner-managed `kissd-update.json` in its Compose working
directory. The file must be a regular file without group/world write permission.
Malformed policies fail closed. Projects without a policy keep their normal
update controls; image-pull failures now stop before recreation.

Guarded updates support **approved pins** and opt-in **latest tracking**. In latest
mode the button reads **Update latest**. One click pulls the configured application
repositories' `:latest` tags, resolves them once to immutable digests, verifies a
matching Git revision across the application images, and deploys that snapshot.
No new approval is required for each release. A tag moving during deployment cannot
change its target. A failed pull, missing digest or mixed release stops before any
service or Compose source changes. Database images are never tracked or updated.

Latest tracking trusts the configured repositories' publishing process. It does not
independently verify GitHub CI or prove that a future migration is compatible with
rollback. Publish compatible releases to `latest`; handle destructive schema changes
separately. Credentials stay in kissd's registry settings.

## Loadout approval

First set the desired API/replica/web image digests in the Compose file and pull
those exact images. Verify their OCI revision labels, the successful main workflow,
and compatibility with the current database schema. Run the included approval
helper inside kissd. For example:

```sh
docker exec kissd node tools/approve-loadout-update.mjs \
  --project loadout-staging \
  --revision <40-character-commit> \
  --origin https://dev.loadout.be \
  --ci-run https://github.com/iwg-it/iwg/actions/runs/<run-id> \
  --backward-compatible --latest
```

Use project `loadout` and origin `https://game.loadout.be` for live. Run the dev
update and functional checks before live. This is a one-time setup for the named
application repositories. Later releases need only a click on **Update latest**.
The helper records the initial owner-verified CI URL; it does **not** independently
authenticate to GitHub to verify future releases. Omit `--latest` to keep explicit
approval for every release.

For another compatible project, add `imageTags` to its policy, with one
`service: "repository:latest"` entry for each selected application service. Each
repository must match that service's initial `approvedImages` entry. The current
Compose and running images must already be pinned. Existing policies without
`imageTags` retain their approved-pin behavior. All selected latest images must
have the same 40-character `org.opencontainers.image.revision` label.

Approval stores a hash of the complete effective Compose configuration with only
the selected application image fields removed. Changes to environment variables,
ports, volumes, database image, networks or other settings require fresh owner
review and approval. The helper does not print resolved configuration or credentials.
Private registries must be configured in kissd's Settings for images not already
available locally.

The Loadout recipe requires:

- No running or paused games before mutation.
- Two ready API instances with distinct IDs and exactly one MQTT ingest owner.
- Healthy public `/api/health` and `/venues` responses.
- A fresh follower-first API order, followed by the web service.
- PostgreSQL excluded from the service replacement list.

The recipe uses `docker`, Node inside the web container, `curl`, and the existing
PostgreSQL tools. It does not install host software or send release emails.

## Update behavior

1. Read the policy and effective Compose configuration. Refuse configuration drift
   or unpinned current images. Resolve latest tags once when configured, or enforce
   the exact approved digests and revision in approved-pin mode.
2. Resolve the current containers and record protected services. Run preflight and
   health checks. If the target images are already running, report a healthy
   no-op without restarting services or creating a database dump.
3. Save private Compose/environment/policy snapshots and prepare the actual old
   running image pins for rollback. Check free space against PostgreSQL database
   size with additional headroom. Create a custom-format dump and verify its archive
   using `pg_restore --list` before replacing any service.
4. In latest mode, write the resolved application pins to the Compose file only
   after backup verification. Replace each selected service with
   `up -d --no-deps --pull never`. Wait for its
   Docker healthcheck when present, run application health checks, and verify its
   image and restart count. No project-wide `up` runs in this path.
5. If a replacement or health gate fails, write the actual previous image pins back
   to the Compose file and restore touched services in reverse order. Verify health
   and protected services again. A failed update is reported as failed even when
   rollback succeeds. The Compose file then points at the previous images; review the
   failure before retrying. Latest mode resolves the tags again on the next click;
   approved-pin mode requires restoring the desired pins before retrying.

The dashboard disables bulk restart and individual updates for guarded projects.
Save & guarded update / Save & update latest uses the same guarded path. Direct API calls have the same
checks. Concurrent clicks attach to the current deployment; they do not start a
second replacement sequence. Maintenance and deployment startup reserve their work
before awaiting filesystem or Docker operations.

## Recovery and limits

Closing the browser does not cancel a running deployment. A private `.kissd/`
directory in the project contains a per-run `status.json`, configuration snapshots,
rollback Compose file and database archive. The journal records the touched service
before each replacement. These files are not exposed through the Compose backup API.
They can contain secrets and must stay private. An in-directory `.gitignore` excludes
the journal, environment snapshots and database archives from Git. Backups currently require owner-
managed retention; check disk use and remove old backups deliberately.

If kissd or the host stops mid-update, the persistent `update.lock` blocks another
mutation. If automatic rollback fails, it also retains this lock. Inspect the journal
and the actual containers, restore a known compatible release, verify health, and
only then remove that project's lock. Do not clear a lock while its deployment is
still running.

Automatic rollback never restores database data. Image rollback is appropriate only
for releases compatible with the existing schema. A destructive migration or a
failed database needs a separate recovery decision; blindly restoring an old dump
could discard customer data. If configuration changes externally during an update,
automatic rollback stops instead of overwriting those owner edits.

Self-update/restart uses a persistent `self-maintenance.lock` in kissd's data
volume. The detached host script removes it when it exits, including on pull failure.
If launch or host recovery interrupts cleanup, inspect the operation and remove the
marker only after confirming that no self-maintenance is still running.

Guarded updates currently support one Compose file, one container per selected
service, and PostgreSQL backups. They do not support replacing kissd itself through
a guarded project policy. Health checks and the CI approval must match the application;
a successful deployment does not establish its performance capacity. Keep a recovery
window, external backups, and release-specific migration review.

## Reproducible Docker integration check

`integration/guarded-update.mjs` runs inside an isolated candidate panel with its own
fixture password, data volume, Docker socket, and a dedicated empty workspace bind.
It requires `SELF_NAME=kissd-safe-panel-<8-hex-id>` and `KISSD_INTEGRATION_ONLY=1`.
Never set these on the live panel. Supply the workspace path
`.../kissd-safe-checks-<8-hex-id>`, the verified candidate image by digest, and the
installed registry image ID as its three arguments.

The check creates a local-only temporary registry, tiny API/web fixtures and a real
PostgreSQL database. It exercises successful sequential replacement, verified backup,
a healthy no-op, refusal of bypass controls, failed-health rollback, and preservation
of database writes made during rollback. It cleans up its uniquely named stack and
registry. The production database and application projects are not test targets.
