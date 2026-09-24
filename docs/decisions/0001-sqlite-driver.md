# ADR 0001: SQLite driver

- Status: Accepted
- Date: 2026-09-24
- Scope: Phase 0 — Foundation

## Context

The implementation plan requires local SQLite persistence but does not name a
Node.js driver or ORM. The repository had no application scaffold or existing
database decision. The project runs on Node.js; the current workspace uses
Node.js 22.22.1.

Choosing a driver affects native dependencies, supported runtimes, Windows
installation, and how persistence code is loaded by Next.js. This choice is
recorded before adding the database integration.

## Decision

Use `better-sqlite3` as the SQLite driver, isolated under `persistence/sqlite`.
Do not add an ORM in Phase 0. Database access belongs to the Node.js server
side; client components must not import the SQLite module.

## Alternatives considered

- `node:sqlite`: avoids a third-party native package, but Node.js 22 currently
  classifies the module as "Active development". This is not a stable
  foundation for project persistence.
- `sqlite3`: supports SQLite from Node.js, but its asynchronous callback API
  adds a wrapper boundary without a Phase 0 use case that benefits from it.
- `better-sqlite3`: synchronous API and transaction support suit the small,
  local database operations expected here. Its project documents prebuilt
  binaries for major platforms and support for currently supported Node.js
  versions.

## Consequences

- SQLite access must stay in the server-side persistence module and use the
  Node.js runtime; it cannot run in an Edge runtime or in browser code.
- The native dependency must be validated on Windows as part of a later
  platform verification; this workspace only verifies its current runtime.
- Future persistence repositories should depend on the `persistence/sqlite`
  boundary rather than importing the driver elsewhere.
- Revisit this decision if desktop packaging or runtime support makes native
  module installation a material constraint.

## References

- [better-sqlite3 README](https://github.com/WiseLibs/better-sqlite3)
- [better-sqlite3 installation troubleshooting](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)
- [Node.js 22 SQLite API](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)
