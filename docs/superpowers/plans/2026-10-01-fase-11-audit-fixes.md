# Fase 11 audit fixes

## Scope

Fix the two blocking findings and the alternate-source comparison finding on `feature/fase-11-svg-dxf-cut-export`, keeping `main` at the audited base.

## Steps

1. Add failing regressions for shared physical pagination, bounded standard DXF structure handling, and semantic alternate geometry comparison.
2. Extract page placement batching into `core/geometry` and use it from the PDF engine, cut layout resolver, and sheet preview; represent cut output as explicit per-page layouts and require a page selector for multi-page exports.
3. Extend bounded DXF parsing to skip only allowlisted standard non-geometric sections/tables while continuing to parse LAYER and reject unsupported ENTITIES such as INSERT.
4. Add conservative physical equivalence for closed linear paths that ignores start vertex and winding; return `not-compared` for curves that cannot be safely normalized.
5. Update ADR/UI, run all requested focused and full gates, review the complete diff, commit, and push only the feature branch.

## Verification

Run pagination/PDF synchronization, SVG/DXF parser and export, alternate source, cut API, project/autosave/recovery, and template library suites, then `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check c071fced0e4636a3340b26a75cd122b5e68f2837..HEAD`. Verify feature branch, remote target, and unchanged `main` before and after the push.
