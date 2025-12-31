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
const PLAY_MODE_STORAGE_KEY = "wikirace:play-mode:v1";
const SESSIONS_STORAGE_KEY = "wikirace:sessions:v1";
const ACTIVE_SESSION_STORAGE_KEY = "wikirace:active-session-id";

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
const mobileViewport = { width: 390, height: 844 };

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

async function seedActiveSession(page, { startArticle, destinationArticle }) {
  const id = "session_ux_audit";
  const created_at = new Date().toISOString();

  const session = {
    id,
    title: "",
    start_article: startArticle,
    destination_article: destinationArticle,
    created_at,
    rules: {
      max_hops: 20,
      max_links: null,
      max_tokens: null,
    },
    runs: [],
  };

  await setLocalStorageAndReload(page, {
    [SESSIONS_STORAGE_KEY]: JSON.stringify({ sessions: { [id]: session } }),
    [ACTIVE_SESSION_STORAGE_KEY]: id,
    [LAST_TAB_STORAGE_KEY]: "play",
    [SEEN_PLAY_TAB_STORAGE_KEY]: "true",
  });
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

async function openMultiplayerSetup(page) {
  await setLocalStorageAndReload(page, {
    [LAST_TAB_STORAGE_KEY]: "play",
    [SEEN_PLAY_TAB_STORAGE_KEY]: "true",
    [PLAY_MODE_STORAGE_KEY]: "multiplayer",
  });

  await page.getByRole("tab", { name: "Play Game" }).click();
  await page.getByRole("tab", { name: "Multiplayer", exact: true }).click();
  await page.getByText("Create a room").waitFor();
}

async function joinMultiplayerFromInvite(page, { inviteLink, name }) {
  await page.goto(inviteLink, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();

  await page.getByRole("tab", { name: "Play Game" }).click();
  await page.getByRole("tab", { name: "Multiplayer", exact: true }).click();

  await page.getByText("Join a room", { exact: true }).waitFor();
  const nameInput = page.getByPlaceholder("Player");
  await nameInput.waitFor();
  await nameInput.fill(name);

  const joinRoomButton = page.getByRole("button", { name: "Join room", exact: true });
  await joinRoomButton.waitFor();
  await joinRoomButton.click();
  await page.getByText("Multiplayer lobby").waitFor({ timeout: 15_000 });
  await sleep(250);
}

async function ensureLeaderboardExpanded(page) {
  const expand = page.getByRole("button", { name: "Expand leaderboard" });
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
    await page.getByText("Leaderboard", { exact: true }).waitFor();
    await sleep(150);
  }
}

async function selectLeaderboardRun(page, containsText) {
  const root = page.locator("#matchup-arena");
  const checkbox = root.locator('input[type="checkbox"][aria-label="Select run"]');

  const runButton = root
    .locator("button")
    .filter({ has: checkbox })
    .filter({ hasText: containsText })
    .first();

  try {
    await runButton.waitFor({ state: "visible", timeout: 6000 });
  } catch {
    const fallback = root
      .locator("button")
      .filter({ hasText: containsText })
      .first();
    await fallback.waitFor({ state: "visible" });
    await fallback.click();
    await sleep(200);
    return;
  }

  await runButton.click();
  await sleep(200);
}

async function selectComboboxValue(page, comboboxLocator, value) {
  const current = (await comboboxLocator.textContent())?.trim();
  if (current === value) return;

  await comboboxLocator.click();

  const popover = page
    .locator('[data-slot="popover-content"][data-state="open"]')
    .filter({ has: page.locator('[data-slot="command-input"]') })
    .last();

  const search = popover.locator('[data-slot="command-input"]');
  await search.waitFor();
  await search.fill(value);
  await sleep(100);

  const list = popover.locator('[data-slot="command-list"]');
  await list.waitFor();
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });

  const initialOptionCount = await popover.locator('[role="option"]').count();
  if (initialOptionCount === 0) {
    throw new Error(
      `No options matched combobox search "${value}". Is the backend running (so the full article list loads)?`
    );
  }

  const option = popover.getByRole("option", { name: value, exact: true }).first();

  const maxScrollAttempts = 300;
  for (let attempt = 0; attempt < maxScrollAttempts; attempt += 1) {
    if (await option.isVisible().catch(() => false)) {
      await option.click();
      await popover.waitFor({ state: "hidden" });
      return;
    }

    const reachedBottom = await list.evaluate((el) => {
      const maxScrollTop = el.scrollHeight - el.clientHeight;
      return el.scrollTop >= maxScrollTop - 2;
    });

    if (reachedBottom) break;

    await list.evaluate((el) => {
      el.scrollBy(0, Math.max(120, el.clientHeight - 20));
    });
    await sleep(75);
  }

  const visibleOptions = await popover
    .locator('[role="option"]')
    .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim()).filter(Boolean));

  throw new Error(
    `Failed to select combobox value "${value}". Visible options: ${visibleOptions.join(", ")}`
  );
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
  await ensureLeaderboardExpanded(page);
  await selectLeaderboardRun(page, "You");
}

async function setHumanArticleMode(page, mode) {
  const tabs = page.getByRole("tab", { name: mode, exact: true });
  await tabs.click();
  await sleep(200);
}

async function clickWikiLink(page, linkText) {
  const iframe = page.locator("iframe").first();
  await iframe.waitFor();

  const frame = page.frameLocator("iframe").first();
  await frame.locator("body").waitFor({ timeout: 20_000 });

  const safeTitle = linkText.replaceAll(" ", "_");
  const byHref = frame
    .locator(
      `a[href$="/wiki/${safeTitle}"], a[href*="/wiki/${safeTitle}#"], a[href$="/wiki/${encodeURIComponent(safeTitle)}"]`
    )
    .first();

  const byTitle = frame.locator(`a[title="${linkText}"]`).first();
  const byText = frame.getByRole("link", { name: new RegExp(linkText, "i") }).first();

  const candidates = [byHref, byTitle, byText];
  for (const candidate of candidates) {
    if ((await candidate.count().catch(() => 0)) === 0) continue;
    await candidate.scrollIntoViewIfNeeded().catch(() => null);
    await candidate.click();
    return;
  }

  // Last resort: wait for a matching link to appear.
  await byText.waitFor({ timeout: 30_000 });
  await byText.scrollIntoViewIfNeeded().catch(() => null);
  await byText.click();
}

async function waitForEnabled(locator, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return;
    await sleep(250);
  }
}

async function winFromCapybaraToRodent(page) {
  await selectHumanRun(page);
  await page.getByRole("tab", { name: "Article" }).click();
  await sleep(500);
  await setHumanArticleMode(page, "Wiki");
  await clickWikiLink(page, "Rodent");
  await page.getByRole("button", { name: "Dismiss win message" }).waitFor({ timeout: 10_000 });
}

async function main() {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  const mobileContext = await browser.newContext({
    viewport: mobileViewport,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobileContext.newPage();
  mobilePage.setDefaultTimeout(15_000);

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

    // Legacy viewer had an article filter input; newer versions don't.
    // Keep a stable screenshot for the "default" state.
    const legacyFilterInput = page.getByPlaceholder("Filter by article");
    if ((await legacyFilterInput.count()) > 0) {
      await legacyFilterInput.fill("France");
      await sleep(600);
      await saveScreenshot(page, "screenshots/playwright-view-runs-filter-france.png");
      await legacyFilterInput.fill("");
      await sleep(400);
    }
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
	    await seedActiveSession(page, { startArticle: "Capybara", destinationArticle: "Rodent" });
	    await openPlaySetup(page);
	    const serverWarning = page.getByText(/Server connection issue/i);
	    await serverWarning.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => null);
	    if (await serverWarning.isVisible().catch(() => false)) {
	      throw new Error(
	        "Backend appears unavailable. Start it with `make server` (or `WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --reload --port 8000`)."
	      );
	    }
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

    // --- Multiplayer flow (room/lobby/arena) ---
    await openMultiplayerSetup(page);

    const multiplayerServerWarning = page.getByText(/Server not connected/i);
    await multiplayerServerWarning
      .waitFor({ state: "hidden", timeout: 20_000 })
      .catch(() => null);

    const createRoomButton = page.getByRole("button", { name: "Create room" });
    await createRoomButton.waitFor();
    await waitForEnabled(createRoomButton, { timeoutMs: 20_000 });

    if (await multiplayerServerWarning.isVisible().catch(() => false)) {
      throw new Error(
        "Backend appears unavailable. Start it with `make server` before running the multiplayer UX audit."
      );
    }
    if (!(await createRoomButton.isEnabled().catch(() => false))) {
      throw new Error(
        "Multiplayer UI never connected to the API server (Create room stayed disabled)."
      );
    }

    await saveScreenshot(
      page,
      "screenshots/multiplayer/playwright-multiplayer-setup-presets.png"
    );

    await createRoomButton.click();
    await page.getByText("Multiplayer lobby").waitFor();
    await saveScreenshot(page, "screenshots/multiplayer/playwright-multiplayer-lobby.png");

    // Open the room in a second tab as a mobile participant.
    await page.waitForFunction(() => {
      return Boolean(new URL(window.location.href).searchParams.get("room"));
    });
    const hostUrl = new URL(page.url());
    const roomId = hostUrl.searchParams.get("room");
    if (!roomId) {
      throw new Error("Multiplayer room URL missing ?room=... param after creating room.");
    }
    const inviteLink = `${hostUrl.origin}/?room=${roomId}`;
    await joinMultiplayerFromInvite(mobilePage, { inviteLink, name: "Mobile" });
    await saveScreenshot(
      mobilePage,
      "screenshots/multiplayer/playwright-multiplayer-mobile-participant-lobby.png"
    );

    // Add one AI racer in the lobby.
    const quickAddModel = page.getByRole("button", { name: /^Add gpt-/ }).first();
    await quickAddModel.click();
    await page.getByText("No AI racers yet.").waitFor({ state: "hidden" }).catch(() => null);
    await sleep(250);
    await saveScreenshot(
      page,
      "screenshots/multiplayer/playwright-multiplayer-lobby-ai-added.png"
    );

    // Start the shared race.
    await page.getByRole("button", { name: "Start race" }).click();
    await page.getByText("Wikipedia view").waitFor({ timeout: 15_000 });

    await mobilePage.getByText("Wikipedia view").waitFor({ timeout: 15_000 });
    await sleep(400);
    await saveScreenshot(
      mobilePage,
      "screenshots/multiplayer/playwright-multiplayer-mobile-participant-arena.png"
    );

    // Capture the default (collapsed) layout, then expand for the rest.
    await saveScreenshot(
      page,
      "screenshots/multiplayer/playwright-multiplayer-arena-initial-collapsed.png"
    );

    await ensureLeaderboardExpanded(page);
    await saveScreenshot(
      page,
      "screenshots/multiplayer/playwright-multiplayer-arena-initial.png",
      { fullPage: true }
    );

    // Make a human move: Capybara -> Rodent.
    await selectLeaderboardRun(page, "Host");
    await page.getByRole("tab", { name: "Wiki", exact: true }).click();
    await clickWikiLink(page, "Rodent");
    await sleep(900);
    await saveScreenshot(
      page,
      "screenshots/multiplayer/playwright-multiplayer-after-move.png",
      { fullPage: true }
    );

    // Cancel the AI racer so we can finish the room deterministically.
    await selectLeaderboardRun(page, /gpt-/);
    const runDetailsHeader = page
      .getByText("Run details", { exact: true })
      .locator("..");
    const cancelButton = runDetailsHeader.getByRole("button", {
      name: "Cancel",
      exact: true,
    });
    if (await cancelButton.isVisible().catch(() => false)) {
      await cancelButton.click();
      await sleep(600);
    }

    // Give up as both humans to finish the race.
    await selectLeaderboardRun(page, "Host");
    const hostGiveUp = page.getByRole("button", { name: "Give up", exact: true });
    if (await hostGiveUp.isVisible().catch(() => false)) {
      await hostGiveUp.click();
      await sleep(400);
    }

    await ensureLeaderboardExpanded(mobilePage);
    await selectLeaderboardRun(mobilePage, "Mobile");
    const mobileGiveUp = mobilePage.getByRole("button", { name: "Give up", exact: true });
    if (await mobileGiveUp.isVisible().catch(() => false)) {
      await mobileGiveUp.click();
      await sleep(400);
    }

    await page.getByText("Race finished").waitFor({ timeout: 20_000 });
    await saveScreenshot(
      page,
      "screenshots/multiplayer/playwright-multiplayer-abandoned-finished.png",
      { fullPage: true }
    );

    await saveScreenshot(
      mobilePage,
      "screenshots/multiplayer/playwright-multiplayer-mobile-participant-finished.png",
      { fullPage: true }
    );

    // Hide/show runs (client-side only).
    await selectLeaderboardRun(page, /gpt-/);
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await page.getByRole("button", { name: /Show hidden/, exact: false }).waitFor();
    await saveScreenshot(
      page,
      "screenshots/multiplayer/playwright-multiplayer-hide-run.png",
      { fullPage: true }
    );

    await page.getByRole("button", { name: /Show hidden/, exact: false }).click();
    await page.getByRole("button", { name: /Show hidden/, exact: false }).waitFor({
      state: "hidden",
    });
    await sleep(200);
    await saveScreenshot(
      page,
      "screenshots/multiplayer/playwright-multiplayer-show-hidden.png",
      { fullPage: true }
    );

    // Add AI dialog (arena).
    await page.getByRole("button", { name: "Add AI", exact: true }).click();
    const addAiDialog = page.getByRole("dialog", { name: /Add AI racer/i });
    await addAiDialog.waitFor();
    await saveScreenshot(
      page,
      "screenshots/multiplayer/playwright-multiplayer-arena-add-ai-dialog.png"
    );

    // Add another AI after the race is finished.
    await addAiDialog.getByLabel("Model").fill("gpt-5-mini");
    await addAiDialog.getByRole("button", { name: "Add AI", exact: true }).click();
    await addAiDialog.waitFor({ state: "hidden" });
    await sleep(800);
    await ensureLeaderboardExpanded(page);
    await saveScreenshot(
      page,
      "screenshots/multiplayer/playwright-multiplayer-add-ai-after-finish.png",
      { fullPage: true }
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
