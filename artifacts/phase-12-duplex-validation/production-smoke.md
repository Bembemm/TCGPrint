# Production build UI/API smoke

Run against the optimized Next.js production build at `http://127.0.0.1:3000` on 2026-10-01. The browser loaded the application with HTTP 200; the application used the live Scryfall provider and local Project/Back Library APIs.

1. Imported `Delver of Secrets // Insectile Aberration` and `Sol Ring` through the decklist preview and Working Set UI.
2. Resolved both through Scryfall. The DFC exposed the accessible `Carta dupla-face` signal, Front/Back face selectors, and `Front ↔ Back` preview label. The resolver returned independent Front and Back artwork candidates for the same logical identity.
3. Selected a different Scryfall Back candidate manually. Its persisted reference retained the Scryfall provider asset ID, selected artwork ID, and `faceId: "back"`.
4. Created and reopened the Project. The manual selection remained marked `user-selected`; an explicit re-resolve returned HTTP 200 and preserved the selected Back reference.
5. Uploaded `fixtures/numbered-01-back.png` through Back Library. The asset was content-addressed with SHA-256 `978721c9869e3ed182b33f1726f52ea601e9b2a7a00b04f71e8af0c984e3f34b`. Set it as Project default and confirmed the saved Project v4 snapshot contained only `{ assetId, sha256, format }`.
6. Confirmed the normal Sol Ring card used `backMode: "project-default"` while the DFC retained `backMode: "manual"` and its independently selected Scryfall face.
7. Switched export mode without changing artwork and observed a successful `/api/cards/export` response for each mode:

   | Mode | UI download name | API |
   | --- | --- | --- |
   | front-only | `tcgprint-cards.pdf` | HTTP 200 |
   | back-only | `tcgprint-back.pdf` | HTTP 200 |
   | front-back-separated | `tcgprint-front-back.zip` (contains independent front/back PDFs plus manifest) | HTTP 200 |
   | duplex | `tcgprint-duplex.pdf` (interleaved page order) | HTTP 200 |

The Project reached revision 11 during the smoke. Test Projects were local-only and removed after verification. No physical printer was used. This validates software pairing and export behavior only; physical alignment and calibration remain Phase 13 work.

## Audit fix smoke: provider artwork as a simple card's physical back

After the manual physical-back correction, the optimized production build was opened in Chromium through `agent-browser` on 2026-10-01. The page returned HTTP 200, rendered the import and card controls, and reported no browser page errors.

1. Imported `1 Sol Ring`, confirmed its Scryfall identity, and opened **Escolher artwork como verso manual**.
2. Selected Scryfall artwork `scryfall:8ee443cc-e17a-493b-9c93-1f9e141a30e4:front`. The UI showed `Verso físico manual: Scryfall` and `Manual · user-selected`; the card still had one identity face and no `Carta dupla-face` signal.
3. Created a Project and reopened it. The Project API snapshot retained schema v4, `backMode: manual`, one face, and the exact `manualBackArtwork` candidate/provider IDs, source `faceId: front`, and `selectionPolicy: user-selected`.
4. Generated all four modes from the same Working Card without changing its artwork selection. The browser exposed `tcgprint-cards.pdf`, `tcgprint-back.pdf`, `tcgprint-front-back.zip`, and `tcgprint-duplex.pdf`. The back preview reported `long-edge` with 0° artwork rotation. Automated export tests assert page counts and the ZIP's two independent PDF members.
5. Deleted the temporary local Project after the smoke.

This is a software UI/API smoke. It does not validate printer alignment or calibration.

## Final rebuilt UI/API check after review fixes

After correcting the `back-only` front-artwork gate and reflecting cut overlays in the back preview, `npm run build` completed again. The rebuilt production UI loaded at `http://127.0.0.1:3000/` with HTTP 200 and no browser page errors. Read-only GET checks returned HTTP 200 for `/api/back-library` and `/api/projects`. The corrected mode gate and front/back overlay matrices were exercised by focused tests and the full suite. The complete DFC/manual override/default/all-export interaction sequence above was performed earlier in this implementation run; this final check confirms the latest build and APIs start cleanly. No physical printer was used.
