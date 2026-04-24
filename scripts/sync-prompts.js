// Fetches canonical system prompts from the Prompt Engineering Toolkit
// repository on GitHub and writes them to system-prompts/.
//
// The toolkit's markdown files are the single source of truth. This script
// runs on every Vercel build (via `npm run build`), so the deployed app
// always ships with the latest versions pushed to the toolkit's main branch.
//
// Some source files (uiux-evaluator/*.md) include a human-facing preamble
// above the first `---` divider, intended for readers who will manually
// paste the prompt into a session. That preamble is wasted tokens when
// used as an API system prompt, so we strip it.
//
// If any fetch fails, the build aborts. We never want to deploy the app
// with stale or missing prompts silently.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const destDir = resolve(appRoot, "system-prompts");

// Configurable via env var for testing against a fork or branch.
const TOOLKIT_REPO = process.env.TOOLKIT_REPO || "Doberjohn/prompt-engineering-toolkit";
const TOOLKIT_REF = process.env.TOOLKIT_REF || "refs/heads/main";
const RAW_BASE = `https://raw.githubusercontent.com/${TOOLKIT_REPO}/${TOOLKIT_REF}/prompts`;

// Map: destination filename -> { source path relative to prompts/, strip preamble? }
const mapping = {
  "prompt.md": { source: "prompt-evaluator.md", stripPreamble: false },
  "issue.md": { source: "issue-evaluator.md", stripPreamble: false },
  "uiux-url.md": { source: "uiux-evaluator/url-mode.md", stripPreamble: true },
};

const FETCH_TIMEOUT_MS = 15000;

function stripHumanPreamble(text) {
  const lines = text.split("\n");
  const dividerIndex = lines.findIndex((line) => line.trim() === "---");
  if (dividerIndex === -1) return text;
  return lines.slice(dividerIndex + 1).join("\n").replace(/^\n+/, "");
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`[sync-prompts] source: ${RAW_BASE}`);
  await mkdir(destDir, { recursive: true });

  const results = [];
  for (const [destName, config] of Object.entries(mapping)) {
    const url = `${RAW_BASE}/${config.source}`;
    const dest = resolve(destDir, destName);

    let content;
    try {
      content = await fetchWithTimeout(url);
    } catch (err) {
      console.error(`[sync-prompts] FAILED to fetch ${url}`);
      console.error(`[sync-prompts] reason: ${err.message}`);
      console.error("[sync-prompts] aborting build to prevent deploying stale or missing prompts.");
      process.exit(1);
    }

    const originalLength = content.length;
    if (config.stripPreamble) {
      content = stripHumanPreamble(content);
    }
    await writeFile(dest, content, "utf8");

    results.push({
      source: config.source,
      dest: destName,
      bytes: originalLength,
      stripped: config.stripPreamble ? originalLength - content.length : 0,
    });
  }

  console.log("[sync-prompts] fetched:");
  for (const r of results) {
    const note = r.stripped > 0 ? ` (stripped ${r.stripped} preamble chars)` : "";
    console.log(`  ${r.source} (${r.bytes} bytes) -> system-prompts/${r.dest}${note}`);
  }
}

main().catch((err) => {
  console.error("[sync-prompts] unexpected failure:", err);
  process.exit(1);
});
