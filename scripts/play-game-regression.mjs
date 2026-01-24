import process from "node:process";
import { chromium } from "playwright";
import { runPlayGameRegression } from "./play-game-regression-runner.mjs";

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.PLAY_GAME_REGRESSION_BASE_URL || "http://localhost:5173",
    headed: false,
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

    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }

    throw new Error(`Unknown arg: ${arg}`);
  }

  return args;
}

function printHelp() {
   
  console.log(`Play Game regression runner\n\nUsage:\n  yarn play:regression\n  yarn play:regression --headed\n  yarn play:regression --base-url http://localhost:5173\n\nNotes:\n- Assumes the API + UI servers are already running.\n- Requires Playwright browsers (Chromium): yarn playwright install chromium (or make playwright-install)\n- For a fully-managed one-shot (start servers + run + stop), use: make play-game-regression (installs browsers automatically)\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  process.env.PLAY_GAME_REGRESSION_BASE_URL = args.baseUrl;

  const browser = await chromium.launch({ headless: !args.headed });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const summary = await runPlayGameRegression(page, { baseUrl: args.baseUrl });
     
    console.log(JSON.stringify({ ok: true, summary }, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (err) {
   
  console.error("Play Game regression suite failed");
   
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
}
