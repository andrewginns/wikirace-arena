import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.BENCHMARK_DASHBOARD_BASE_URL || "http://localhost:5173",
    headed: false,
    outDir:
      process.env.BENCHMARK_DASHBOARD_OUT_DIR ||
      path.join("results", "ui-validation", "benchmark-dashboard", "final"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--headed") {
      args.headed = true;
      continue;
    }
    if (arg === "--base-url") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --base-url");
      args.baseUrl = value;
      i += 1;
      continue;
    }
    if (arg === "--out-dir") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --out-dir");
      args.outDir = value;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    throw new Error(`Unknown arg: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Benchmark dashboard regression runner

Usage:
  yarn play:benchmark-dashboard
  yarn play:benchmark-dashboard --headed
  yarn play:benchmark-dashboard --base-url http://localhost:5173
  yarn play:benchmark-dashboard --out-dir results/ui-validation/benchmark-dashboard/final

Notes:
- Assumes the UI server is already running.
- Requires Playwright browsers (Chromium): yarn playwright install chromium
`);
}

async function disableMotion(page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        transition: none !important;
        animation: none !important;
        scroll-behavior: auto !important;
        caret-color: transparent !important;
      }
    `,
  });
}

async function modelNameFromRow(row) {
  const text = await row.locator("td").nth(1).innerText();
  return (text.split("\n")[0] || "").trim();
}

async function captureLocator(locator, outputPath) {
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({ path: outputPath, animations: "disabled" });
}

async function choosePair(page, rankingRows) {
  const rowCount = await rankingRows.count();
  if (rowCount < 2) {
    throw new Error(`Expected at least two ranking rows, found ${rowCount}`);
  }

  const topQualityModel = await modelNameFromRow(rankingRows.first());
  const fallbackModel = await modelNameFromRow(rankingRows.nth(1));

  await page.getByRole("button", { name: /Mean run cost/i }).click();
  await rankingRows.first().waitFor();
  await page.waitForTimeout(100);
  const cheapestModel = await modelNameFromRow(rankingRows.first());

  await page.getByRole("button", { name: /^Rank\b/i }).click();
  await rankingRows.first().waitFor();
  await page.waitForTimeout(100);

  return {
    leftModel: topQualityModel,
    rightModel: cheapestModel !== topQualityModel ? cheapestModel : fallbackModel,
  };
}

async function selectPairwiseModel(page, index, optionLabel) {
  const triggers = page.getByTestId("pairwise-panel").locator('button[role="combobox"]');
  await triggers.nth(index).click();
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const browser = await chromium.launch({ headless: !args.headed });
  const checks = [];
  try {
    const outDir = path.resolve(args.outDir);
    await fs.mkdir(outDir, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: 1600, height: 2200 },
      colorScheme: "light",
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.setDefaultNavigationTimeout(60_000);

    await page.goto(args.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await disableMotion(page);

    await page.getByRole("tab", { name: "Leaderboard" }).click();
    await page.getByText(/^(Frontier 200|Leaderboard)$/).waitFor();
    await page.getByText("Show detailed analysis", { exact: true }).click();
    await page.getByTestId("leaderboard-overview").waitFor();
    await page.getByTestId("tradeoff-frontiers").waitFor();
    await page.getByTestId("pairwise-panel").waitFor();
    await page.getByTestId("pricing-method-note").waitFor();
    await page.getByTestId("focused-analysis").waitFor();

    const rankingTable = page.locator("table").first();
    const rankingRows = rankingTable.locator("tbody tr");
    await rankingRows.first().waitFor();
    const rowCount = await rankingRows.count();
    checks.push({ name: "leaderboard-has-rows", passed: rowCount >= 10, rowCount });

    const frontierCount = await page.getByTestId("tradeoff-frontiers").locator("svg").count();
    checks.push({
      name: "three-tradeoff-frontiers-render",
      passed: frontierCount === 3,
      frontierCount,
    });

    const passSnapshotVisible = await page.getByText("Success-rate snapshot", { exact: true }).isVisible();
    const pairwiseVisible = await page.getByText("Compare models", { exact: true }).isVisible();
    const pricingNoteVisible = await page.getByText(/Price uses mean run cost across all attempts/i).isVisible();
    checks.push({
      name: "comparison-cockpit-renders",
      passed: passSnapshotVisible && pairwiseVisible && pricingNoteVisible,
    });

    const { leftModel, rightModel } = await choosePair(page, rankingRows);
    await selectPairwiseModel(page, 0, `A · ${leftModel}`);
    await selectPairwiseModel(page, 1, `B · ${rightModel}`);
    checks.push({
      name: "pairwise-models-selected",
      passed: Boolean(leftModel) && Boolean(rightModel) && leftModel !== rightModel,
      leftModel,
      rightModel,
    });

    await rankingRows
      .filter({ has: page.getByText(leftModel, { exact: true }) })
      .first()
      .click();
    await page.getByTestId("focused-analysis").waitFor();

    const screenshots = {
      leaderboardFull: path.join(outDir, "leaderboard-full.png"),
      leaderboardOverview: path.join(outDir, "leaderboard-overview.png"),
      priceFrontier: path.join(outDir, "price-frontier.png"),
      pairwisePanel: path.join(outDir, "pairwise-panel.png"),
      focusedAnalysis: path.join(outDir, "focused-analysis.png"),
      viewerFull: path.join(outDir, "viewer-full.png"),
    };

    await page.screenshot({
      path: screenshots.leaderboardFull,
      fullPage: true,
      animations: "disabled",
    });
    await captureLocator(page.getByTestId("leaderboard-overview"), screenshots.leaderboardOverview);
    await captureLocator(page.getByTestId("price-frontier"), screenshots.priceFrontier);
    await captureLocator(page.getByTestId("pairwise-panel"), screenshots.pairwisePanel);
    await captureLocator(page.getByTestId("focused-analysis"), screenshots.focusedAnalysis);

    await page.evaluate(() => {
      window.localStorage.removeItem("wikirace:viewer-datasets:v1");
    });

    await page.getByTestId("open-viewer-primary").click();
    await page.waitForFunction(() => {
      const raw = window.localStorage.getItem("wikirace:viewer-datasets:v1");
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.datasets) && parsed.datasets.length > 0;
      } catch {
        return false;
      }
    });
    await page.getByRole("tab", { name: "View Runs" }).click();
    await page.getByRole("heading", { name: "Runs", exact: true }).waitFor();
    await page
      .getByText("Loading dataset...", { exact: true })
      .waitFor({ state: "hidden", timeout: 15_000 })
      .catch(() => null);
    const viewerEmpty = await page
      .getByText("No runs available.", { exact: true })
      .isVisible()
      .catch(() => false);
    const savedBenchmarkSelected = await page
      .getByText("Saved:", { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    checks.push({
      name: "open-in-viewer-renders-runs",
      passed: savedBenchmarkSelected && !viewerEmpty,
      savedBenchmarkSelected,
      viewerEmpty,
    });
    await page.screenshot({
      path: screenshots.viewerFull,
      fullPage: true,
      animations: "disabled",
    });

    const storedViewerDatasets = await page.evaluate(() => {
      const raw = window.localStorage.getItem("wikirace:viewer-datasets:v1");
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.datasets)
          ? parsed.datasets.map((item) => item?.name).filter(Boolean)
          : [];
      } catch {
        return [];
      }
    });
    checks.push({
      name: "open-in-viewer-populates-viewer-datasets",
      passed: Array.isArray(storedViewerDatasets) && storedViewerDatasets.length > 0,
      datasets: storedViewerDatasets,
    });

    const output = {
      generated_at: new Date().toISOString(),
      base_url: args.baseUrl,
      out_dir: outDir,
      screenshots,
      checks,
    };
    await fs.writeFile(
      path.join(outDir, "playwright-validation.json"),
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8"
    );

    if (checks.some((check) => !check.passed)) {
      throw new Error(`Benchmark dashboard regression failed: ${JSON.stringify(checks, null, 2)}`);
    }

    console.log(JSON.stringify({ ok: true, output }, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (err) {
  console.error("Benchmark dashboard regression suite failed");
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
}
