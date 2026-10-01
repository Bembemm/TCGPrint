import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true },
});

try {
  const { generatePhase12Artifacts } = await server.ssrLoadModule("/scripts/generate-phase-12-duplex-artifacts.ts");
  await generatePhase12Artifacts();
} finally {
  await server.close();
}
