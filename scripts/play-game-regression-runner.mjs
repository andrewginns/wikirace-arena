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

  const summary = {
    local: {
      randomMatchup: null,
      duplicateRemovalWorked: false,
      winHopCountOk: false,
      rulesUnlimitedOk: false,
      traceHeadersOk: false,
      localLayoutKey: null,
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
  };

  // ---- Begin run ----
  await clearStorageAndReload(page);

  // --- Local setup + duplication + tracing + win ---
  await openLocalSetup(page);

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
  await clickWikiLink(page, "Rodent");
  await waitForWinToast(page);
  await page.getByText(/You won in 1 hop/i).first().waitFor({ timeout: 10_000 });
  summary.local.winHopCountOk = true;

  // Capture + lock in local layout key so we can confirm multiplayer doesn't overwrite it.
  await setLeaderboardCollapsed(page, true);
  const localLayoutKey = await page.evaluate(() =>
    window.localStorage.getItem("wikirace:arena-layout:v1")
  );
  assert(localLayoutKey, "Missing local arena layout key (wikirace:arena-layout:v1)");
  summary.local.localLayoutKey = localLayoutKey;

  // --- Local: disable_links_view hides Split/Links but does not block iframe clicks ---
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

  return summary;
}

