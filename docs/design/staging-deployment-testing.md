# Staging deployment: testing approach

Companion notes for testing the Authentik SSO feature (#8) and the
offline-box-sync roles (`SYNC_ROLE=central`/`box`) on a staging deployment,
before either ships to production. Not yet implemented — this documents the
approach and a bug found while scoping it.

## Empty-DB migration bug (found, already fixed on `fork/main`)

**Symptom:** `pnpm migration:run` against a truly empty database fails with
`type "organization_role" does not exist`. Every migration after the first
is a delta on a base schema that has to already exist.

**Root cause:** `src/database/migrations/1700000000000-InitialSchema.ts`
creates that base schema (tables + enums, incl. `organization_role`) from
nothing. It was deleted upstream (`4076a4b "Add some stuff"`), which breaks
every fresh install using that upstream state. This fork already restored
it (`cd14f16 "fix: restore deleted InitialSchema migration, breaks all
fresh installs (#3)"`), so `fork/main` and every branch cut from it
(including `feat/authentik-sso`) should not hit this — needs the
verification below to confirm, not just file presence.

**Proposed fix, if this ever regresses again** (e.g. another upstream sync
deletes it, or a future migration assumes undocumented pre-existing state):

1. Reproduce: fresh empty Postgres (`docker run postgres:16-alpine`,
   no prior state), `DATABASE_MIGRATIONS_RUN` off, run
   `pnpm typeorm migration:run -d src/config/data-source.ts` directly and
   confirm it fails on the first delta migration.
2. Fix by diffing the *original* base schema, not current entities: find
   the commit just before the first tracked delta migration was added,
   check out entities as of that commit, `schema:sync` them into a scratch
   DB, then `typeorm migration:generate` an empty DB against that scratch
   DB — this captures the original base, not the final accumulated state.
   Generating against *current* entities instead would recreate the full
   final schema in one migration and collide with every delta that runs
   after it.
3. Name/timestamp it so it sorts before the current earliest migration.
4. Verify per the procedure below before merging.

**Regression guard worth adding** (not yet done): a CI job that spins up a
throwaway Postgres and runs `pnpm migration:run` against it on every PR —
would have caught the upstream deletion immediately instead of surfacing
as a silent fresh-install failure.

**Verification procedure** (run this before trusting a fresh install
works, staging or otherwise):
```bash
docker run -d --name openeos-scratch-pg \
  -e POSTGRES_USER=openeos -e POSTGRES_PASSWORD=scratch -e POSTGRES_DB=openeos \
  -p 55432:5432 postgres:16-alpine
# point DATABASE_HOST/PORT at localhost:55432 in .env, then:
pnpm migration:run
# should exit 0 against a container that has never seen this schema before
```

## Staging test approach (central + box, fresh install + update)

Central and box each need a **full independent stack** (own api, web,
postgres, redis) — a "box" is a standalone mini-deployment (same shape as
`docker-compose.airgap.yml`), not a lightweight agent talking to a shared
DB. So staging is two persistent stacks, not four — "fresh" and "update"
are *procedures* run against those same two stacks, not separate
environments:

- **Fresh install**: `docker compose down -v` (wipe volumes) then `up -d`
  on both central and box — proves migrations (including the InitialSchema
  one above) run clean from empty on both roles. This is the scenario that
  silently broke upstream and would have shipped unnoticed without a
  staging deployment to catch it.
- **Update**: with data intact, pull a newer image tag and `up -d` — proves
  a schema migration (e.g. this PR's `password_hash` now nullable, new
  `sso_provider`/`sso_subject` columns) applies cleanly against a
  populated `users` table, and existing sessions/logins keep working.
- **SSO check**: log in via "Anmelden mit Authentik" on central, confirm
  the redirect round-trip and that a new SSO user gets created/linked by
  email.
- **Sync check**: seed one `RentalAssignment` + `syncToken` in central's
  DB, confirm box's `SyncPushService` (15s interval) successfully POSTs to
  central's `/sync/push` and rows land in `sync_inbox`.

Deployment mechanics (host, CI/CD wiring, Ansible stack definition) are
tracked separately, not part of this note.
