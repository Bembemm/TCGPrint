# Phase 12 duplex software validation artifacts

These files were generated through exportWorkingCardsByContentMode, the shared duplex page plan, and the existing lossless PDF engine. The portrait run uses A4; the landscape run uses A3. Both use 3×3 slots and long-edge flip. Each face uses an independent, numbered SVG original with an asymmetric TOP arrow. The back PDF vector placement rotates 180° in the two Y-reflection cases so the artwork reads upright after the sheet is flipped.

Each orientation includes front-only, back-only, two separate PDF files, a ZIP containing those same PDFs plus its pairing manifest, and an interleaved duplex PDF. The adjacent manifest records exact page/slot mappings, registration reflection, artwork rotation, and SHA-256 hashes. The global manifest.json records hashes for every generated output and hashes of the numbered SVG and PNG source fixtures.

The production build smoke exercised an imported Delver of Secrets DFC and Sol Ring through the UI, resolved both with Scryfall, chose an alternate DFC back manually, reopened the Project, re-resolved, and confirmed the manual face reference remained unchanged. It uploaded the included numbered PNG into Back Library, saved it as the Project default, and confirmed Sol Ring inherited it while the DFC stayed manual. Production API exports returned HTTP 200 for front-only, back-only, separate (two independent PDFs plus manifest in a ZIP), and duplex. See production-smoke.md for the recorded sequence.

Validation statement: duplex pairing/geometry validated in software. No printer was used; no physical front/back alignment or calibration is claimed.
