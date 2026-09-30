# ADR 0012: Silhouette template library persistence and identity

- Status: Accepted
- Date: 2026-09-30
- Related: ADR 0010, Project Persistence; Implementation Plan Phase 9

## Context

Projects must retain the exact Silhouette template version used to prepare a print. Official `.studio3` files are opaque inputs and must remain byte-for-byte intact. Template metadata and library updates must never rewrite those originals or migrate existing Projects to a newer version. ZIP uploads are untrusted and must use the protections already implemented by Universal Import.

## Decisions

1. The Projects SQLite database advances incrementally from schema version 1 to version 2. It adds `templates`, `template_versions`, `template_files`, and separate canonical and recovery selection relations. Composite foreign keys bind each Project selection to `(template_id, version, package_hash)`.
2. File bytes live in a separate private, content-addressed store beneath `.tcgprint/template-originals`. The path is derived only from lowercase SHA-256. Files are create-only; deduplicated identical bytes share a blob. Metadata deletion never removes a blob.
3. A package hash is SHA-256 over canonical JSON containing normalized version metadata and associated files sorted by safe relative path, including each path, per-file SHA-256, and byte length. ZIP uploads are retained as original associated files and their supported entries are also retained as associated files.
4. Repeating a byte-identical import for the same template and version is idempotent. Reusing that version with different metadata, paths, bytes, or hashes is a conflict. A new version requires the existing logical template ID and stable name/source.
5. Project snapshots remain schema version 1. Template selection is persisted in relational rows and is included in the autosave/recovery request envelope. Reopen, duplicate, recovery promotion, and recovery copy preserve the full template ID/version/package hash tuple.
6. Library deletion is rejected while any canonical Project or staged recovery refers to any version. Project deletion cascades only its relational selections. Unreferenced template metadata can be removed, while immutable content blobs remain available and may be shared.
7. Projects with missing or corrupt originals keep their recorded selection. Verification reports `missing`, `corrupt`, or `hash-mismatch`; no newer version is substituted automatically.
8. ZIP ingestion reuses `expandZipSource`. Traversal and symlink entries fail the whole template import. Limits are 32 uploads, 100 MiB total uploaded bytes, 50 MiB per non-ZIP file, 100 MiB per ZIP, 500 associated entries, 50 MiB per expanded entry, 200 MiB total expanded bytes, and compression ratio 100. Nested ZIPs are rejected. No entry is written as a filesystem path.
9. `.studio3` is only bounded, hashed, and stored. SVG receives safe XML well-formedness/root validation; DXF receives minimal structural validation; JSON receives bounded syntax/tree validation. No geometry is extracted or used for cut export in Phase 9.

## Consequences

- Older Projects remain reproducible after later template versions are uploaded.
- Identical file bytes consume one immutable blob even when referenced by multiple template versions.
- Removing a template can leave unreferenced blob files on disk; cleanup requires a future ownership-aware garbage collector.
- ZIP packages with nested archives are intentionally unsupported in Phase 9.
- Geometry interpretation, Registration, calibration, PDF alignment, and Cut Export remain future phase work.
