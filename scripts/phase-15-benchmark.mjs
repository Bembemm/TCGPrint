import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const phase = process.argv[2] ?? "baseline";
if (phase !== "baseline" && phase !== "optimized") {
  process.stderr.write("Usage: npm run benchmark:phase15 -- [baseline|optimized]\n");
  process.exit(2);
}

if (phase === "baseline") {
  const expectedBaseSha = "18bcad3916b2ff2137ca3f1bfa747236e69c4072";
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
  if (head !== expectedBaseSha || trackedChanges) {
    process.stderr.write("Baseline mode only runs at the required base SHA with no tracked production changes. Use a temporary worktree at that SHA and copy the benchmark harness there.\n");
    process.exit(2);
  }
}

const runCount = 3;
const artifactDirectory = resolve("artifacts/phase-15-performance");
const runs = [];

for (let run = 1; run <= runCount; run += 1) {
  const outputName = `${phase}-run-${run}`;
  const child = spawn(process.execPath, [
    resolve("node_modules/vitest/vitest.mjs"),
    "run",
    "tests/performance/phase-15-performance.test.ts",
    "--maxWorkers=1",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PHASE15_PROFILE: "1", PHASE15_OUTPUT: outputName, PHASE15_RUN_INDEX: String(run - 1) },
    stdio: "inherit",
  });

  const exitCode = await new Promise((resolveExit) => {
    child.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolveExit(1);
    });
    child.on("close", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    process.exit();
  }
  runs.push(JSON.parse(await readFile(join(artifactDirectory, `${outputName}.json`), "utf8")));
}

const first = runs[0];
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const aggregateScenarios = first.scenarios.map((scenario, index) => {
  const samples = runs.map((run) => run.scenarios.find((sample) => sample.name === scenario.name));
  if (samples.some((sample) => !sample)) throw new Error(`Benchmark scenario ${scenario.name} is missing from a repeated run.`);
  const wallTimeSample = samples.reduce((best, current) => current.wallTimeMs < best.wallTimeMs ? current : best);
  return {
    ...wallTimeSample,
    wallTimeMs: median(samples.map((sample) => sample.wallTimeMs)),
    cpuUserMs: median(samples.map((sample) => sample.cpuUserMs)),
    cpuSystemMs: median(samples.map((sample) => sample.cpuSystemMs)),
    rssBeforeBytes: median(samples.map((sample) => sample.rssBeforeBytes)),
    rssPeakSampledBytes: median(samples.map((sample) => sample.rssPeakSampledBytes)),
    rssAfterBytes: median(samples.map((sample) => sample.rssAfterBytes)),
    heapBeforeBytes: median(samples.map((sample) => sample.heapBeforeBytes)),
    heapPeakSampledBytes: median(samples.map((sample) => sample.heapPeakSampledBytes)),
    heapAfterBytes: median(samples.map((sample) => sample.heapAfterBytes)),
    peakEventLoopDelayMs: median(samples.map((sample) => sample.peakEventLoopDelayMs)),
    rawRuns: samples.map((sample) => ({
      wallTimeMs: sample.wallTimeMs,
      cpuUserMs: sample.cpuUserMs,
      cpuSystemMs: sample.cpuSystemMs,
      rssBeforeBytes: sample.rssBeforeBytes,
      rssPeakSampledBytes: sample.rssPeakSampledBytes,
      rssAfterBytes: sample.rssAfterBytes,
      heapBeforeBytes: sample.heapBeforeBytes,
      heapPeakSampledBytes: sample.heapPeakSampledBytes,
      heapAfterBytes: sample.heapAfterBytes,
      peakEventLoopDelayMs: sample.peakEventLoopDelayMs,
      details: sample.details,
    })),
  };
});

const outputPath = join(artifactDirectory, `${phase}.json`);
await mkdir(artifactDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify({
  ...first,
  recordedAt: new Date().toISOString(),
  methodology: {
    ...first.methodology,
    runsPerScenario: runCount,
    aggregation: "Each scenario is run once in three independent Node/Vitest processes; output values are medians, with per-run measurements retained in rawRuns.",
  },
  scenarios: aggregateScenarios,
}, null, 2)}\n`, "utf8");
await Promise.all(runs.map((run, index) => rm(join(artifactDirectory, `${phase}-run-${index + 1}.json`), { force: true })));
