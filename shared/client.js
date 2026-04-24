// Companion-app shared client. Loaded by each evaluator page via <script type="module">.
// Expects the page to have:
//   - a <form id="evaluator-form"> with a submit button
//   - one or more <textarea> / <input> fields matching the evaluator's input shape
//   - a #status container for loading/error messages
//   - a #output container for rendered results
//   - a #rate-info container for quota display
//   - a data-evaluator attribute on the form identifying the evaluator

import { marked } from "https://cdn.jsdelivr.net/npm/marked@14.1.3/lib/marked.esm.js";

marked.setOptions({
  gfm: true,
  breaks: false,
});

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
    resetLabel ? ` · resets ${resetLabel}` : ""
  }`;
}

function collectInput(form) {
  // Each evaluator form has a single textarea named "userContent" plus
  // optional additional inputs. The UI/UX URL form has a url input as well.
  const data = new FormData(form);
  const payload = {};
  for (const [key, value] of data.entries()) {
    if (typeof value === "string") payload[key] = value.trim();
  }
  return payload;
}

function buildUserContent(evaluator, payload) {
  // Normalises the payload into a single userContent string that the
  // corresponding system prompt expects to receive.
  switch (evaluator) {
    case "prompt":
      return payload.userContent;
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
  setStatus("loading", "Sending to evaluator. This usually takes 15–45 seconds.");
  renderOutput("");

  try {
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evaluator, userContent }),
    });

    const data = await response.json().catch(() => null);

    if (response.status === 429) {
      const reset = data?.rateLimit?.reset;
      const resetLabel = reset
        ? new Date(reset).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "later today";
      setStatus(
        "rate-limited",
        `Daily limit reached. Try again after ${resetLabel}.`
      );
      renderRateInfo(data?.rateLimit);
      return;
    }

    if (!response.ok || !data?.text) {
      const msg = data?.error || `Request failed (HTTP ${response.status}).`;
      setStatus("error", msg);
      return;
    }

    setStatus(null);
    renderOutput(data.text);
    renderRateInfo(data.rateLimit);
  } catch (err) {
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

  // Initial empty state
  renderOutput("");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
