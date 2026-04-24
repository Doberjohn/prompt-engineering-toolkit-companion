// Companion-app shared client. Loaded by each evaluator page via <script type="module">.
//
// Expects the page to have:
//   - a <form id="evaluator-form"> with a submit button
//   - one or more <textarea> / <input> fields matching the evaluator's input shape
//   - a #status container for loading/error messages
//   - a #output container for rendered results
//   - a #rate-info container for quota display
//   - a data-evaluator attribute on the form identifying the evaluator
//
// Network protocol: the server returns either a JSON error (status != 200)
// or a 200 NDJSON stream of frames. Each frame is a JSON object followed by
// a newline. Frame types:
//   { type: "message_start" }
//   { type: "text_delta", text: "..." }          // append to running buffer
//   { type: "done", rateLimit, usage, model }    // stream finished cleanly
//   { type: "error", error, rateLimit? }         // streaming-phase failure

import { marked } from "https://cdn.jsdelivr.net/npm/marked@14.1.3/lib/marked.esm.js";

marked.setOptions({ gfm: true, breaks: false });

const EMPTY_OUTPUT_TEXT = "Results will appear here after evaluation.";

function qs(sel, root = document) {
  return root.querySelector(sel);
}

function setStatus(kind, message) {
  const el = qs("#status");
  if (!el) return;
  el.className = "status";
  if (!kind) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.classList.add(`is-${kind}`);
  el.textContent = message;
}

function renderOutput(markdown) {
  const el = qs("#output");
  if (!el) return;
  if (!markdown) {
    el.classList.add("is-empty");
    el.textContent = EMPTY_OUTPUT_TEXT;
    return;
  }
  el.classList.remove("is-empty");
  el.innerHTML = marked.parse(markdown);
}

function renderRateInfo(rate) {
  const el = qs("#rate-info");
  if (!el || !rate) return;
  const { remaining, limit, reset } = rate;
  if (typeof remaining !== "number") {
    el.textContent = "";
    return;
  }
  const resetTime = reset ? new Date(reset) : null;
  const resetLabel = resetTime
    ? resetTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  el.innerHTML = `<strong>${remaining}</strong> / ${limit} remaining${
    resetLabel ? ` &middot; resets ${resetLabel}` : ""
  }`;
}

function collectInput(form) {
  const data = new FormData(form);
  const payload = {};
  for (const [key, value] of data.entries()) {
    if (typeof value === "string") payload[key] = value.trim();
  }
  return payload;
}

function buildUserContent(evaluator, payload) {
  switch (evaluator) {
    case "prompt":
    case "issue":
      return payload.userContent;
    case "uiux-url": {
      const url = payload.url || "";
      const extra = payload.userContent || "";
      if (!url) return "";
      return extra
        ? `URL to evaluate: ${url}\n\nAdditional context:\n${extra}`
        : `URL to evaluate: ${url}`;
    }
    default:
      return payload.userContent || "";
  }
}

function validate(evaluator, payload) {
  if (evaluator === "uiux-url") {
    if (!payload.url) return "A URL is required.";
    try {
      const u = new URL(payload.url);
      if (!["http:", "https:"].includes(u.protocol)) {
        return "URL must start with http:// or https://";
      }
    } catch {
      return "URL is not valid.";
    }
    return null;
  }
  if (!payload.userContent || payload.userContent.length < 20) {
    return "Please paste the content you want evaluated (at least 20 characters).";
  }
  if (payload.userContent.length > 50000) {
    return "Content is too long. Please trim to under 50,000 characters.";
  }
  return null;
}

// Handles non-streaming error responses (400, 413, 429, 500). The server
// returns these as regular JSON with a non-200 status.
async function handleNonStreamingResponse(response) {
  const data = await response.json().catch(() => null);

  if (response.status === 429) {
    const reset = data?.rateLimit?.reset;
    const resetLabel = reset
      ? new Date(reset).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "later today";
    setStatus("rate-limited", `Daily limit reached. Try again after ${resetLabel}.`);
    renderRateInfo(data?.rateLimit);
    return;
  }

  const msg = data?.error || `Request failed (HTTP ${response.status}).`;
  setStatus("error", msg);
}

// Reads an NDJSON stream line by line. Calls `onFrame` for each parsed JSON
// object. Handles chunk boundaries that may split a line in half.
async function readNdjsonStream(response, onFrame) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process every complete line in the buffer. The last (possibly partial)
    // line is left in the buffer for the next iteration.
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let frame;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        console.warn("[client] failed to parse NDJSON line:", line);
        continue;
      }
      onFrame(frame);
    }
  }

  // Flush any trailing content (defensive; server always ends with a newline)
  const remaining = buffer.trim();
  if (remaining) {
    try {
      onFrame(JSON.parse(remaining));
    } catch {
      // swallow
    }
  }
}

async function submit(evaluator, form, submitBtn) {
  const payload = collectInput(form);
  const validationError = validate(evaluator, payload);
  if (validationError) {
    setStatus("error", validationError);
    return;
  }

  const userContent = buildUserContent(evaluator, payload);

  submitBtn.disabled = true;
  const originalBtnText = submitBtn.textContent;
  submitBtn.textContent = "Evaluating...";
  setStatus("loading", "Streaming response. Text will appear as it is generated.");
  renderOutput("");

  let accumulated = "";
  let sawAnyText = false;
  let streamError = null;
  let finalRateLimit = null;

  try {
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evaluator, userContent }),
    });

    // Non-200: error returned as JSON, no streaming.
    if (!response.ok) {
      await handleNonStreamingResponse(response);
      return;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/x-ndjson")) {
      // Fallback: server returned plain JSON for some reason (e.g. proxy stripped streaming)
      const data = await response.json().catch(() => null);
      if (data?.text) {
        setStatus(null);
        renderOutput(data.text);
        renderRateInfo(data.rateLimit);
      } else {
        setStatus("error", "Unexpected response format from server.");
      }
      return;
    }

    await readNdjsonStream(response, (frame) => {
      switch (frame.type) {
        case "message_start":
          // Stream is alive; swap the status banner once the first frame arrives.
          setStatus("loading", "Generating response...");
          break;
        case "text_delta":
          if (typeof frame.text === "string") {
            accumulated += frame.text;
            sawAnyText = true;
            renderOutput(accumulated);
          }
          break;
        case "done":
          finalRateLimit = frame.rateLimit || null;
          break;
        case "error":
          streamError = frame.error || "Streaming failed";
          finalRateLimit = frame.rateLimit || null;
          break;
        default:
          // Unknown frame type — ignore
          break;
      }
    });

    if (streamError) {
      // If we already rendered partial output, keep it visible so the user
      // can see what came through before the failure.
      setStatus("error", streamError);
    } else if (!sawAnyText) {
      setStatus("error", "No response received from the model.");
    } else {
      setStatus(null);
    }

    renderRateInfo(finalRateLimit);
  } catch (err) {
    // Network-level failure (fetch threw) or reader threw mid-stream.
    // If we have partial output, keep it so the user isn't left blank.
    setStatus("error", `Network error: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalBtnText;
  }
}

function init() {
  const form = qs("#evaluator-form");
  if (!form) return;
  const evaluator = form.dataset.evaluator;
  if (!evaluator) {
    console.error("[client] form is missing data-evaluator attribute");
    return;
  }
  const submitBtn = qs('[type="submit"]', form);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit(evaluator, form, submitBtn);
  });

  const clearBtn = qs("[data-action='clear']", form);
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      form.reset();
      renderOutput("");
      setStatus(null);
    });
  }

  renderOutput("");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
