# PDF fidelity fixtures

All fixtures in this directory are synthetic and contain no third-party
artwork.

- `synthetic-gradient.jpg` is an 8 × 6 pixel color gradient encoded locally as
  a baseline JPEG.
- `synthetic-rgb.png` is a 4 × 3 pixel RGB grid; its rows use the PNG None
  filter so the test can independently recover every source sample.
- `synthetic-alpha.png` is a 5 × 4 pixel RGBA grid with transparent and partial
  alpha values, also using the PNG None filter.
- `simple-vector.svg` contains a card outline and vector paths at the Magic
  Standard aspect ratio.
- `physical-scale-pattern.svg` contains a 100 × 100 user unit grid for checking
  physical placement without relying on artwork.
