# Prompt Engineering Toolkit — Companion App

A thin web app that lets anyone try the three Prompt Engineering Toolkit evaluators without pasting API keys. Deployed on Vercel.

This is the companion app for [Doberjohn/prompt-engineering-toolkit](https://github.com/Doberjohn/prompt-engineering-toolkit). The toolkit contains the framework, evaluators, calibration sets, and skills. This repo contains only the web app that showcases three of them.

## What's inside

| Path | Purpose |
|---|---|
| `index.html` | Landing page with three evaluator cards |
| `prompt-evaluator.html` | PPEP prompt evaluator page |
| `issue-evaluator.html` | GitHub implementation plan issue evaluator page |
| `uiux-url-evaluator.html` | UI/UX URL mode evaluator page |
| `shared/styles.css` | Dark theme shared across all pages |
| `shared/client.js` | Fetches `/api/evaluate`, renders markdown results |
| `api/evaluate.js` | Vercel serverless function. Proxies to Anthropic, rate-limits per IP |
| `scripts/sync-prompts.js` | Build-time script: fetches canonical prompts from the toolkit repo on GitHub |
| `system-prompts/` | Populated by the sync script at build time. Gitignored |

## Architecture in one paragraph

The three HTML pages are static and ship with no secrets. When the user clicks Evaluate, the browser calls `POST /api/evaluate` on the same origin. The serverless function reads the appropriate system prompt from `system-prompts/`, checks the caller's IP against an Upstash Redis rate limit (10 evaluations per day per IP by default), forwards the request to Anthropic using a server-held API key, and returns the model's response as plain text. The user never sees or supplies a key.

The system prompts are fetched from the toolkit repo on GitHub at build time. The toolkit's markdown files remain the single source of truth.

## Required environment variables

All set in the Vercel project dashboard. None are exposed to the browser.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | — | Anthropic API key. Keep secret. |
| `UPSTASH_REDIS_REST_URL` | yes | — | From Upstash dashboard. Without this, rate limiting is disabled |
| `UPSTASH_REDIS_REST_TOKEN` | yes | — | From Upstash dashboard |
| `MODEL` | no | `claude-opus-4-7` | Anthropic model ID. Change without redeploying code |
| `RATE_LIMIT_PER_DAY` | no | `10` | Per-IP daily evaluation cap |
| `TOOLKIT_REPO` | no | `Doberjohn/prompt-engineering-toolkit` | Source repo for the canonical prompts. Useful when testing against a fork |
| `TOOLKIT_REF` | no | `main` | Branch or tag to fetch prompts from |

### Rotating the Anthropic key

1. In Vercel project dashboard, update `ANTHROPIC_API_KEY` to the new value
2. Redeploy (or trigger a redeploy via "Redeploy latest")
3. Revoke the old key in Anthropic console

Total time: under 60 seconds.

## Local development

```bash
git clone https://github.com/<your-username>/prompt-engineering-toolkit-companion
cd prompt-engineering-toolkit-companion
npm install

# Populate system-prompts/ by fetching from GitHub
npm run sync-prompts

# Create .env.local with the required vars (see above)
# Then start the local Vercel dev server
npm run dev
```

The app runs at `http://localhost:3000` with hot reload for static files. Changes to `api/evaluate.js` require restarting the dev server.

## Deployment

Connect this repository to a Vercel project. In the project's settings:

- **Build command**: `npm run build` (runs `sync-prompts` automatically)
- **Output directory**: leave as default (Vercel auto-detects)
- **Install command**: `npm install`

Set the environment variables listed above. Deploy.

## Keeping in sync with the toolkit

The `system-prompts/` folder is not committed. It is regenerated from the toolkit's GitHub raw URLs every time Vercel builds. The fetch targets the `main` branch of the toolkit repo by default (configurable via `TOOLKIT_REPO` and `TOOLKIT_REF` env vars).

This means: when you update `prompts/issue-evaluator.md` in the toolkit and push to `main`, the companion app will pick up the change on its **next build** — not automatically.

To propagate toolkit changes to the live app, you need to trigger a rebuild. Three options:

**Option 1: Manual redeploy (simplest, no setup)**
After pushing to the toolkit's `main` branch, open the Vercel dashboard for this app and click "Redeploy latest". Takes ~30 seconds.

**Option 2: Vercel deploy hook (recommended)**
In the Vercel project settings, create a deploy hook URL. Then add a GitHub Action to the toolkit repo (in `.github/workflows/notify-companion.yml`):

```yaml
name: Trigger companion app rebuild
on:
  push:
    branches: [main]
    paths:
      - 'prompts/**'
jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Vercel deploy hook
        run: curl -X POST ${{ secrets.COMPANION_DEPLOY_HOOK }}
```

Store the deploy hook URL in the toolkit repo's GitHub Actions secrets as `COMPANION_DEPLOY_HOOK`. Now every push that touches `prompts/**` triggers a companion app rebuild automatically.

**Option 3: Scheduled rebuild**
A daily cron job that rebuilds regardless. Wasteful but zero coupling between repos. Not recommended unless you want full independence between the repos.

The sync script also strips human-facing preambles from the UI/UX mode file (the instructional framing above the first `---` divider), so those tokens aren't wasted on every API call.

## Flagged technical debt

Documented here so future maintainers (including future me) know what was deferred and why.

1. **No streaming.** Responses take 15-45 seconds and show a static spinner. Streaming (SSE from the Anthropic SDK, parsed on the client) would feel dramatically better. Deferred because the non-streaming path is simpler to debug on v1.
2. **`marked` from CDN.** If jsdelivr has an outage, markdown rendering breaks. Self-hosting `marked.esm.js` would fix this. Deferred; acceptable for a demo.
3. **Cold-start latency.** First request after ~10 minutes of inactivity has an extra 1-2 second penalty. Inherent to serverless. Fixing requires either Vercel Pro's keep-warm or migrating to an edge runtime, which loses Node `fs` access (and therefore our system-prompt loading approach). Deferred.
4. **No retry on upstream 429.** If Anthropic rate-limits the proxy, the user gets a one-line error with no retry. Exponential backoff would be a small, valuable improvement.
5. **Rate limit is per-IP, not per-session.** Users behind shared NAT share a quota. Acceptable for a demo but worth noting.
6. **`MAX_TOKENS` is hardcoded to 8000.** Sufficient for all three evaluators today. If the issue or UI/UX rubrics grow, this becomes a ceiling to revisit.
7. **No request logging or analytics.** Intentional (privacy), but makes debugging production issues harder. If abuse becomes a real concern, structured logs to Vercel's console (no user content, just outcomes) would help without compromising privacy.
8. **Build depends on GitHub raw availability.** If `raw.githubusercontent.com` is down at build time, deployment fails. Historically this is reliable (enterprise-grade uptime), but it is a new external dependency compared to the same-repo version. Mitigation: the build script aborts loudly rather than silently deploying stale content.
9. **Manual redeploy coupling.** Prompt changes in the toolkit don't automatically propagate without the deploy-hook setup. Acceptable tradeoff for the independence gain, but worth knowing.

## Cost ceiling

With defaults (Opus 4.7, 10 evaluations per IP per day, ~$0.15-0.30 per evaluation), a single IP maxing out their daily quota costs $1.50-$3.00. A realistic busy day with 50 distinct visitors who each do 2-3 evaluations costs roughly $15-$45. Adjust `MODEL` and `RATE_LIMIT_PER_DAY` environment variables if that's outside your comfort zone.

## License

MIT.
