// POST /api/evaluate
//
// Vercel serverless function. Proxies evaluation requests to Anthropic
// using a server-held API key, rate-limits per IP via Upstash Redis.
//
// Request body:  { evaluator: "prompt" | "issue" | "uiux-url", userContent: string }
// Response:      { text, model, usage, rateLimit: { limit, remaining, reset } }
// On 429:        { error, rateLimit: { limit, remaining, reset } }

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
      "[evaluate] Upstash env vars missing — rate limiting is DISABLED. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
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
  // Vercel sets x-forwarded-for to "client, proxy1, proxy2..." — take the first.
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string") return real;
  return "unknown";
}

function readJsonBody(req) {
  // Vercel normally parses JSON automatically when Content-Type is application/json.
  // When it doesn't (e.g. raw body forwarded by some edge configs), fall back
  // to manual parse.
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

export default async function handler(req, res) {
  // CORS: same-origin only, but return a sane Vary for caches
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Origin");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---------- Parse & validate body ----------
  const body = readJsonBody(req);
  if (!body) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const { evaluator, userContent } = body;

  if (!VALID_EVALUATORS.has(evaluator)) {
    return res.status(400).json({
      error: `Unknown evaluator: ${evaluator}. Must be one of: ${[...VALID_EVALUATORS].join(", ")}`,
    });
  }

  if (typeof userContent !== "string" || userContent.trim().length < 20) {
    return res.status(400).json({
      error: "userContent must be a string of at least 20 characters",
    });
  }

  if (userContent.length > MAX_USER_CONTENT_LENGTH) {
    return res.status(413).json({
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
      return res.status(429).json({
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
    return res.status(500).json({ error: "Server configuration error" });
  }

  // ---------- Call Anthropic ----------
  try {
    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    // Extract text from content blocks. Anthropic returns an array; for our
    // usage we expect one or more text blocks. Concatenate them.
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");

    return res.status(200).json({
      text,
      model: response.model,
      usage: response.usage,
      rateLimit: rateLimitInfo,
    });
  } catch (err) {
    console.error("[evaluate] Anthropic error:", err);

    const status = err?.status || 500;
    const message =
      status === 429
        ? "Upstream model is rate-limited. Please try again in a moment."
        : status === 401
        ? "Server authentication error."
        : status >= 500
        ? "Upstream model error. Please try again."
        : err?.message || "Unexpected error";

    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: message,
      rateLimit: rateLimitInfo,
    });
  }
}
