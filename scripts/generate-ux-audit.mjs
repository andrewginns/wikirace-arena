#!/usr/bin/env node

// Generates the screenshots used by `docs/ux-audit/`.
//
// Prereqs:
//   - `yarn add -D playwright`
//   - `npx playwright install chromium`
//
// Usage:
//   node scripts/generate-ux-audit.mjs --base-url http://localhost:5173
//
// Options:
//   --base-url <url>   App URL (default: http://localhost:5173)
//   --out-dir <dir>    Output dir (default: docs/ux-audit)
//   --headed           Run browser headed

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";

const LAST_TAB_STORAGE_KEY = "wikirace:last-tab:v1";
const SEEN_PLAY_TAB_STORAGE_KEY = "wikirace:seen-play-tab:v1";

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : null;
}

const baseUrl =
  getArgValue("--base-url") || process.env.UX_AUDIT_BASE_URL || "http://localhost:5173";
const outDir =
  getArgValue("--out-dir") || process.env.UX_AUDIT_OUT_DIR || path.join("docs", "ux-audit");
const headed = process.argv.includes("--headed");

const viewport = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function saveScreenshot(page, relPath, options = {}) {
  const fullPath = path.resolve(outDir, relPath);
  await ensureDir(fullPath);
  await page.screenshot({ path: fullPath, ...options });
  process.stdout.write(`✓ ${path.join(outDir, relPath)}\n`);
}

async function setLocalStorageAndReload(page, entries) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();

  await page.evaluate(({ entries }) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, value);
      }
    }
  }, { entries });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();
}

async function openViewRuns(page, { showCta }) {
  await setLocalStorageAndReload(page, {
    [LAST_TAB_STORAGE_KEY]: "view",
    [SEEN_PLAY_TAB_STORAGE_KEY]: showCta ? null : "true",
  });
  await page.getByRole("tab", { name: "View Runs" }).click();
  await page.getByRole("heading", { name: "Runs" }).waitFor();
}

async function openPlaySetup(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();
  await page.getByRole("tab", { name: "Play Game" }).click();

  // If the setup card is collapsed, "New race" expands it.
  const newRace = page.getByRole("button", { name: "New race" });
  if (await newRace.isVisible().catch(() => false)) {
    await newRace.click();
  }

  await page.getByRole("heading", { name: "Start a race" }).waitFor();
  await page.getByText("Setup steps").waitFor();
}

async function selectComboboxValue(page, comboboxLocator, value) {
  await comboboxLocator.click();
  const search = page.getByPlaceholder("Search items...");
  await search.waitFor();
  await search.fill(value);

  const option = page.getByRole("option", { name: value, exact: true }).first();
  await option.waitFor();
  await option.click();
}

async function setStartAndTarget(page, { start, target }) {
  const pagesSection = page.locator("#pages-section");
  const combos = pagesSection.getByRole("combobox");
  await selectComboboxValue(page, combos.nth(0), start);
  await selectComboboxValue(page, combos.nth(1), target);
}

async function clickQuickPreset(page, presetId) {
  const presetLocator =
    presetId === "you_vs_fast"
      ? page.getByRole("button", { name: /You vs AI \(fast\)/ })
      : presetId === "you_vs_two"
      ? page.getByRole("button", { name: /You vs 2 AIs/ })
      : presetId === "model_showdown"
      ? page.getByRole("button", { name: /Model showdown/ })
      : page.getByRole("button", { name: /Hotseat \(2 humans\)/ });

  await presetLocator.click();
  await sleep(200);
}

async function openAdvancedModal(page) {
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("dialog", { name: "Advanced race settings" }).waitFor();
  await page.getByText("Race length presets").click();
  await sleep(200);
}

async function closeAdvancedModal(page) {
  await page.getByRole("button", { name: "Done" }).click();
  await sleep(150);
}

async function startRace(page) {
  const startRaceButton = page.getByRole("button", { name: "Start race", exact: true });
  await startRaceButton.click();
  await page.getByText("Leaderboard").waitFor({ timeout: 15_000 });
}

async function selectHumanRun(page) {
  const runButton = page.getByRole("button", { name: /^Select run You/ }).first();
  await runButton.click();
  await sleep(200);
}

async function setHumanArticleMode(page, mode) {
  const tabs = page.getByRole("tab", { name: mode, exact: true });
  await tabs.click();
  await sleep(200);
}

async function winFromCapybaraToRodent(page) {
  await selectHumanRun(page);
  await page.getByRole("tab", { name: "Article" }).click();
  await sleep(500);
  await setHumanArticleMode(page, "Links");
  await page.getByRole("button", { name: "Rodent", exact: true }).waitFor();
  await page.getByRole("button", { name: "Rodent", exact: true }).click();
  await page.getByRole("button", { name: "Dismiss win message" }).waitFor({ timeout: 10_000 });
}

async function main() {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  try {
    // View Runs (baseline)
    await openViewRuns(page, { showCta: false });
    await saveScreenshot(page, "screenshots/playwright-home-view-runs.png");

    // Let autoplay select a run (adds the "Active" indicator).
    await page.getByText("Active").first().waitFor({ timeout: 8_000 });
    await saveScreenshot(page, "screenshots/playwright-view-runs-selected.png");

    // Toggle wins-only off
    const winsToggle = page.getByRole("button", { name: /Wins only:/ });
    const winsToggleLabel = (await winsToggle.textContent()) ?? "";
    if (winsToggleLabel.includes("On")) {
      await winsToggle.click();
      await page.getByRole("button", { name: "Wins only: Off" }).waitFor();
    }
    await saveScreenshot(page, "screenshots/playwright-view-runs-wins-only-off.png");

    // Filter by France
    const filterInput = page.getByPlaceholder("Filter by article");
    await filterInput.fill("France");
    await sleep(600);
    await saveScreenshot(page, "screenshots/playwright-view-runs-filter-france.png");
    await filterInput.fill("");
    await sleep(400);
    await saveScreenshot(page, "screenshots/playwright-view-runs-default-again.png");

    // View Runs CTA (P0)
    await openViewRuns(page, { showCta: true });
    await page.getByText("Want to race an AI?").waitFor();
    await saveScreenshot(page, "screenshots/validation/p0-view-runs-cta.png");
    await saveScreenshot(page, "screenshots/validation/p0-view-runs-cta-no-pulse.png");

    // Play setup
    await openPlaySetup(page);
    await saveScreenshot(page, "screenshots/playwright-play-game-setup.png");
    await saveScreenshot(page, "screenshots/validation/p1-play-setup-stepper-presets.png");
    await saveScreenshot(page, "screenshots/validation/p1-setup-steps-numbers-spacing.png");
    await saveScreenshot(page, "screenshots/validation/p1-setup-steps-tighter-divider.png");

    // Multiple models preset
    await clickQuickPreset(page, "you_vs_two");
    await saveScreenshot(page, "screenshots/playwright-play-game-setup-multiple-models.png");
    await saveScreenshot(page, "screenshots/validation/p1-play-setup-with-quick-start.png");

    // Duplicate model setup
    const participantsSection = page.locator("#participants-section");
    await participantsSection.getByRole("button", { name: "Model", exact: true }).click();
    await sleep(200);
    await saveScreenshot(page, "screenshots/playwright-play-game-setup-duplicate-model.png");

    // Fix duplicates (if present)
    const removeDupes = page.getByRole("button", { name: "Remove duplicates" });
    if (await removeDupes.isVisible().catch(() => false)) {
      await removeDupes.click();
      await sleep(200);
    }
    await saveScreenshot(page, "screenshots/playwright-play-game-ready-to-start.png");

    // Advanced modal
    await openAdvancedModal(page);
    await saveScreenshot(page, "screenshots/playwright-advanced-settings-modal.png");
    await saveScreenshot(page, "screenshots/validation/p1-advanced-with-race-presets.png");
    // Hop tooltip (hover the help icon)
    await page.getByRole("button", { name: "About hops" }).hover();
    await sleep(250);
    await saveScreenshot(page, "screenshots/validation/p1-play-setup-hop-tooltip.png");
    await closeAdvancedModal(page);

    // Start an arena race (deterministic win path)
    await openPlaySetup(page);
    await setStartAndTarget(page, { start: "Capybara", target: "Rodent" });
    await clickQuickPreset(page, "you_vs_two");

    // Sanity: ensure the Target combobox doesn't overlap the Participants column.
    const targetCombo = page.locator("#pages-section").getByRole("combobox").nth(1);
    const targetBox = await targetCombo.boundingBox();
    const participantsBox = await page.locator("#participants-section").boundingBox();
    if (targetBox && participantsBox) {
      const targetRight = targetBox.x + targetBox.width;
      if (targetRight > participantsBox.x - 4) {
        throw new Error(
          `Target combobox overlaps participants: targetRight=${targetRight} participantsLeft=${participantsBox.x}`
        );
      }
    }

    await startRace(page);
    await saveScreenshot(page, "screenshots/playwright-play-game-page-with-arena-preview.png");
    await saveScreenshot(page, "screenshots/playwright-play-game-arena-section.png");
    await saveScreenshot(page, "screenshots/playwright-arena-in-progress-initial.png", {
      fullPage: true,
    });
    await saveScreenshot(page, "screenshots/validation/p1-activity-below-leaderboard.png", {
      fullPage: true,
    });

    await selectHumanRun(page);
    await page.getByRole("tab", { name: "Article" }).click();
    await sleep(600);

    // Split view
    await setHumanArticleMode(page, "Split");
    await saveScreenshot(page, "screenshots/playwright-arena-split-view.png");
    await setHumanArticleMode(page, "Wiki");
    await saveScreenshot(page, "screenshots/playwright-arena-wiki-view.png");

    // Win
    await winFromCapybaraToRodent(page);
    await saveScreenshot(page, "screenshots/playwright-arena-after-user-move.png", {
      fullPage: true,
    });
    await saveScreenshot(page, "screenshots/validation/p0-arena-after-human-move.png", {
      fullPage: true,
    });
    await saveScreenshot(page, "screenshots/validation/p1-multi-ai-human-win.png", {
      fullPage: true,
    });
    await saveScreenshot(page, "screenshots/validation/p1-arena-win-toast-activity.png", {
      fullPage: true,
    });

    // Results tab
    await page.getByRole("tab", { name: "Results" }).click();
    await sleep(400);
    await saveScreenshot(page, "screenshots/playwright-arena-results-tab.png", {
      fullPage: true,
    });

    // Scroll a bit for the "scrolled" view
    await page.mouse.wheel(0, 900);
    await sleep(300);
    await saveScreenshot(page, "screenshots/playwright-arena-results-tab-scrolled.png", {
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
