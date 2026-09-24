# TCGPrint

## Development

Use Node.js `^22.12.0`, `^24.0.0`, or `>=26.0.0`, then install the locked
dependencies and start the development server:

```sh
npm ci
npm run dev
```

The SQLite driver uses a native install script. The package manifest allows it
for the locked `better-sqlite3` version; review that entry when updating the
driver. Useful checks are `npm test`, `npm run typecheck`, and `npm run build`.
