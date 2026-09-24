# Bleed fixtures

- `synthetic-edge-card.png` is an authored 254 × 356 RGBA pattern with
  independent high-contrast corners, per-channel gradients, and varying
  transparency. It is used to verify exact trim samples, symmetric dimensions,
  edge-strip generation, corner joins, and alpha preservation without
  third-party artwork.
- 16-bit bleed checks reuse the tiny RGB, RGBA, and `tRNS` PNG fixtures in
  `../pdf/`, whose expected sample values are documented in the PDF fidelity
  tests.
