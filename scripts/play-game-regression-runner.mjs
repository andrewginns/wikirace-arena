export async function runPlayGameRegression(page, { baseUrl, timeoutMs } = {}) {
  const BASE_URL =
    baseUrl ||
    globalThis.process?.env?.PLAY_GAME_REGRESSION_BASE_URL ||
    "http://localhost:5173";
  const TIMEOUT_MS = typeof timeoutMs === "number" ? timeoutMs : 25_000;

  page.setDefaultTimeout(TIMEOUT_MS);

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
      await p.getByText("Leaderboard", { exact: true }).waitFor();
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

  async function seedTokenSession(p) {
    await p.evaluate(() => {
      const id = "session_mcp_tokens";
      const created_at = new Date().toISOString();

      const session = {
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
      };

      window.localStorage.setItem(
        "wikirace:sessions:v1",
        JSON.stringify({ sessions: { [id]: session } })
      );
      window.localStorage.setItem("wikirace:active-session-id", id);
    });
  }

  async function seedCouldHaveWonSession(p) {
    await p.evaluate(() => {
      const id = "session_could_have_won";
      const created_at = new Date().toISOString();

      const session = {
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
      };

      window.localStorage.setItem(
        "wikirace:sessions:v1",
        JSON.stringify({ sessions: { [id]: session } })
      );
      window.localStorage.setItem("wikirace:active-session-id", id);
    });
  }

  const summary = {
    local: {
      randomMatchup: null,
      articlesComboboxLiveUpdateOk: false,
      articlesComboboxKeyboardNavOk: false,
      articlesComboboxReopenScrollOk: false,
      couldHaveWonCalloutOk: false,
      llmRunDeletionStopsRequestsOk: false,
      duplicateRemovalWorked: false,
      winHopCountOk: false,
      rulesUnlimitedOk: false,
      traceHeadersOk: false,
      localLayoutKey: null,
    },
    localReplayLock: {
      blocksIframeNavigation: false,
    },
    localDisableLinksView: {
      splitLinksTabsHidden: false,
      iframeClickStillWorks: false,
    },
    multiplayer: {
      createRoomRequest: null,
      inviteLinkFocusOk: false,
      sprintRulesApplied: false,
      addAiRequest: null,
      addAiOmittedOverrides: false,
      modelLabelIncludesEffort: false,
      multiplayerLayoutKey: null,
      localLayoutKeyUnchanged: false,
    },
    tokenSeed: {
      tokensLine: null,
      totalsOk: false,
    },
    viewerDatasets: {
      storedOk: false,
      persistedAfterReload: false,
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

    // Keyboard navigation: ArrowDown/Enter should pick the focused option.
    const options = page.getByRole("option");
    const expected = safeText(await options.nth(0).textContent().catch(() => ""));
    assert(expected, "Expected at least 1 combobox option after filtering");

    // Because we started from an empty list, focus is -1. ArrowDown selects index 0.
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

  await page.getByRole("button", { name: "Replay", exact: true }).click();
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
      headers: { "Access-Control-Allow-Origin": "*" },
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
      headers: { "Access-Control-Allow-Origin": "*" },
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

  const llmRunLabel = await page.evaluate((runId) => {
    const active = window.localStorage.getItem("wikirace:active-session-id");
    const raw = window.localStorage.getItem("wikirace:sessions:v1");
    if (!active || !raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const session = parsed?.sessions?.[active];
      const run = session?.runs?.find((r) => r && r.id === runId);
      return run?.model || run?.player_name || null;
    } catch {
      return null;
    }
  }, llmRunId);
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

  const deletedOk = await page.evaluate((runId) => {
    const active = window.localStorage.getItem("wikirace:active-session-id");
    const raw = window.localStorage.getItem("wikirace:sessions:v1");
    if (!active || !raw) return false;
    try {
      const parsed = JSON.parse(raw);
      const session = parsed?.sessions?.[active];
      return !session?.runs?.some((r) => r && r.id === runId);
    } catch {
      return false;
    }
  }, llmRunId);
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

  // Second participant context: verifies invite deep-link + focus behavior.
  const browser = page.context().browser();
  assert(browser, "Playwright browser unavailable from page context");

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

  return summary;
}
