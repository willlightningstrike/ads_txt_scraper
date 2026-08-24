import { reduceBidRequest } from "/bid-request-extract.js";
import { escapeHtml } from "/app.js";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const form = document.getElementById("ortb-form");
const input = document.getElementById("ortb-input");
const fileInput = document.getElementById("ortb-file");
const extractCard = document.getElementById("ortb-extract");
const message = document.getElementById("ortb-message");

let pendingOverride = "";

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    return;
  }

  // Checked before reading: a multi-hundred-megabyte file would otherwise be read into
  // memory and parsed before anyone could tell the user it was too big.
  if (file.size > MAX_UPLOAD_BYTES) {
    setMessage(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`, "error");
    fileInput.value = "";
    return;
  }

  input.value = await file.text();
  // Cleared on the success path too, not just the oversize path: without this, re-picking
  // the same filename (e.g. after editing it on disk) fires no "change" event at all.
  fileInput.value = "";
  refreshExtract();
});

input.addEventListener("input", refreshExtract);

input.addEventListener("dragover", (event) => {
  event.preventDefault();
});

input.addEventListener("drop", async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    // No file on this drop (e.g. a plain text drag) — leave the event alone so the
    // browser's native "insert dropped text" behavior still runs.
    return;
  }
  event.preventDefault();
  if (file.size > MAX_UPLOAD_BYTES) {
    setMessage(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`, "error");
    return;
  }
  input.value = await file.text();
  refreshExtract();
});

function parseCurrent() {
  const raw = input.value.trim();
  if (!raw) {
    return null;
  }

  try {
    return reduceBidRequest(JSON.parse(raw));
  } catch {
    return "invalid";
  }
}

function refreshExtract() {
  const reduced = parseCurrent();

  if (reduced === null) {
    extractCard.hidden = true;
    setMessage("");
    return;
  }

  if (reduced === "invalid") {
    extractCard.hidden = true;
    setMessage("That is not valid JSON.", "error");
    return;
  }

  setMessage("");
  renderExtractCard(reduced);
}

function renderExtractCard(reduced) {
  const site = reduced.site || {};
  const app = reduced.app || {};
  // reduceBidRequest deep-copies `source` wholesale and never validates its shape, so a
  // pasted request can make `nodes` anything — including an object with its own `length`
  // property. Coercing to an array at the source (not just at the render call site) means
  // every reader of `nodes` downstream gets a real array, and `.length` is always numeric.
  const rawNodes = reduced.source?.ext?.schain?.nodes ?? reduced.source?.schain?.nodes;
  const nodes = Array.isArray(rawNodes) ? rawNodes : [];
  const isApp = Boolean(reduced.app);
  const domain = isApp ? app.domain : site.domain || hostOf(site.page);
  const needsInput = !domain;

  extractCard.hidden = false;
  extractCard.innerHTML = `
    <details class="extract-card__details" ${needsInput ? "open" : ""}>
      <summary>Extracted from this request${needsInput ? " — 1 needs input" : ""}</summary>
      <dl class="extract-card__rows">
        <dt>Inventory</dt><dd>${escapeHtml(isApp ? "App" : "Site")}</dd>
        ${isApp
          ? `<dt>Bundle</dt><dd>${escapeHtml(app.bundle || "—")}</dd>
             <dt>Store URL</dt><dd>${escapeHtml(app.storeurl || "—")}</dd>`
          : `<dt>Domain</dt><dd>${escapeHtml(domain || "—")}</dd>`}
        <dt>Supply chain</dt><dd>${nodes.length} node${nodes.length === 1 ? "" : "s"}</dd>
      </dl>
      ${needsInput ? originPrompt(isApp, app.storeurl) : ""}
    </details>
  `;

  const overrideField = document.getElementById("ortb-origin-domain");
  if (overrideField) {
    overrideField.addEventListener("input", () => {
      pendingOverride = overrideField.value.trim();
    });
  } else {
    pendingOverride = "";
  }
}

function originPrompt(isApp, storeurl) {
  const file = isApp ? "app-ads.txt" : "ads.txt";
  const label = isApp ? "Developer domain" : "Publisher domain";
  // Site requests have no store listing and no "developer" — only app requests do, so the
  // explanation and the store link must both be conditioned on origin kind, not just the
  // file name.
  const explanation = isApp
    ? "is hosted on the developer's site from the store listing"
    : "is hosted on the publisher's own domain";
  // The store listing is literally where the developer domain is published, so linking
  // it answers "how am I supposed to know this?" rather than just demanding an answer.
  const storeLink = isApp && storeurl ? linkTo(storeurl, "Open the store listing") : "";

  return `
    <div class="extract-card__prompt">
      <label class="field">
        <span>${label}</span>
        <input id="ortb-origin-domain" type="text" placeholder="example.com" autocomplete="off" />
      </label>
      <p class="extract-card__hint">
        Not in the bid request. ${escapeHtml(file)} ${explanation}.
        Enter the domain and we will fetch <code>https://&lt;domain&gt;/${escapeHtml(file)}</code>.
        ${storeLink}
      </p>
    </div>
  `;
}

// Only https links are ever emitted. escapeHtml alone is not enough for an href:
// an escaped javascript: URI still executes when the user clicks it.
function safeHref(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function linkTo(url, label) {
  const href = safeHref(url);
  const text = escapeHtml(label);
  return href
    ? `<a class="source-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
    : `<span class="source-link source-link--dead">${text}</span>`;
}

function hostOf(value) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return "";
  }
}

function setMessage(text, tone = "neutral") {
  message.textContent = text;
  message.dataset.tone = tone;
}

function getOverride() {
  return pendingOverride;
}
