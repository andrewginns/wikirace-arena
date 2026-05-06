export async function runPlayGameRegression(page, { baseUrl, timeoutMs } = {}) {
  const BASE_URL =
    baseUrl ||
    globalThis.process?.env?.PLAY_GAME_REGRESSION_BASE_URL ||
    "http://localhost:5173";
  const TIMEOUT_MS = typeof timeoutMs === "number" ? timeoutMs : 25_000;
  const SEEDED_SESSION_STORAGE_KEY = "wikirace:play-game-regression:seed-session";

  page.setDefaultTimeout(TIMEOUT_MS);

  await page.addInitScript((seededSessionStorageKey) => {
    try {
      const rawSeed = window.localStorage.getItem(seededSessionStorageKey);
      if (!rawSeed) return;

      window.localStorage.removeItem(seededSessionStorageKey);

      const parsedSeed = JSON.parse(rawSeed);
      const session = parsedSeed?.session;
      if (!session || typeof session.id !== "string") return;

      window.localStorage.setItem(
        "wikirace:sessions:v1",
        JSON.stringify({ sessions: { [session.id]: session } })
      );
      window.localStorage.setItem("wikirace:active-session-id", session.id);
    } catch {
      window.localStorage.removeItem(seededSessionStorageKey);
    }
  }, SEEDED_SESSION_STORAGE_KEY);

  const sleep = (ms) => page.waitForTimeout(ms);

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function safeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function tryParseJson(value) {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function reqPath(req) {
    try {
      return new URL(req.url()).pathname;
    } catch {
      return req.url();
    }
  }

  async function getActiveHumanRunSnapshot(p) {
    return await p.evaluate(() => {
      const active = window.localStorage.getItem("wikirace:active-session-id");
      const raw = window.localStorage.getItem("wikirace:sessions:v1");
      if (!active || !raw) return null;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }

      const session = parsed?.sessions?.[active];
      if (!session || !Array.isArray(session.runs)) return null;

      const humanRun = session.runs.find((r) => r && r.kind === "human");
      if (!humanRun) return null;

      return {
        run_id: humanRun.id || null,
        steps_length: Array.isArray(humanRun.steps) ? humanRun.steps.length : null,
        status: humanRun.status || null,
        result: humanRun.result || null,
      };
    });
  }

  async function waitForStoredRunLabel(p, runId) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const label = await p.evaluate((requestedRunId) => {
        const active = window.localStorage.getItem("wikirace:active-session-id");
        const raw = window.localStorage.getItem("wikirace:sessions:v1");
        if (!active || !raw) return null;

        try {
          const parsed = JSON.parse(raw);
          const session = parsed?.sessions?.[active];
          const run = session?.runs?.find((r) => r && r.id === requestedRunId);
          return run?.model || run?.player_name || null;
        } catch {
          return null;
        }
      }, runId);

      if (typeof label === "string" && label.trim().length > 0) return label;
      await p.waitForTimeout(100);
    }

    return null;
  }

  async function waitForStoredRunDeletion(p, runId) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const deletedOk = await p.evaluate((requestedRunId) => {
        const active = window.localStorage.getItem("wikirace:active-session-id");
        const raw = window.localStorage.getItem("wikirace:sessions:v1");
        if (!active || !raw) return false;

        try {
          const parsed = JSON.parse(raw);
          const session = parsed?.sessions?.[active];
          return !session?.runs?.some((r) => r && r.id === requestedRunId);
        } catch {
          return false;
        }
      }, runId);

      if (deletedOk) return true;
      await p.waitForTimeout(100);
    }

    return false;
  }

  function getWikiFrameUrl(p) {
    const frames = p.frames();
    const frame = frames.find((f) => f.url().includes("/wiki/"));
    return frame ? frame.url() : null;
  }

  async function openSelectContainingOption(p, optionText) {
    const triggers = p.locator('[data-slot="select-trigger"]');
    const count = await triggers.count();
    const max = Math.min(10, count);

    for (let i = 0; i < max; i += 1) {
      const trigger = triggers.nth(i);
      if (!(await trigger.isVisible().catch(() => false))) continue;
      await trigger.click();
      const option = p.getByRole("option", { name: optionText, exact: true });
      if (await option.isVisible().catch(() => false)) return;
      await p.keyboard.press("Escape").catch(() => null);
    }

    throw new Error(`Failed to open a Select that contains option "${optionText}"`);
  }

  async function clearStorageAndReload(p) {
    await p.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await p.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();
    await p.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();
  }

  async function ensureTopLevelTab(p, tabName) {
    const tab = p.getByRole("tab", { name: tabName });
    await tab.click();
  }

  async function ensurePlayMode(p, mode) {
    const playTab = p.getByRole("tab", { name: "Play Game" });
    const modeTab = p.getByRole("tab", { name: mode, exact: true });
    await playTab.click();
    await modeTab.click();
  }

  async function openLocalSetup(p) {
    await ensurePlayMode(p, "Local");

    // If setup is collapsed, the Arena header shows "New race".
    const newRace = p.getByRole("button", { name: "New race" });
    if (await newRace.isVisible().catch(() => false)) {
      await newRace.click();
      await sleep(200);
    }

    await p.getByRole("heading", { name: "Start a race" }).waitFor();
    await p.getByText("Setup steps").waitFor();

    const serverWarning = p.getByText(/Server connection issue/i);
    if (await serverWarning.isVisible().catch(() => false)) {
      await serverWarning
        .waitFor({ state: "hidden", timeout: 15_000 })
        .catch(() => {
          throw new Error(
            "Backend appears unavailable. Start it with `make server` (or `uv run uvicorn api:app --reload --port 8000`)."
          );
        });
    }
  }

  async function openMultiplayerSetup(p) {
    await ensurePlayMode(p, "Multiplayer");
    await p.getByText("Create a room").waitFor();

    const serverWarning = p.getByText(/Server not connected/i);
    if (await serverWarning.isVisible().catch(() => false)) {
      await serverWarning
        .waitFor({ state: "hidden", timeout: 15_000 })
        .catch(() => {
          throw new Error(
            "Multiplayer UI reports server disconnected. Start the API server before running this smoke test."
          );
        });
    }
  }

  async function ensureLeaderboardExpanded(p) {
    const expand = p.getByRole("button", { name: "Expand leaderboard" });
    if (await expand.isVisible().catch(() => false)) {
      await expand.click();
      await p.locator("#matchup-arena").getByText("Leaderboard", { exact: true }).waitFor();
      await sleep(150);
    }
  }

  async function setLeaderboardCollapsed(p, collapsed) {
    const collapseBtn = p.getByRole("button", { name: "Collapse leaderboard" });
    const expandBtn = p.getByRole("button", { name: "Expand leaderboard" });

    if (collapsed) {
      if (await collapseBtn.isVisible().catch(() => false)) {
        await collapseBtn.click();
        await sleep(200);
      }
      return;
    }

    if (await expandBtn.isVisible().catch(() => false)) {
      await expandBtn.click();
      await sleep(200);
    }
  }

  async function selectLeaderboardRun(p, containsText) {
    const root = p.locator("#matchup-arena");
    const checkbox = root.locator('input[type="checkbox"][aria-label="Select run"]');

    const runButton = root
      .locator("button")
      .filter({ has: checkbox })
      .filter({ hasText: containsText })
      .first();

    try {
      await runButton.waitFor({ state: "visible", timeout: 6000 });
    } catch {
      const fallback = root.locator("button").filter({ hasText: containsText }).first();
      await fallback.waitFor({ state: "visible" });
      await fallback.click();
      await sleep(200);
      return;
    }

    await runButton.click();
    await sleep(200);
  }

  async function selectComboboxValue(p, comboboxLocator, value) {
    const current = safeText(await comboboxLocator.textContent().catch(() => ""));
    if (current === value) return;

    await comboboxLocator.click();

    const popover = p
      .locator('[data-slot="popover-content"][data-state="open"]')
      .filter({ has: p.locator('[data-slot="command-input"]') })
      .last();

    const search = popover.locator('[data-slot="command-input"]');
    await search.waitFor();
    await search.fill(value);
    await sleep(120);

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

  async function setStartAndTargetInLocalSetup(p, { start, target }) {
    const pagesSection = p.locator("#pages-section");
    const combos = pagesSection.getByRole("combobox");
    await selectComboboxValue(p, combos.nth(0), start);
    await selectComboboxValue(p, combos.nth(1), target);
  }

  async function setStartAndTargetInMultiplayerSetup(p, { start, target }) {
    const combos = p.getByRole("combobox");
    const count = await combos.count();
    assert(count >= 2, `Expected >=2 comboboxes on multiplayer setup; found ${count}`);
    await selectComboboxValue(p, combos.nth(0), start);
    await selectComboboxValue(p, combos.nth(1), target);
  }

  async function startRace(p) {
    const startRaceButton = p.getByRole("button", { name: "Start race", exact: true });
    await startRaceButton.waitFor();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await startRaceButton.isEnabled().catch(() => false)) break;
      await p.waitForTimeout(150);
    }
    assert(
      await startRaceButton.isEnabled().catch(() => false),
      "Start race button was disabled (pages invalid or duplicates present)"
    );

    await startRaceButton.click();
    await p.locator("#matchup-arena").waitFor({ timeout: 15_000 });
  }

  async function clickWikiLink(p, linkText) {
    const iframe = p.locator("iframe").first();
    await iframe.waitFor();

    const frame = p.frameLocator("iframe").first();
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

  async function waitForWinToast(p) {
    await p.getByRole("button", { name: "Dismiss win message" }).waitFor({ timeout: 10_000 });
  }

  async function clickQuickPreset(p, presetId) {
    const presetLocator =
      presetId === "you_vs_fast"
        ? p.getByRole("button", { name: /You vs AI \(fast\)/ })
        : presetId === "you_vs_two"
          ? p.getByRole("button", { name: /You vs 2 AIs/ })
          : presetId === "model_showdown"
            ? p.getByRole("button", { name: /Model showdown/ })
            : p.getByRole("button", { name: /Hotseat \(2 humans\)/ });

    await presetLocator.click();
    await sleep(200);
  }

  async function queueSeededSession(p, session) {
    await p.evaluate(
      ({ seededSessionStorageKey, nextSession }) => {
        window.localStorage.setItem(
          seededSessionStorageKey,
          JSON.stringify({ session: nextSession })
        );
      },
      {
        seededSessionStorageKey: SEEDED_SESSION_STORAGE_KEY,
        nextSession: session,
      }
    );
  }

  async function seedTokenSession(p) {
    const id = "session_mcp_tokens";
    const created_at = new Date().toISOString();

    await queueSeededSession(p, {
      id,
      title: "Token accounting seed",
      start_article: "Capybara",
      destination_article: "Rodent",
      created_at,
      rules: {
        max_hops: 20,
        max_links: null,
        max_tokens: null,
        include_image_links: false,
        disable_links_view: false,
      },
      runs: [
        {
          id: "run_llm_seed",
          kind: "llm",
          model: "openai-responses:gpt-5.2",
          openai_reasoning_effort: "high",
          started_at: created_at,
          finished_at: created_at,
          status: "finished",
          result: "win",
          steps: [
            { type: "start", article: "Capybara", at: created_at },
            {
              type: "move",
              article: "Rodent",
              at: created_at,
              metadata: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            },
            {
              type: "move",
              article: "Rodent",
              at: created_at,
              metadata: { input_tokens: 5, output_tokens: 2 },
            },
          ],
        },
      ],
    });
  }

  async function seedCouldHaveWonSession(p) {
    const id = "session_could_have_won";
    const created_at = new Date().toISOString();

    await queueSeededSession(p, {
      id,
      title: "Direct link miss seed",
      start_article: "Capybara",
      destination_article: "Rodent",
      created_at,
      rules: {
        max_hops: 20,
        max_links: null,
        max_tokens: null,
        include_image_links: false,
        disable_links_view: false,
      },
      runs: [
        {
          id: "run_human_miss",
          kind: "human",
          player_name: "You",
          started_at: created_at,
          finished_at: created_at,
          status: "finished",
          result: "lose",
          steps: [
            { type: "start", article: "Capybara", at: created_at },
            { type: "move", article: "Car", at: created_at },
            { type: "lose", article: "Car", at: created_at, metadata: { reason: "seed" } },
          ],
        },
      ],
    });
  }

  async function seedNoopTerminalSession(p) {
    const id = "session_noop_terminal";
    const created_at = new Date().toISOString();

    await queueSeededSession(p, {
      id,
      title: "Terminal no-op seed",
      start_article: "Capybara",
      destination_article: "Rodent",
      created_at,
      rules: {
        max_hops: 20,
        max_links: null,
        max_tokens: null,
        include_image_links: false,
        disable_links_view: false,
      },
      runs: [
        {
          id: "run_human_noop_terminal",
          kind: "human",
          player_name: "You",
          started_at: created_at,
          finished_at: created_at,
          status: "finished",
          result: "lose",
          steps: [
            { type: "start", article: "Capybara", at: created_at },
            { type: "move", article: "Capybara#Overview", at: created_at },
            {
              type: "lose",
              article: "Capybara#Overview",
              at: created_at,
              metadata: { reason: "seed-terminal-noop" },
            },
          ],
        },
      ],
    });
  }

  async function seedRunLevelUnlimitedSession(p) {
    const id = "session_run_level_unlimited";
    const created_at = new Date().toISOString();

    await queueSeededSession(p, {
      id,
      title: "Run-level unlimited seed",
      start_article: "Capybara",
      destination_article: "Rodent",
      created_at,
      rules: {
        max_hops: 20,
        max_links: 5,
        max_tokens: 1234,
        include_image_links: false,
        disable_links_view: false,
      },
      runs: [
        {
          id: "run_llm_unlimited_override",
          kind: "llm",
          model: "openai-responses:gpt-5.2",
          max_links: null,
          max_tokens: null,
          started_at: created_at,
          status: "running",
          result: null,
          steps: [{ type: "start", article: "Capybara", at: created_at }],
        },
      ],
    });
  }

  const summary = {
    local: {
      randomMatchup: null,
      articlesComboboxLiveUpdateOk: false,
      articlesComboboxKeyboardNavOk: false,
      articlesComboboxReopenScrollOk: false,
      corruptStoredSessionRecoveryOk: false,
      corruptRootSessionRecoveryOk: false,
      couldHaveWonCalloutOk: false,
      couldHaveWonNoopSuppressedOk: false,
      legacyImportNormalizedOk: false,
      llmRunDeletionStopsRequestsOk: false,
      fallbackValidationFailClosedOk: false,
      slowValidationFailClosedOk: false,
      duplicateNavigateRequestWaitsForValidationOk: false,
      duplicateRemovalWorked: false,
      winHopCountOk: false,
      rulesUnlimitedOk: false,
      runLevelUnlimitedOverridesOk: false,
      traceHeadersOk: false,
      localLayoutKey: null,
    },
    localReplayLock: {
      blocksIframeNavigation: false,
      terminalNoopOpensLastStep: false,
      zeroHopTerminalNoopOpensLastStep: false,
    },
    localDisableLinksView: {
      splitLinksTabsHidden: false,
      iframeClickStillWorks: false,
    },
    multiplayer: {
      createRoomRequest: null,
      inviteLinkFocusOk: false,
      mobileHostControlsOk: false,
      sprintRulesApplied: false,
      addAiFailurePreservesFieldsOk: false,
      addAiRequest: null,
      addAiOmittedOverrides: false,
      terminalWsCloseClearsStateOk: false,
      storageFailureConnectOk: false,
      modelLabelIncludesEffort: false,
      multiplayerLayoutKey: null,
      localLayoutKeyUnchanged: false,
    },
    tokenSeed: {
      tokensLine: null,
      totalsOk: false,
    },
    viewerDatasets: {
      benchmarkDefaultLoads: false,
      storedOk: false,
      persistedAfterReload: false,
      malformedStepPathRobustOk: false,
    },
    canonicalization: {
      variantsOk: false,
      failureTtlOk: false,
    },
  };

  let savedViewerDatasetName = null;
  let apiOrigin = null;

  // ---- Begin run ----
  await clearStorageAndReload(page);

  // View Runs should be useful on a fresh app load by reading published benchmark traces.
  await ensureTopLevelTab(page, "View Runs");
  await page.getByRole("button", { name: "Upload JSON", exact: true }).waitFor({ timeout: 15_000 });
  await page
    .getByText("Loading benchmark traces...", { exact: true })
    .waitFor({ state: "hidden", timeout: 15_000 })
    .catch(() => null);
  await page
    .getByText("Loading dataset...", { exact: true })
    .waitFor({ state: "hidden", timeout: 15_000 })
    .catch(() => null);

  const defaultBenchmarkSelected = await page
    .getByText("Benchmark:", { exact: false })
    .first()
    .isVisible()
    .catch(() => false);
  const defaultViewerEmpty = await page
    .getByText("No runs available.", { exact: true })
    .isVisible()
    .catch(() => false);
  assert(defaultBenchmarkSelected, "View Runs should select a benchmark trace by default");
  assert(!defaultViewerEmpty, "View Runs benchmark trace should render at least one run");
  summary.viewerDatasets.benchmarkDefaultLoads = true;

  await clearStorageAndReload(page);

  // Corrupt local session storage should be dropped without breaking Play Game startup.
  await page.evaluate(() => {
    const validSession = {
      id: "session_valid_recovery",
      start_article: "Capybara",
      destination_article: "Rodent",
      created_at: new Date().toISOString(),
      rules: {
        max_hops: 20,
        max_links: null,
        max_tokens: null,
        include_image_links: false,
        disable_links_view: false,
      },
      runs: [],
    };

    window.localStorage.setItem(
      "wikirace:sessions:v1",
      JSON.stringify({
        sessions: {
          session_valid_recovery: validSession,
          session_corrupt_recovery: {
            id: "session_corrupt_recovery",
            start_article: "Broken",
            destination_article: "Broken",
            created_at: new Date().toISOString(),
            runs: "oops",
          },
        },
      })
    );
    window.localStorage.setItem("wikirace:active-session-id", "session_corrupt_recovery");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();
  await ensureTopLevelTab(page, "Play Game");
  await ensurePlayMode(page, "Local");
  await page.getByText(/malformed saved local race sessions were ignored/i).waitFor({
    timeout: 10_000,
  });

  const recoverySnapshot = await page.evaluate(async () => {
    const sessionStore = await import("/src/lib/session-store.ts");
    const snapshot = sessionStore.getSessionsSnapshot();
    return {
      hasValidSession: Boolean(snapshot.sessions?.session_valid_recovery),
      hasCorruptSession: Boolean(snapshot.sessions?.session_corrupt_recovery),
      activeSessionId: snapshot.active_session_id || null,
    };
  });
  assert(recoverySnapshot.hasValidSession, "Valid stored session was unexpectedly dropped");
  assert(!recoverySnapshot.hasCorruptSession, "Malformed stored session should have been dropped");
  assert(
    recoverySnapshot.activeSessionId !== "session_corrupt_recovery",
    "Malformed stored active session id should not survive hydration"
  );
  summary.local.corruptStoredSessionRecoveryOk = true;

  await clearStorageAndReload(page);

  await page.evaluate(() => {
    window.localStorage.setItem("wikirace:sessions:v1", "{not valid json");
    window.localStorage.setItem(
      "wikirace:active-session-id",
      "session_missing_after_root_corruption"
    );
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();
  await ensureTopLevelTab(page, "Play Game");
  await ensurePlayMode(page, "Local");
  await page.getByText(/malformed saved local race sessions were ignored/i).waitFor({
    timeout: 10_000,
  });

  const rootRecoverySnapshot = await page.evaluate(async () => {
    const sessionStore = await import("/src/lib/session-store.ts");
    const snapshot = sessionStore.getSessionsSnapshot();
    return {
      sessionCount: Object.keys(snapshot.sessions || {}).length,
      activeSessionId: snapshot.active_session_id || null,
    };
  });
  assert(
    rootRecoverySnapshot.sessionCount === 0,
    `Malformed root session JSON should hydrate with no sessions; got ${rootRecoverySnapshot.sessionCount}`
  );
  assert(
    rootRecoverySnapshot.activeSessionId === null,
    `Malformed root session JSON should clear active session id; got ${rootRecoverySnapshot.activeSessionId}`
  );
  summary.local.corruptRootSessionRecoveryOk = true;

  await clearStorageAndReload(page);

  // --- Canonicalization cache behavior (variants + failure TTL) ---
  {
    const variantsTitle = "Foo_Bar";
    const variantsCanonical = "Foo Bar Canonical";
    const ttlTitle = "Transient_Failure_Title";
    const ttlCanonical = "Transient Failure Canonical";

    let ttlCalls = 0;
    const canonicalRequests = [];

    await page.route("**/canonical_title/**", async (route) => {
      const url = route.request().url();
      let pathname = url;
      try {
        pathname = new URL(url).pathname;
      } catch {
        // ignore
      }

      const marker = "/canonical_title/";
      const idx = pathname.indexOf(marker);
      if (idx === -1) return route.continue();

      const raw = pathname.slice(idx + marker.length);
      const decoded = decodeURIComponent(raw);
      canonicalRequests.push(decoded);

      const normalizedDecoded = decoded.replaceAll("_", " ").trim().toLowerCase();
      const normalizedVariants = variantsTitle.replaceAll("_", " ").trim().toLowerCase();
      const normalizedTtl = ttlTitle.replaceAll("_", " ").trim().toLowerCase();

      if (normalizedDecoded === normalizedVariants) {
        return await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ title: variantsCanonical }),
        });
      }

      if (normalizedDecoded === normalizedTtl) {
        ttlCalls += 1;
        if (ttlCalls === 1) {
          return await route.fulfill({
            status: 503,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: "temporary failure",
          });
        }

        return await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ title: ttlCanonical }),
        });
      }

      return route.continue();
    });

    try {
      const variant1 = await page.evaluate(async (title) => {
        const mod = await import("/src/lib/wiki-canonical.ts");
        return await mod.canonicalizeTitle(title);
      }, variantsTitle);
      assert(variant1 === variantsCanonical, "canonicalizeTitle should return server canonical title");

      const variant2 = await page.evaluate(async () => {
        const mod = await import("/src/lib/wiki-canonical.ts");
        return await mod.canonicalizeTitle("foo bar");
      });
      assert(variant2 === variantsCanonical, "canonicalizeTitle should share cache across _/space/case variants");

      // Only the first call should hit the network (second should use the shared normalized cache key).
      const normalizeReq = (t) => t.replaceAll("_", " ").trim().toLowerCase();
      const normalizedVariants = normalizeReq(variantsTitle);
      const variantRequests = canonicalRequests.filter(
        (t) => normalizeReq(t) === normalizedVariants
      );
      assert(
        variantRequests.length === 1,
        `Expected 1 canonical_title request for variants test, got ${variantRequests.length} (${variantRequests.join(
          ", "
        )})`
      );
      summary.canonicalization.variantsOk = true;

      const ttl1 = await page.evaluate(async (title) => {
        const mod = await import("/src/lib/wiki-canonical.ts");
        return await mod.canonicalizeTitle(title);
      }, ttlTitle);
      assert(ttl1 === ttlTitle, "canonicalizeTitle should fall back to input title on transient failures");

      const ttl2 = await page.evaluate(async () => {
        const mod = await import("/src/lib/wiki-canonical.ts");
        return await mod.canonicalizeTitle("transient failure title");
      });
      assert(ttl2 === ttlTitle, "Failure caching should normalize titles consistently");
      assert(ttlCalls === 1, "Failure TTL should prevent immediate refetch of canonical_title");

      const ttl3 = await page.evaluate(async () => {
        const mod = await import("/src/lib/wiki-canonical.ts");
        const realNow = Date.now;
        try {
          const base = realNow();
          Date.now = () => base + 61_000;
          return await mod.canonicalizeTitle("Transient Failure Title");
        } finally {
          Date.now = realNow;
        }
      });
      assert(ttl3 === ttlCanonical, "Failure TTL should expire so canonicalization can recover");
      assert(ttlCalls >= 2, "Expected canonical_title to refetch after TTL expiry");
      summary.canonicalization.failureTtlOk = true;
    } finally {
      await page.unroute("**/canonical_title/**").catch(() => null);
    }
  }

  // --- Local setup + duplication + tracing + win ---
  // This is a regression guard for VirtualizedCombobox: keep the options popover open
  // while /get_all_articles is still loading, and ensure results populate without closing.
  let allowArticlesFetch = false;
  await page.route("**/get_all_articles", async (route) => {
    if (!apiOrigin) {
      try {
        apiOrigin = new URL(route.request().url()).origin;
      } catch {
        // ignore
      }
    }
    if (!allowArticlesFetch) await new Promise((resolve) => setTimeout(resolve, 0));
    while (!allowArticlesFetch) await new Promise((resolve) => setTimeout(resolve, 50));
    await route.continue();
  });

  await openLocalSetup(page);

  try {
    const pagesSection = page.locator("#pages-section");
    const combos = pagesSection.getByRole("combobox");

    await combos.nth(0).click();
    const search = page.getByPlaceholder("Search items...");
    await search.fill("Rodent");

    const emptyState = page.getByText("No item found.");
    await emptyState.waitFor();

    const articlesResponsePromise = page.waitForResponse(
      (resp) => resp.url().includes("/get_all_articles") && resp.ok(),
      { timeout: TIMEOUT_MS }
    );
    allowArticlesFetch = true;
    await articlesResponsePromise;

    const rodentOption = page.getByRole("option", { name: "Rodent", exact: true });
    await rodentOption.waitFor();
    assert(
      !(await emptyState.isVisible().catch(() => false)),
      "Combobox still shows empty-state after /get_all_articles finished"
    );

    summary.local.articlesComboboxLiveUpdateOk = true;

    // Keyboard navigation: after a transient empty search, Enter should select the first match
    // without requiring arrow keys or mouse movement.
    await search.fill("zzzzzzzzzzzz");
    await emptyState.waitFor();
    await search.fill("o");

    const options = page.getByRole("option");
    await options.nth(0).waitFor({ timeout: 8_000 });
    await emptyState.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => null);

    const expectedFirst = safeText(await options.nth(0).textContent().catch(() => ""));
    assert(expectedFirst, "Expected at least 1 combobox option after recovering from empty search");

    await page.keyboard.press("Enter");
    await sleep(150);

    const valueAfterEnter = safeText(await combos.nth(0).textContent().catch(() => ""));
    assert(
      valueAfterEnter === expectedFirst,
      `Enter selection after empty search failed (expected "${expectedFirst}", got "${valueAfterEnter}")`
    );

    // ArrowDown/Enter should pick the focused option.
    await combos.nth(0).click();
    await page.getByPlaceholder("Search items...").fill("o");
    await options.nth(0).waitFor({ timeout: 8_000 });

    const optionCount = await options.count().catch(() => 0);
    assert(optionCount > 0, "Expected at least 1 combobox option after filtering");
    const expectedIndex = optionCount > 1 ? 1 : 0;
    const expected = safeText(await options.nth(expectedIndex).textContent().catch(() => ""));
    assert(expected, "Expected a combobox option label for keyboard navigation test");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await sleep(150);

    const startValue = safeText(await combos.nth(0).textContent().catch(() => ""));
    assert(
      startValue === expected,
      `Keyboard selection failed (expected "${expected}", got "${startValue}")`
    );
    summary.local.articlesComboboxKeyboardNavOk = true;

    // Reopening should scroll the selected value into view (even when it's far down the full list).
    assert(apiOrigin, "Failed to infer API origin from /get_all_articles request");
    const farOption = await page.evaluate(async (origin) => {
      const res = await fetch(`${origin}/get_all_articles`);
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) return null;

      // Choose a "late" item that is long enough to reduce substring collisions.
      const start = Math.max(0, data.length - 300);
      for (let i = data.length - 1; i >= start; i -= 1) {
        const candidate = data[i];
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (trimmed.length >= 12) return trimmed;
      }

      const fallback = data[data.length - 1];
      return typeof fallback === "string" ? fallback.trim() : null;
    }, apiOrigin);

    assert(farOption, "Failed to pick a far combobox option from /get_all_articles");

    await combos.nth(0).click();
    await page.getByPlaceholder("Search items...").fill(farOption);
    await page.getByRole("option", { name: farOption, exact: true }).first().click();
    await sleep(150);

    await combos.nth(0).click();
    const selectedOption = page.getByRole("option", { name: farOption, exact: true }).first();
    await selectedOption.waitFor({ timeout: 8_000 });
    assert(
      await selectedOption.isVisible().catch(() => false),
      "Combobox reopen should scroll the selected option into view"
    );
    summary.local.articlesComboboxReopenScrollOk = true;
  } finally {
    allowArticlesFetch = true;
    await page.unroute("**/get_all_articles").catch(() => null);
  }

  // Random matchup should never pick identical start/target.
  await page.getByRole("button", { name: "Random matchup" }).click();
  await sleep(200);
  {
    const pagesSection = page.locator("#pages-section");
    const combos = pagesSection.getByRole("combobox");
    const startValue = safeText(await combos.nth(0).textContent().catch(() => ""));
    const targetValue = safeText(await combos.nth(1).textContent().catch(() => ""));
    assert(startValue && targetValue, "Random matchup did not populate start/target");
    assert(startValue !== targetValue, `Random matchup returned identical pages: ${startValue}`);
    summary.local.randomMatchup = { startValue, targetValue };
  }

  // Duplicate detection + removal.
  await clickQuickPreset(page, "you_vs_two");
  await page
    .locator("#participants-section")
    .getByRole("button", { name: "Model", exact: true })
    .click();
  const removeDupes = page.getByRole("button", { name: "Remove duplicates", exact: true });
  await removeDupes.waitFor({ timeout: 8_000 });
  await removeDupes.click();
  await removeDupes.waitFor({ state: "hidden", timeout: 8_000 });
  summary.local.duplicateRemovalWorked = true;

  // Use a single AI run for trace assertions.
  await clickQuickPreset(page, "you_vs_fast");
  await setStartAndTargetInLocalSetup(page, { start: "Capybara", target: "Rodent" });

  const localRunStartReqPromise = page.waitForRequest(
    (req) => reqPath(req) === "/llm/local_run/start" && req.method() === "POST",
    { timeout: TIMEOUT_MS }
  );
  const localRunStepReqPromise = page.waitForRequest(
    (req) => reqPath(req) === "/llm/local_run/step" && req.method() === "POST",
    { timeout: TIMEOUT_MS }
  );

  await startRace(page);
  await ensureLeaderboardExpanded(page);

  // Validate “unlimited budgets use null” via the stored session rules.
  const localSessionRules = await page.evaluate(() => {
    const active = window.localStorage.getItem("wikirace:active-session-id");
    const raw = window.localStorage.getItem("wikirace:sessions:v1");
    if (!active || !raw) return null;
    const parsed = JSON.parse(raw);
    const session = parsed?.sessions?.[active];
    return session?.rules || null;
  });
  assert(localSessionRules, "Failed to read local session rules from localStorage");
  assert(
    localSessionRules.max_links === null,
    "Local session rules max_links should be null (unlimited)"
  );
  assert(
    localSessionRules.max_tokens === null,
    "Local session rules max_tokens should be null (unlimited)"
  );
  summary.local.rulesUnlimitedOk = true;

  // Validate Logfire trace propagation: /local_run/start -> traceparent -> /local_run/step
  const localRunStartReq = await localRunStartReqPromise;
  const localRunStartBody = tryParseJson(localRunStartReq.postData()) || {};
  const localRunStepReq = await localRunStepReqPromise;
  const headers = localRunStepReq.headers();
  const traceparent = headers.traceparent;

  assert(
    typeof traceparent === "string" && traceparent.trim().length > 0,
    "Missing traceparent header on /llm/local_run/step"
  );
  assert(
    headers["x-wikirace-session-id"] === localRunStartBody.session_id,
    "x-wikirace-session-id header did not match /llm/local_run/start session_id"
  );
  assert(
    headers["x-wikirace-run-id"] === localRunStartBody.run_id,
    "x-wikirace-run-id header did not match /llm/local_run/start run_id"
  );

  const stepBody = tryParseJson(localRunStepReq.postData()) || {};
  assert(
    Object.prototype.hasOwnProperty.call(stepBody, "max_tokens") && stepBody.max_tokens === null,
    "Expected local_run/step payload max_tokens to be null when unlimited"
  );
  summary.local.traceHeadersOk = true;

  // Human deterministic win: Capybara -> Rodent.
  await selectLeaderboardRun(page, "You");
  await page.getByRole("tab", { name: "Article" }).click();
  await page.getByRole("tab", { name: "Wiki", exact: true }).click();
  await sleep(400);

  // Replay should lock iframe navigation during active runs.
  const stepsBefore = await getActiveHumanRunSnapshot(page);
  assert(
    stepsBefore && typeof stepsBefore.steps_length === "number",
    "Failed to read active human run snapshot before replay lock check"
  );

  const capybaraUrlBefore = getWikiFrameUrl(page);
  assert(
    capybaraUrlBefore && capybaraUrlBefore.includes("/wiki/Capybara"),
    `Expected wiki iframe URL to contain /wiki/Capybara before replay; got: ${capybaraUrlBefore}`
  );

  await page.getByRole("button", { name: "Replay", exact: true }).first().click();
  await page.getByRole("button", { name: "Back to live" }).first().waitFor();
  await sleep(150);

  await clickWikiLink(page, "Rodent");
  await sleep(1200);

  const stepsAfter = await getActiveHumanRunSnapshot(page);
  assert(
    stepsAfter && typeof stepsAfter.steps_length === "number",
    "Failed to read active human run snapshot after replay click"
  );
  assert(
    stepsAfter.steps_length === stepsBefore.steps_length,
    "Replay mode should block iframe navigation (human run steps changed after click)"
  );

  const capybaraUrlAfter = getWikiFrameUrl(page);
  assert(
    capybaraUrlAfter && capybaraUrlAfter.includes("/wiki/Capybara"),
    `Replay mode should block iframe navigation (wiki iframe URL changed). URL: ${capybaraUrlAfter}`
  );

  summary.localReplayLock.blocksIframeNavigation = true;

  await page.getByRole("button", { name: "Back to live" }).first().click();
  await page.getByRole("button", { name: "Replay", exact: true }).waitFor();
  await sleep(150);

  await clickWikiLink(page, "Rodent");
  await waitForWinToast(page);
  await page.getByText(/You won in 1 hop/i).first().waitFor({ timeout: 10_000 });
  summary.local.winHopCountOk = true;

  // Save the finished race into the Viewer store so we can assert persistence across reloads.
  await page.getByRole("button", { name: "Dismiss win message" }).click().catch(() => null);
  // There are two "Save to viewer" buttons when the race is finished (header + finish card).
  await page.getByRole("button", { name: "Save to viewer" }).first().click();
  await page.getByRole("button", { name: "Upload JSON", exact: true }).waitFor({ timeout: 15_000 });

  {
    const stored = await page.evaluate(() => {
      const raw = window.localStorage.getItem("wikirace:viewer-datasets:v1");
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    });

    const datasets = stored?.datasets;
    assert(Array.isArray(datasets) && datasets.length > 0, "Expected viewer datasets to be stored in localStorage");
    savedViewerDatasetName = datasets[0]?.name || null;
    assert(
      typeof savedViewerDatasetName === "string" && savedViewerDatasetName.trim().length > 0,
      "Stored viewer dataset missing a name"
    );
    summary.viewerDatasets.storedOk = true;
  }

  // Continue remaining tests from the Play tab.
  await ensureTopLevelTab(page, "Play Game");

  // Capture + lock in local layout key so we can confirm multiplayer doesn't overwrite it.
  await setLeaderboardCollapsed(page, true);
  const localLayoutKey = await page.evaluate(() =>
    window.localStorage.getItem("wikirace:arena-layout:v1")
  );
  assert(localLayoutKey, "Missing local arena layout key (wikirace:arena-layout:v1)");
  summary.local.localLayoutKey = localLayoutKey;

  // --- Local: disable_links_view hides Split/Links but does not block iframe clicks ---
  await ensureTopLevelTab(page, "Play Game");
  await page.getByRole("button", { name: "New race" }).click();
  await openLocalSetup(page);

  await clickQuickPreset(page, "hotseat");
  await setStartAndTargetInLocalSetup(page, { start: "Capybara", target: "Rodent" });

  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("dialog", { name: "Advanced race settings" }).waitFor();
  const disableLinksCheckbox = page.getByLabel("Disable links view");
  if (!(await disableLinksCheckbox.isChecked().catch(() => false))) {
    await disableLinksCheckbox.click();
  }
  await page.getByRole("button", { name: "Done" }).click();
  await sleep(150);

  await startRace(page);
  await ensureLeaderboardExpanded(page);
  await selectLeaderboardRun(page, "You");

  const splitTabCount = await page.getByRole("tab", { name: "Split", exact: true }).count();
  const linksTabCount = await page.getByRole("tab", { name: "Links", exact: true }).count();
  assert(splitTabCount === 0, "Split tab should be hidden when Disable links view is enabled");
  assert(linksTabCount === 0, "Links tab should be hidden when Disable links view is enabled");
  summary.localDisableLinksView.splitLinksTabsHidden = true;

  await page.getByRole("tab", { name: "Article" }).click();
  await sleep(400);
  await clickWikiLink(page, "Rodent");
  await waitForWinToast(page);
  summary.localDisableLinksView.iframeClickStillWorks = true;

  // --- Local: "You could have won" callout only appears for direct-link-to-target misses ---
  await seedCouldHaveWonSession(page);

  // Negative: no callout when the current page does NOT link directly to the destination.
  await page.route("**/get_article_with_links/**", async (route) => {
    const url = route.request().url();
    if (!url.includes("/get_article_with_links/")) return route.continue();

    // Only override Capybara for this check.
    if (!url.includes("/get_article_with_links/Capybara")) return route.continue();

    return await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ links: ["Not Rodent"] }),
    });
  });

  const noDirectLinkResp = page.waitForResponse(
    (resp) => resp.url().includes("/get_article_with_links/Capybara") && resp.ok(),
    { timeout: TIMEOUT_MS }
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await ensureTopLevelTab(page, "Play Game");
  await ensurePlayMode(page, "Local");
  await ensureLeaderboardExpanded(page);
  await selectLeaderboardRun(page, "You");
  await noDirectLinkResp;
  await sleep(250);
  assert(
    (await page.getByText("You could have won").count()) === 0,
    "Did not expect 'You could have won' callout when no direct link exists"
  );

  await page.unroute("**/get_article_with_links/**").catch(() => null);

  // Positive: callout appears when a hop page links directly to the destination but the next step isn't the destination.
  await page.route("**/get_article_with_links/**", async (route) => {
    const url = route.request().url();
    if (!url.includes("/get_article_with_links/")) return route.continue();
    if (!url.includes("/get_article_with_links/Capybara")) return route.continue();

    return await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ links: ["Rodent"] }),
    });
  });

  const directLinkResp = page.waitForResponse(
    (resp) => resp.url().includes("/get_article_with_links/Capybara") && resp.ok(),
    { timeout: TIMEOUT_MS }
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await ensureTopLevelTab(page, "Play Game");
  await ensurePlayMode(page, "Local");
  await ensureLeaderboardExpanded(page);
  await selectLeaderboardRun(page, "You");
  await directLinkResp;

  const couldHaveWon = page.getByText("You could have won");
  await couldHaveWon.waitFor({ timeout: 15_000 });
  await page.getByText(/Hop 0:\s*on\s*Capybara/i).waitFor({ timeout: 15_000 });
  summary.local.couldHaveWonCalloutOk = true;

  await page.getByRole("button", { name: "Jump to hop" }).click();
  const directLinkJumpValue = await page
    .getByRole("slider", { name: "Replay hop" })
    .inputValue();
  assert(
    directLinkJumpValue === "0",
    `Jump to hop should seek to the direct-link miss step index 0; got ${directLinkJumpValue}`
  );
  await page.getByText(/Hop 0:\s*Capybara/i).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Back to live" }).first().click();

  await page.getByRole("button", { name: "Replay", exact: true }).click();
  const replaySlider = page.getByRole("slider", { name: "Replay hop" });
  const replayHopValue = await replaySlider.inputValue();
  const replayMaxHop = await replaySlider.getAttribute("max");
  assert(
    replayHopValue === "1",
    `Replay should open on terminal hop 1 without a phantom no-op step; got ${replayHopValue}`
  );
  assert(
    replayMaxHop === "1",
    `Replay slider max should be terminal hop 1 without a phantom no-op step; got ${replayMaxHop}`
  );
  await page.getByText(/Hops:\s*1\s*\/\s*20/i).waitFor({ timeout: 15_000 });
  await page.getByText(/Hop 1:\s*Car/i).waitFor({ timeout: 15_000 });
  summary.localReplayLock.terminalNoopOpensLastStep = true;
  await page.getByRole("button", { name: "Back to live" }).first().click();

  await page.unroute("**/get_article_with_links/**").catch(() => null);

  await seedNoopTerminalSession(page);
  await page.route("**/get_article_with_links/**", async (route) => {
    const url = route.request().url();
    if (!url.includes("/get_article_with_links/")) return route.continue();
    if (!url.includes("/get_article_with_links/Capybara")) return route.continue();

    return await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ links: ["Rodent"] }),
    });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await ensureTopLevelTab(page, "Play Game");
  await ensurePlayMode(page, "Local");
  await ensureLeaderboardExpanded(page);
  await selectLeaderboardRun(page, "You");
  await sleep(500);
  assert(
    (await page.getByText("You could have won").count()) === 0,
    "Did not expect 'You could have won' callout for fragment-only/no-op transitions"
  );
  summary.local.couldHaveWonNoopSuppressedOk = true;

  await page.getByRole("button", { name: "Replay", exact: true }).click();
  const zeroHopReplaySlider = page.getByRole("slider", { name: "Replay hop" });
  assert(
    (await zeroHopReplaySlider.inputValue()) === "0",
    "0-hop terminal no-op run should keep replay slider on hop 0"
  );
  assert(
    (await zeroHopReplaySlider.getAttribute("max")) === "0",
    "0-hop terminal no-op run should cap replay slider max at hop 0"
  );
  const zeroHopTerminalStep = page
    .getByRole("button", { name: /Capybara#Overview\s*→\s*Capybara#Overview/i })
    .first();
  await zeroHopTerminalStep.waitFor({ timeout: 15_000 });
  assert(
    (await zeroHopTerminalStep.getAttribute("aria-current")) === "step",
    "0-hop terminal no-op replay should select the terminal step, not the start step"
  );
  summary.localReplayLock.zeroHopTerminalNoopOpensLastStep = true;
  await page.getByRole("button", { name: "Back to live" }).first().click();

  await page.unroute("**/get_article_with_links/**").catch(() => null);

  const malformedViewerRun = await page.evaluate(async () => {
    const mod = await import("/src/lib/hops.ts");
    const run = {
      start_article: "Capybara",
      steps: [
        {},
        null,
        "Capybara#Overview",
        "Rodent",
        42,
        { type: "note", article: "Wrong turn" },
      ],
    };
    const objectStepRun = {
      start_article: "Capybara",
      steps: [
        { type: "start", article: "Capybara" },
        { type: "note", article: "Wrong turn" },
        { type: "move", article: "Rodent" },
        { type: "win", article: "Capybara#Overview" },
      ],
    };
    return {
      path: mod.viewerRunPathArticles(run),
      hops: mod.viewerRunHops(run),
      objectStepPath: mod.viewerRunPathArticles(objectStepRun),
      objectStepHops: mod.viewerRunHops(objectStepRun),
    };
  });
  assert(
    Array.isArray(malformedViewerRun.path) &&
      malformedViewerRun.path.join(" > ") === "Capybara > Rodent",
    `Malformed viewer step entries should be ignored safely; got path=${JSON.stringify(
      malformedViewerRun.path
    )}`
  );
  assert(
    malformedViewerRun.hops === 1,
    `Malformed viewer step entries should preserve valid hop counts; got hops=${malformedViewerRun.hops}`
  );
  assert(
    malformedViewerRun.objectStepPath.join(" > ") === "Capybara > Rodent > Capybara",
    `Object viewer note steps should not affect path; got path=${JSON.stringify(
      malformedViewerRun.objectStepPath
    )}`
  );
  assert(
    malformedViewerRun.objectStepHops === 2,
    `Object viewer note steps should not affect hop counts; got hops=${malformedViewerRun.objectStepHops}`
  );
  summary.viewerDatasets.malformedStepPathRobustOk = true;

  // --- Local: client fallback validation must fail closed on backend 500s ---
  await ensureTopLevelTab(page, "Play Game");
  await page.getByRole("button", { name: "New race" }).click();
  await openLocalSetup(page);

  await clickQuickPreset(page, "hotseat");
  await setStartAndTargetInLocalSetup(page, { start: "Capybara", target: "Rodent" });

  let holdNextValidation = true;
  let releaseHeldValidation = null;
  let validationStartedResolve = null;
  let validationStartedPromise = Promise.resolve();
  function prepareHeldValidation() {
    holdNextValidation = true;
    releaseHeldValidation = null;
    validationStartedPromise = new Promise((resolve) => {
      validationStartedResolve = resolve;
    });
  }
  prepareHeldValidation();
  await page.route("**/local/validate_move", async (route) => {
    if (holdNextValidation) {
      holdNextValidation = false;
      await new Promise((resolve) => {
        releaseHeldValidation = resolve;
        validationStartedResolve?.();
      });
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ detail: "synthetic fallback failure" }),
    });
  });

  await page.route("**/get_article_with_links/**", async (route) => {
    const url = route.request().url();
    if (!url.includes("/get_article_with_links/Capybara")) return route.continue();

    return await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ title: "Capybara", links: ["Rodent"] }),
    });
  });

  await startRace(page);
  await ensureLeaderboardExpanded(page);
  await selectLeaderboardRun(page, "You");
  await page.getByRole("tab", { name: "Article" }).click();
  await sleep(400);

  const duplicateNavigateProbePromise = page
    .frameLocator("iframe")
    .first()
    .locator("body")
    .evaluate(async () => {
      const requestIds = [
        "play_regression_duplicate_nav_1",
        "play_regression_duplicate_nav_2",
      ];
      const received = [];

      return await new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", handleMessage);
          resolve({ duplicateRespondedBeforeValidation: false, received });
        }, 200);

        function handleMessage(event) {
          const data = event && event.data;
          if (!data || data.type !== "wikirace:navigate_response") return;
          if (!requestIds.includes(data.requestId)) return;

          received.push({ requestId: data.requestId, allow: data.allow });
          if (data.requestId === requestIds[1]) {
            window.clearTimeout(timeout);
            window.removeEventListener("message", handleMessage);
            resolve({ duplicateRespondedBeforeValidation: true, received });
          }
        }

        window.addEventListener("message", handleMessage);
        window.parent.postMessage(
          { type: "wikirace:navigate_request", requestId: requestIds[0], title: "Rodent" },
          "*"
        );
        window.parent.postMessage(
          { type: "wikirace:navigate_request", requestId: requestIds[1], title: "Rodent" },
          "*"
        );
      });
    });
  await validationStartedPromise;
  const duplicateNavigateProbe = await duplicateNavigateProbePromise;
  assert(
    !duplicateNavigateProbe.duplicateRespondedBeforeValidation,
    `Duplicate navigate request should wait for server validation; got ${JSON.stringify(
      duplicateNavigateProbe.received
    )}`
  );
  releaseHeldValidation?.();
  await sleep(1100);
  summary.local.duplicateNavigateRequestWaitsForValidationOk = true;

  prepareHeldValidation();
  await clickWikiLink(page, "Rodent");
  await validationStartedPromise;
  await sleep(850);
  const slowValidationSnapshot = await getActiveHumanRunSnapshot(page);
  assert(slowValidationSnapshot, "Expected an active human run snapshot during slow validation");
  assert(
    slowValidationSnapshot.steps_length === 1,
    `Slow validation should not record a move before the server responds; got steps_length=${slowValidationSnapshot.steps_length}`
  );
  const slowValidationPath = await page
    .frameLocator("iframe")
    .first()
    .locator("body")
    .evaluate(() => window.location.pathname);
  assert(
    decodeURIComponent(slowValidationPath).endsWith("/wiki/Capybara"),
    `Slow validation should fail closed in the iframe before the server responds; got path=${slowValidationPath}`
  );
  releaseHeldValidation?.();
  await sleep(1100);
  summary.local.slowValidationFailClosedOk = true;

  await clickWikiLink(page, "Rodent");
  await sleep(500);

  const fallbackSnapshot = await getActiveHumanRunSnapshot(page);
  assert(fallbackSnapshot, "Expected an active human run snapshot after fallback validation test");
  assert(
    fallbackSnapshot.steps_length === 1,
    `Validator 5xx should fail closed even for linked moves; got steps_length=${fallbackSnapshot.steps_length}`
  );
  assert(
    fallbackSnapshot.status === "running",
    `Fallback validation should leave the run active after rejecting a move; got status=${fallbackSnapshot.status}`
  );
  summary.local.fallbackValidationFailClosedOk = true;

  await page.unroute("**/local/validate_move").catch(() => null);
  await page.unroute("**/get_article_with_links/**").catch(() => null);

  // --- Local: deleting a running LLM run stops further /llm/local_run/step calls (no "zombie" runners) ---
  await ensureTopLevelTab(page, "Play Game");
  await page.getByRole("button", { name: "New race" }).click();
  await openLocalSetup(page);

  await clickQuickPreset(page, "you_vs_fast");
  await setStartAndTargetInLocalSetup(page, { start: "Capybara", target: "Rodent" });

  const stepReqPromise = page.waitForRequest(
    (req) => reqPath(req) === "/llm/local_run/step" && req.method() === "POST",
    { timeout: TIMEOUT_MS }
  );

  let releaseStepRoute = null;
  const releaseStepPromise = new Promise((resolve) => {
    releaseStepRoute = resolve;
  });

  await page.route("**/llm/local_run/step", async (route) => {
    // Only delay the very first step request; the rest should proceed normally.
    await page.unroute("**/llm/local_run/step").catch(() => null);

    await Promise.race([
      releaseStepPromise,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);

    try {
      await route.continue();
    } catch {
      // If the request is aborted (expected when deleting the run), continue silently.
    }
  });

  await startRace(page);
  await ensureLeaderboardExpanded(page);

  const stepReq = await stepReqPromise;
  const llmRunId = stepReq.headers()["x-wikirace-run-id"] || null;
  assert(llmRunId, "Expected x-wikirace-run-id header on /llm/local_run/step");

  const llmRunLabel = await waitForStoredRunLabel(page, llmRunId);
  assert(llmRunLabel, "Failed to resolve LLM run label from localStorage");

  // Run display names may omit the provider prefix (e.g. "openai-responses:").
  const labelNeedle = llmRunLabel.includes(":") ? llmRunLabel.split(":").pop() : llmRunLabel;
  const escapedNeedle = String(labelNeedle || llmRunLabel).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await selectLeaderboardRun(page, new RegExp(escapedNeedle, "i"));

  // Delete the running run (this should abort its in-flight controller).
  const arena = page.locator("#matchup-arena");
  await arena.getByRole("button", { name: "Delete", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete this run?" });
  await deleteDialog.waitFor();
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await deleteDialog.waitFor({ state: "hidden" });

  const deletedOk = await waitForStoredRunDeletion(page, llmRunId);
  assert(deletedOk, "Deleted LLM run should be removed from localStorage session");

  releaseStepRoute?.();
  await sleep(600);

  // Ensure no follow-up step requests happen for the deleted run.
  const extraStepReq = await page
    .waitForRequest(
      (req) =>
        reqPath(req) === "/llm/local_run/step" &&
        req.method() === "POST" &&
        req.headers()["x-wikirace-run-id"] === llmRunId,
      { timeout: 1500 }
    )
    .then(() => true)
    .catch(() => false);
  assert(!extraStepReq, "Deleted LLM run should not continue sending /llm/local_run/step requests");
  summary.local.llmRunDeletionStopsRequestsOk = true;

  // --- Local: run-level explicit unlimited budgets override finite session rules ---
  await seedRunLevelUnlimitedSession(page);
  const runLevelStepReqPromise = page.waitForRequest(
    (req) => reqPath(req) === "/llm/local_run/step" && req.method() === "POST",
    { timeout: TIMEOUT_MS }
  );

  await page.route("**/llm/local_run/step", async (route) => {
    if (reqPath(route.request()) !== "/llm/local_run/step") return route.continue();
    return await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        step: {
          type: "lose",
          article: "Capybara",
          at: new Date().toISOString(),
          metadata: { reason: "run_level_unlimited_regression" },
        },
      }),
    });
  });

  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await ensureTopLevelTab(page, "Play Game");
    await ensurePlayMode(page, "Local");
    const runLevelStepReq = await runLevelStepReqPromise;
    const runLevelStepBody = tryParseJson(runLevelStepReq.postData()) || {};
    assert(
      Object.prototype.hasOwnProperty.call(runLevelStepBody, "max_links") &&
        runLevelStepBody.max_links === null,
      `Run-level max_links=null should stay unlimited instead of inheriting finite session rules; got ${JSON.stringify(
        runLevelStepBody.max_links
      )}`
    );
    assert(
      Object.prototype.hasOwnProperty.call(runLevelStepBody, "max_tokens") &&
        runLevelStepBody.max_tokens === null,
      `Run-level max_tokens=null should stay unlimited instead of inheriting finite session rules; got ${JSON.stringify(
        runLevelStepBody.max_tokens
      )}`
    );
    summary.local.runLevelUnlimitedOverridesOk = true;
  } finally {
    await page.unroute("**/llm/local_run/step").catch(() => null);
  }

  const localLayoutKeyBeforeMultiplayer = await page.evaluate(() =>
    window.localStorage.getItem("wikirace:arena-layout:v1")
  );
  assert(
    localLayoutKeyBeforeMultiplayer,
    "Missing local arena layout key (wikirace:arena-layout:v1) before switching to multiplayer"
  );

  // --- Multiplayer: create/join/start + add AI after finish ---
  await openMultiplayerSetup(page);
  await setStartAndTargetInMultiplayerSetup(page, { start: "Capybara", target: "Rodent" });

  // Ensure Sprint preset is wired correctly (finite max_links/max_tokens).
  await page.getByRole("button", { name: "Sprint", exact: true }).click();
  const maxLinksInput = page.getByText("Max links (future AI)").locator("..").getByRole("textbox");
  const maxTokensInput = page.getByText("Max tokens (future AI)").locator("..").getByRole("textbox");
  await maxLinksInput.waitFor();
  await maxTokensInput.waitFor();
  assert(
    (await maxLinksInput.inputValue()) === "200",
    "Sprint preset should set room max_links to 200"
  );
  assert(
    (await maxTokensInput.inputValue()) === "1500",
    "Sprint preset should set room max_tokens to 1500"
  );
  summary.multiplayer.sprintRulesApplied = true;

  const browser = page.context().browser();
  assert(browser, "Playwright browser unavailable from page context");

  const storageFailureContext = await browser.newContext();
  const storageFailureWsUrls = [];
  await storageFailureContext.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    const sessionStorageRef = window.sessionStorage;
    Storage.prototype.setItem = function (key, value) {
      const storageKey = String(key);
      if (
        this === sessionStorageRef &&
        storageKey.startsWith("wikirace:multiplayer:")
      ) {
        throw new Error("synthetic sessionStorage setItem failure");
      }
      return originalSetItem.call(this, key, value);
    };
  });
  const storageFailurePage = await storageFailureContext.newPage();
  storageFailurePage.setDefaultTimeout(TIMEOUT_MS);
  storageFailurePage.on("websocket", (socket) => {
    const url = socket.url();
    if (url.includes("/rooms/")) {
      storageFailureWsUrls.push(url);
    }
  });

  try {
    await clearStorageAndReload(storageFailurePage);
    const storageFailureState = await storageFailurePage.evaluate(async () => {
      const multiplayerStore = await import("/src/lib/multiplayer-store.ts");
      const response = await multiplayerStore.createRoom({
        owner_name: "Storage Host",
        start_article: "Cat",
        destination_article: "Dog",
        rules: {
          max_hops: 12,
          max_links: 200,
          max_tokens: 1500,
          include_image_links: false,
          disable_links_view: false,
        },
      });

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const state = multiplayerStore.getMultiplayerState();
        if (state.ws_status === "connected") break;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }

      const state = multiplayerStore.getMultiplayerState();
      return {
        created: Boolean(response?.room_id),
        roomId: state.room?.id || null,
        wsStatus: state.ws_status,
        error: state.error || null,
      };
    });
    assert(
      storageFailureState.created &&
        storageFailureState.roomId &&
        storageFailureState.wsStatus === "connected" &&
        storageFailureWsUrls.some((url) => url.includes("/rooms/")),
      `Create room should still open the room websocket when multiplayer sessionStorage writes fail; got ${JSON.stringify(
        storageFailureState
      )} and ${storageFailureWsUrls.length} websocket(s)`
    );
    summary.multiplayer.storageFailureConnectOk = true;
  } finally {
    await storageFailureContext.close();
  }

  const mobileHostContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const mobileHostPage = await mobileHostContext.newPage();
    mobileHostPage.setDefaultTimeout(TIMEOUT_MS);
    await mobileHostPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await mobileHostPage.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();
    await openMultiplayerSetup(mobileHostPage);
    await mobileHostPage.getByRole("textbox", { name: "Host", exact: true }).fill("Mobile Host");
    const mobileCreateRoom = mobileHostPage.getByRole("button", {
      name: "Create room",
      exact: true,
    });
    await mobileCreateRoom.waitFor();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await mobileCreateRoom.isEnabled().catch(() => false)) break;
      await mobileHostPage.waitForTimeout(150);
    }
    assert(
      await mobileCreateRoom.isEnabled().catch(() => false),
      "Mobile host Create room button never became enabled"
    );
    await mobileCreateRoom.click();
    await mobileHostPage.getByText("Multiplayer lobby").waitFor({ timeout: 15_000 });

    const mobileStartRace = mobileHostPage.getByRole("button", {
      name: "Start race",
      exact: true,
    });
    await mobileStartRace.waitFor({ state: "visible", timeout: 10_000 });
    assert(
      await mobileStartRace.isEnabled().catch(() => false),
      "Mobile host should be able to start the race from the lobby"
    );
    await mobileHostPage.getByText("Add AI", { exact: true }).first().waitFor({
      state: "visible",
      timeout: 10_000,
    });
    summary.multiplayer.mobileHostControlsOk = true;
  } finally {
    await mobileHostContext.close();
  }

  const createRoomReqPromise = page.waitForRequest(
    (req) => reqPath(req) === "/rooms" && req.method() === "POST",
    { timeout: TIMEOUT_MS }
  );
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await page.getByText("Multiplayer lobby").waitFor({ timeout: 15_000 });

  const createRoomReq = await createRoomReqPromise;
  const createRoomBody = tryParseJson(createRoomReq.postData());

  assert(createRoomBody && typeof createRoomBody === "object", "create room request body missing/unparseable");
  assert(createRoomBody.rules?.max_hops === 12, "create room request should send Sprint max_hops=12");
  assert(createRoomBody.rules?.max_links === 200, "create room request should send Sprint max_links=200");
  assert(createRoomBody.rules?.max_tokens === 1500, "create room request should send Sprint max_tokens=1500");

  summary.multiplayer.createRoomRequest = {
    path: reqPath(createRoomReq),
    body: createRoomBody,
  };

  await page.waitForFunction(() => Boolean(new URL(window.location.href).searchParams.get("room")));
  const hostUrl = new URL(page.url());
  const roomId = hostUrl.searchParams.get("room");
  assert(roomId, "Host URL missing ?room=... after room creation");
  const inviteLink = `${hostUrl.origin}/?room=${roomId}`;

  const hostName = await page.evaluate(() => {
    return window.localStorage.getItem("wikirace:multiplayer:player-name") || "Host";
  });

  // A failed inline Add AI submission should preserve custom field values for retry.
  let rejectNextInlineAddAi = true;
  await page.route(`**/rooms/${roomId}/add_llm`, async (route) => {
    if (rejectNextInlineAddAi) {
      rejectNextInlineAddAi = false;
      return await route.fulfill({
        status: 500,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ detail: "synthetic add_llm failure" }),
      });
    }
    return await route.continue();
  });

  const inlineModelInput = page.getByLabel("Model");
  const inlineNameInput = page.getByPlaceholder("e.g. Bot #1");
  const inlineReasoningInput = page.getByPlaceholder("low / medium / high / xhigh");
  const inlineApiBaseInput = page.getByPlaceholder("http://localhost:8001/v1");
  const inlineApiModeInput = page.getByPlaceholder("chat / responses");

  await inlineModelInput.fill("openai-responses:gpt-5.2");
  await inlineNameInput.fill("Retry Bot");
  await inlineReasoningInput.fill("high");
  await inlineApiBaseInput.fill("http://localhost:8001/v1");
  await inlineApiModeInput.fill("responses");

  const rejectedInlineAddAiResponse = page.waitForResponse(
    (resp) =>
      reqPath(resp.request()).endsWith(`/rooms/${roomId}/add_llm`) &&
      resp.request().method() === "POST" &&
      resp.status() === 500,
    { timeout: TIMEOUT_MS }
  );
  await page.getByRole("button", { name: "Add AI", exact: true }).click();
  await rejectedInlineAddAiResponse;
  await page.getByText("synthetic add_llm failure").waitFor({ timeout: 10_000 });

  assert(
    (await inlineModelInput.inputValue()) === "openai-responses:gpt-5.2",
    "Inline Add AI should preserve model input after a failed submit"
  );
  assert(
    (await inlineNameInput.inputValue()) === "Retry Bot",
    "Inline Add AI should preserve display name after a failed submit"
  );
  assert(
    (await inlineReasoningInput.inputValue()) === "high",
    "Inline Add AI should preserve reasoning effort after a failed submit"
  );
  assert(
    (await inlineApiBaseInput.inputValue()) === "http://localhost:8001/v1",
    "Inline Add AI should preserve API base override after a failed submit"
  );
  assert(
    (await inlineApiModeInput.inputValue()) === "responses",
    "Inline Add AI should preserve API mode after a failed submit"
  );
  summary.multiplayer.addAiFailurePreservesFieldsOk = true;

  await page.unroute(`**/rooms/${roomId}/add_llm`).catch(() => null);

  // Second participant context: verifies invite deep-link + focus behavior.
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobileContext.newPage();
  mobilePage.setDefaultTimeout(TIMEOUT_MS);

  try {
    await mobilePage.goto(inviteLink, { waitUntil: "domcontentloaded" });
    await mobilePage.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();

    // Should land on Play Game + Multiplayer automatically.
    const playTabState = await mobilePage
      .getByRole("tab", { name: "Play Game" })
      .getAttribute("data-state")
      .catch(() => null);
    const multiplayerTabState = await mobilePage
      .getByRole("tab", { name: "Multiplayer", exact: true })
      .getAttribute("data-state")
      .catch(() => null);

    assert(playTabState === "active", "Invite link should land on the Play Game tab");
    assert(multiplayerTabState === "active", "Invite link should land on Multiplayer mode");

    await mobilePage.getByText("Join a room", { exact: true }).waitFor();
    const nameInput = mobilePage.getByPlaceholder("Player");
    await nameInput.waitFor();

    const focused = await nameInput.evaluate((el) => el === document.activeElement).catch(() => false);
    assert(focused, "Invite link should focus 'Join a room → Your name' when empty");
    summary.multiplayer.inviteLinkFocusOk = true;

    await nameInput.fill("Mobile");
    await mobilePage.getByRole("button", { name: "Join room", exact: true }).click();
    await mobilePage.getByText("Multiplayer lobby").waitFor({ timeout: 15_000 });
  } finally {
    // Keep mobilePage open for the arena checks below.
  }

  // Add one AI racer in the lobby.
  const quickAddModel = page.getByRole("button", { name: /^Add (?:openai-responses:)?gpt-/ }).first();
  await quickAddModel.click();
  await page.getByText("No AI racers yet.").waitFor({ state: "hidden" }).catch(() => null);
  await sleep(250);

  // Start the shared race.
  await page.getByRole("button", { name: "Start race", exact: true }).click();
  await page.getByText("Wikipedia view").waitFor({ timeout: 15_000 });
  await mobilePage.getByText("Wikipedia view").waitFor({ timeout: 15_000 });

  // Expand leaderboard + persist multiplayer layout key.
  await ensureLeaderboardExpanded(page);
  await setLeaderboardCollapsed(page, false);
  const multiplayerLayoutKey = await page.evaluate(() =>
    window.localStorage.getItem("wikirace:arena-layout:multiplayer:v1")
  );
  assert(multiplayerLayoutKey, "Missing multiplayer arena layout key (wikirace:arena-layout:multiplayer:v1)");
  summary.multiplayer.multiplayerLayoutKey = multiplayerLayoutKey;

  // Ensure multiplayer layout writes did not overwrite local layout.
  const localLayoutKeyAfter = await page.evaluate(() =>
    window.localStorage.getItem("wikirace:arena-layout:v1")
  );
  summary.multiplayer.localLayoutKeyUnchanged = localLayoutKeyAfter === localLayoutKeyBeforeMultiplayer;

  // Human move: Capybara -> Rodent (win in 1 hop).
  await selectLeaderboardRun(page, hostName);
  await page.getByRole("tab", { name: "Wiki", exact: true }).click();
  await clickWikiLink(page, "Rodent");
  await sleep(600);
  await mobilePage
    .getByText(new RegExp(`${hostName} won in 1 hop`, "i"))
    .first()
    .waitFor({ timeout: 15_000 });

  // Finish race deterministically: cancel AI + abandon mobile human.
  await ensureLeaderboardExpanded(page);
  await selectLeaderboardRun(page, /gpt-/);
  const runDetailsHeader = page.getByText("Run details", { exact: true }).locator("..");
  const cancelButton = runDetailsHeader.getByRole("button", { name: "Cancel", exact: true });
  if (await cancelButton.isVisible().catch(() => false)) {
    await cancelButton.click();
    await sleep(600);
  }

  await ensureLeaderboardExpanded(mobilePage);
  await selectLeaderboardRun(mobilePage, "Mobile");
  const mobileGiveUp = mobilePage.getByRole("button", { name: "Give up", exact: true });
  if (await mobileGiveUp.isVisible().catch(() => false)) {
    await mobileGiveUp.click();
    await sleep(400);
  }

  await page.getByText("Race finished").waitFor({ timeout: 20_000 });

  // Hide/show runs (client-side only).
  await selectLeaderboardRun(page, /gpt-/);
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("button", { name: /Show hidden/, exact: false }).waitFor();
  await page.getByRole("button", { name: /Show hidden/, exact: false }).click();
  await page.getByRole("button", { name: /Show hidden/, exact: false }).waitFor({ state: "hidden" });

  // Add AI after finish: verify request does NOT send max_links/max_tokens when blank.
  const addAiReqPromise = page.waitForRequest(
    (req) => reqPath(req).endsWith(`/rooms/${roomId}/add_llm`) && req.method() === "POST",
    { timeout: TIMEOUT_MS }
  );
  await page.getByRole("button", { name: "Add AI", exact: true }).click();
  const addAiDialog = page.getByRole("dialog", { name: /Add AI racer/i });
  await addAiDialog.waitFor();

  await addAiDialog.getByLabel("Model").fill("openai-responses:gpt-5.2");
  await addAiDialog.getByPlaceholder("low / medium / high / xhigh").fill("high");
  // IMPORTANT: leave Max links / Max tokens blank (should omit the keys).
  await addAiDialog.getByRole("button", { name: "Add AI", exact: true }).click();
  await addAiDialog.waitFor({ state: "hidden" });

  const addAiReq = await addAiReqPromise;
  const addAiBody = tryParseJson(addAiReq.postData()) || {};
  summary.multiplayer.addAiRequest = { path: reqPath(addAiReq), body: addAiBody };

  assert(addAiBody.model === "openai-responses:gpt-5.2", "Add AI request should include the selected model");
  assert(addAiBody.openai_reasoning_effort === "high", "Add AI request should include openai_reasoning_effort=high");

  summary.multiplayer.addAiOmittedOverrides =
    !Object.prototype.hasOwnProperty.call(addAiBody, "max_links") &&
    !Object.prototype.hasOwnProperty.call(addAiBody, "max_tokens");
  assert(
    summary.multiplayer.addAiOmittedOverrides,
    "Add AI request should omit max_links/max_tokens when blank (so the server uses room rules)"
  );

  await ensureLeaderboardExpanded(page);
  await page.getByText(/gpt-5\.2/i).first().waitFor({ timeout: 15_000 });
  await page.getByText(/\(high\)/i).first().waitFor({ timeout: 15_000 });
  summary.multiplayer.modelLabelIncludesEffort = true;

  // Invalid stored websocket credentials should clear local state and stop retrying.
  const staleContext = await browser.newContext();
  const staleWsUrls = [];
  await staleContext.addInitScript(
    ({ staleRoomId }) => {
      window.localStorage.setItem("wikirace:last-tab:v1", "play");
      window.localStorage.setItem("wikirace:play-mode:v1", "multiplayer");
      window.sessionStorage.setItem("wikirace:multiplayer:room-id", staleRoomId);
      window.sessionStorage.setItem("wikirace:multiplayer:player-id", "player_STALE");
      window.sessionStorage.setItem("wikirace:multiplayer:player-token", "token_STALE");
    },
    { staleRoomId: roomId }
  );
  const stalePage = await staleContext.newPage();
  stalePage.setDefaultTimeout(TIMEOUT_MS);
  stalePage.on("websocket", (socket) => {
    const url = socket.url();
    if (url.includes("/rooms/")) {
      staleWsUrls.push(url);
    }
  });

  try {
    await stalePage.goto(inviteLink, { waitUntil: "domcontentloaded" });
    await stalePage.getByRole("heading", { name: "WikiRacing Arena" }).waitFor();
    await stalePage.waitForTimeout(2200);

    const staleStorage = await stalePage.evaluate(() => {
      return {
        roomId: window.sessionStorage.getItem("wikirace:multiplayer:room-id"),
        playerId: window.sessionStorage.getItem("wikirace:multiplayer:player-id"),
        playerToken: window.sessionStorage.getItem("wikirace:multiplayer:player-token"),
      };
    });

    assert(
      staleStorage.roomId === null &&
        staleStorage.playerId === null &&
        staleStorage.playerToken === null,
      `Invalid websocket credentials should clear persisted multiplayer identity; got ${JSON.stringify(
        staleStorage
      )} with ${staleWsUrls.length} websocket connection(s)`
    );
    assert(
      staleWsUrls.length <= 1,
      `Invalid room credentials should not reconnect forever; saw ${staleWsUrls.length} websocket connections`
    );
    summary.multiplayer.terminalWsCloseClearsStateOk = true;
  } finally {
    await staleContext.close();
  }

  await mobileContext.close();

  // --- Token accounting (seeded) ---
  await seedTokenSession(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await ensureTopLevelTab(page, "Play Game");
  await ensurePlayMode(page, "Local");
  await ensureLeaderboardExpanded(page);
  await selectLeaderboardRun(page, /gpt-5\.2/i);

  const tokensLine = page.getByText(/in:\s*16\s*•\s*out:\s*9\s*•\s*total:\s*25/i).first();
  await tokensLine.waitFor({ timeout: 10_000 });
  summary.tokenSeed.tokensLine = safeText(await tokensLine.textContent().catch(() => null));
  summary.tokenSeed.totalsOk = true;

  // --- Viewer dataset persistence (saved via Save to viewer) ---
  assert(savedViewerDatasetName, "Expected a saved viewer dataset name from earlier in the run");
  await ensureTopLevelTab(page, "View Runs");
  await page.getByRole("button", { name: "Upload JSON", exact: true }).waitFor({ timeout: 15_000 });

  await openSelectContainingOption(page, "Qwen3-14B");
  const savedOptionText = `Saved: ${savedViewerDatasetName}`;
  const savedDatasetOption = page.getByRole("option", { name: savedOptionText, exact: true });
  await savedDatasetOption.waitFor({ timeout: 10_000 });
  await savedDatasetOption.click();

  await page.getByText("No runs available.").waitFor({ state: "hidden", timeout: 10_000 });
  summary.viewerDatasets.persistedAfterReload = true;

  await page.evaluate(() => {
    const raw = window.localStorage.getItem("wikirace:viewer-datasets:v1");
    const parsed = (() => {
      try {
        return JSON.parse(raw || "{}");
      } catch {
        return {};
      }
    })();
    const datasets = Array.isArray(parsed?.datasets) ? parsed.datasets : [];
    window.localStorage.setItem(
      "wikirace:viewer-datasets:v1",
      JSON.stringify({
        datasets: [
          {
            id: "viewer_dataset_malformed_seed",
            name: "Malformed persisted seed",
            created_at: new Date().toISOString(),
            data: {
              runs: [
                {
                  start_article: "Capybara",
                  destination_article: "Rodent",
                  result: "win",
                  steps: [{}, null, "Capybara#Overview", { article: "Rodent" }, 42],
                },
                null,
                { steps: [null] },
              ],
            },
          },
          ...datasets,
        ],
        selected_dataset_id: parsed?.selected_dataset_id || null,
      })
    );
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await ensureTopLevelTab(page, "View Runs");
  await page.getByRole("button", { name: "Upload JSON", exact: true }).waitFor({ timeout: 15_000 });
  await openSelectContainingOption(page, "Qwen3-14B");
  await page
    .getByRole("option", {
      name: "Saved: Malformed persisted seed",
      exact: true,
    })
    .click();
  await page.getByText("No runs available.").waitFor({ state: "hidden", timeout: 10_000 });

  // Legacy session imports should normalize missing rules and malformed budgets.
  const legacyImportCheck = await page.evaluate(async () => {
    const runMetrics = await import("/src/lib/run-metrics.ts");
    const sessionStore = await import("/src/lib/session-store.ts");
    const previousActiveSessionId = sessionStore.getSessionsSnapshot().active_session_id || null;
    const startedAt = new Date().toISOString();
    const { sessionId } = sessionStore.importSessionExport(
      {
        schema_version: 1,
        exported_at: new Date().toISOString(),
        session: {
          id: `session_legacy_${Date.now()}`,
          start_article: "Capybara",
          destination_article: "Rodent",
          created_at: new Date().toISOString(),
          runs: [
            {
              id: "run_legacy",
              kind: "human",
              started_at: startedAt,
              finished_at: startedAt,
              status: "finished",
              result: "win",
              max_steps: "oops",
              max_links: 0,
              max_tokens: "oops",
              steps: [
                { type: "move", article: "Capybara", at: startedAt },
                { type: "win", article: "Rodent", at: startedAt },
              ],
            },
          ],
        },
      },
      { replaceExisting: true }
    );

    const importedSession = sessionStore.getSession(sessionId);
    const importedRun = importedSession?.runs?.[0] || null;
    const directNoStartHopCounts = runMetrics.computeHopCountsByStepIndex(
      [
        { type: "move", article: "Capybara" },
        { type: "win", article: "Rodent" },
      ],
      "Capybara"
    );
    const normalized =
      Boolean(importedSession) &&
      importedSession.rules?.max_hops === 20 &&
      importedSession.rules?.max_links === null &&
      importedSession.rules?.max_tokens === null &&
      importedSession.rules?.include_image_links === false &&
      importedSession.rules?.disable_links_view === false &&
      Boolean(importedRun) &&
      typeof importedRun.max_steps === "undefined" &&
      typeof importedRun.max_links === "undefined" &&
      typeof importedRun.max_tokens === "undefined" &&
      importedRun.steps?.[0]?.type === "start" &&
      importedRun.steps?.[0]?.article === "Capybara" &&
      runMetrics.computeHopsFromSteps(importedRun.steps, importedSession.start_article) === 1 &&
      JSON.stringify(directNoStartHopCounts) === JSON.stringify([0, 1]);

    sessionStore.setActiveSessionId(previousActiveSessionId);
    return normalized;
  });
  assert(
    legacyImportCheck,
    "Legacy session import should normalize missing rules and malformed run budgets"
  );
  summary.local.legacyImportNormalizedOk = true;

  return summary;
}
