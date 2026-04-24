// POST /api/evaluate
//
// Vercel serverless function. Proxies evaluation requests to Anthropic
// using a server-held API key, rate-limits per IP via Upstash Redis,
// and streams the model response back to the client as newline-delimited
// JSON (NDJSON) so the browser can render tokens progressively.
//
// Request body:  { evaluator: "prompt" | "issue" | "uiux-url", userContent: string }
//
// Response (success, 200):
//   Content-Type: application/x-ndjson
//   One JSON object per line. Event types pass through from Anthropic's SDK
//   (message_start, content_block_start, content_block_delta, content_block_stop,
//   message_delta, message_stop), plus a final custom frame we emit:
//     { type: "done", rateLimit: {...}, usage: {...}, model: "..." }
//
// Response (errors): standard JSON { error, rateLimit? } with appropriate status.

import Anthropic from "@anthropic-ai/sdk";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Config ----------
const MODEL = process.env.MODEL || "claude-opus-4-7";
const RATE_LIMIT_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY || 10);
const MAX_TOKENS = 8000;
const MAX_USER_CONTENT_LENGTH = 50000;

const VALID_EVALUATORS = new Set(["prompt", "issue", "uiux-url"]);

// ---------- Module-scope singletons (cached across warm invocations) ----------
let anthropicClient = null;
let rateLimiter = null;
const systemPromptCache = new Map();

function getAnthropic() {
  if (!anthropicClient) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    anthropicClient = new Anthropic({ apiKey: key });
  }
  return anthropicClient;
}

function getRateLimiter() {
  if (rateLimiter) return rateLimiter;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.warn(
      "[evaluate] Upstash env vars missing - rate limiting is DISABLED. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
    );
    return null;
  }
  const redis = new Redis({ url, token });
  rateLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(RATE_LIMIT_PER_DAY, "1 d"),
    analytics: false,
    prefix: "ptk-eval",
  });
  return rateLimiter;
}

async function loadSystemPrompt(evaluator) {
  if (systemPromptCache.has(evaluator)) {
    return systemPromptCache.get(evaluator);
  }
  const filename = `${evaluator}.md`;
  const promptPath = resolve(__dirname, "..", "system-prompts", filename);
  const content = await readFile(promptPath, "utf8");
  systemPromptCache.set(evaluator, content);
  return content;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string") return real;
  return "unknown";
}

function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function writeJson(res, status, payload) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

// Write a single NDJSON frame to the response. Each frame is a JSON object
// followed by a newline. The client parses line-by-line.
function writeFrame(res, frame) {
  res.write(JSON.stringify(frame) + "\n");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Origin");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return writeJson(res, 405, { error: "Method not allowed" });
  }

  // ---------- Parse & validate body ----------
  const body = readJsonBody(req);
  if (!body) {
    return writeJson(res, 400, { error: "Invalid JSON body" });
  }

  const { evaluator, userContent } = body;

  if (!VALID_EVALUATORS.has(evaluator)) {
    return writeJson(res, 400, {
      error: `Unknown evaluator: ${evaluator}. Must be one of: ${[...VALID_EVALUATORS].join(", ")}`,
    });
  }

  if (typeof userContent !== "string" || userContent.trim().length < 20) {
    return writeJson(res, 400, {
      error: "userContent must be a string of at least 20 characters",
    });
  }

  if (userContent.length > MAX_USER_CONTENT_LENGTH) {
    return writeJson(res, 413, {
      error: `userContent exceeds ${MAX_USER_CONTENT_LENGTH} characters`,
    });
  }

  // ---------- Rate limit ----------
  const ip = getClientIp(req);
  const limiter = getRateLimiter();
  let rateLimitInfo = { limit: RATE_LIMIT_PER_DAY, remaining: null, reset: null };

  if (limiter) {
    const result = await limiter.limit(`ip:${ip}`);
    rateLimitInfo = {
      limit: result.limit,
      remaining: result.remaining,
      reset: new Date(result.reset).toISOString(),
    };
    if (!result.success) {
      return writeJson(res, 429, {
        error: "Daily limit reached for your IP.",
        rateLimit: rateLimitInfo,
      });
    }
  }

  // ---------- Load system prompt ----------
  let systemPrompt;
  try {
    systemPrompt = await loadSystemPrompt(evaluator);
  } catch (err) {
    console.error("[evaluate] failed to load system prompt:", err);
    return writeJson(res, 500, { error: "Server configuration error" });
  }

  // ---------- Stream from Anthropic ----------
  // From this point on we're committing to a streaming response. Headers
  // must be sent before the first write. After this point, any failure
  // has to be communicated as a frame in the stream, not as an HTTP status.

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  // Flush headers immediately so the browser starts receiving bytes
  // and doesn't buffer the response.
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  let finalUsage = null;
  let streamModel = MODEL;

  try {
    const anthropic = getAnthropic();
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    // The SDK emits raw SSE events as an AsyncIterable. We pass the useful
    // ones through to the client as NDJSON frames. The client only needs
    // content_block_delta events to render progressive text, but we include
    // the lifecycle events for debuggability and future-proofing.
    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          if (event.message?.model) streamModel = event.message.model;
          writeFrame(res, { type: "message_start" });
          break;

        case "content_block_delta":
          // Only text deltas are relevant. The toolkit evaluators don't use
          // tool-use, thinking, or other block types.
          if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
            writeFrame(res, { type: "text_delta", text: event.delta.text });
          }
          break;

        case "message_delta":
          // message_delta carries the final usage on stop. Capture it so
          // we can include it in the done frame.
          if (event.usage) finalUsage = event.usage;
          break;

        case "message_stop":
          // Drained. Fall through to the done frame after the loop.
          break;

        // Other events (content_block_start, content_block_stop, ping)
        // are not useful to the client for this app. Ignored on purpose.
        default:
          break;
      }
    }

    // Final synchronous completion — may also contain usage if not captured above
    const finalMessage = await stream.finalMessage();
    if (!finalUsage && finalMessage?.usage) finalUsage = finalMessage.usage;

    writeFrame(res, {
      type: "done",
      model: streamModel,
      usage: finalUsage,
      rateLimit: rateLimitInfo,
    });
    res.end();
  } catch (err) {
    console.error("[evaluate] streaming error:", err);

    // We've already committed to 200 + streaming headers, so we can't change
    // the HTTP status. The client looks for an `error` frame and renders it.
    const status = err?.status || 500;
    const message =
      status === 429
        ? "Upstream model is rate-limited. Please try again in a moment."
        : status === 401
        ? "Server authentication error."
        : status >= 500
        ? "Upstream model error. Please try again."
        : err?.message || "Unexpected error";

    try {
      writeFrame(res, {
        type: "error",
        upstreamStatus: status,
        error: message,
        rateLimit: rateLimitInfo,
      });
      res.end();
    } catch {
      // If the socket is already closed, nothing we can do.
      try { res.end(); } catch { /* swallow */ }
    }
  }
}
