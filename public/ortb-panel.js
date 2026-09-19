import { reduceBidRequest } from "/bid-request-extract.js";
import { escapeHtml, setLatestPayload, setLoading } from "/app.js";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Server-side, the walk is bounded by AUDIT_BUDGET_MS (120s by default) instead of the
// old unbounded per-hop timeout math. This mirrors CLIENT_TIMEOUT_MS in app.js but sized
// for that longer server-side budget plus margin for network latency, so a legitimate
// full-length audit isn't cut off client-side before the server's own deadline fires.
const CLIENT_TIMEOUT_MS = 130_000;

const form = document.getElementById("ortb-form");
const input = document.getElementById("ortb-input");
const fileInput = document.getElementById("ortb-file");
const extractCard = document.getElementById("ortb-extract");
const message = document.getElementById("ortb-message");
const submitButton = document.getElementById("ortb-submit");

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

// reduceBidRequest deep-copies `source` wholesale and never validates its shape, so a
// pasted request can make `nodes` anything — including an object with its own `length`
// property. Coercing to an array here means every reader of `nodes` downstream gets a
// real array, and `.length` is always numeric. This is the one place that reaches into
// `reduced.source` for the chain nodes — every other caller goes through this helper.
function schainNodes(reduced) {
  const rawNodes = reduced.source?.ext?.schain?.nodes ?? reduced.source?.schain?.nodes;
  return Array.isArray(rawNodes) ? rawNodes : [];
}

// Mirrors lib/ortb.js's extractOrigin precedence (site, then app, then dooh) so the
// card's inventory label always matches what the server actually resolves the origin
// as. Falls back to "site" when none of the three are present, matching the previous
// behaviour for that case.
function inventoryKind(reduced) {
  if (reduced.site && typeof reduced.site === "object") {
    return "site";
  }
  if (reduced.app && typeof reduced.app === "object") {
    return "app";
  }
  if (reduced.dooh && typeof reduced.dooh === "object") {
    return "dooh";
  }
  return "site";
}

function renderExtractCard(reduced) {
  const site = reduced.site || {};
  const app = reduced.app || {};
  const dooh = reduced.dooh || {};
  const nodes = schainNodes(reduced);
  // OpenRTB 2.6 inventory sharing: shown so the user knows a second ads.txt will be read.
  const partner = reduced.site?.inventorypartnerdomain ?? reduced.app?.inventorypartnerdomain ?? null;
  const kind = inventoryKind(reduced);
  const domain = kind === "app"
    ? app.domain
    : kind === "dooh"
      ? dooh.domain
      : site.domain || hostOf(site.page);
  const needsInput = !domain;
  const file = kind === "app" ? "app-ads.txt" : "ads.txt";
  const inventoryLabel = kind === "app" ? "App" : kind === "dooh" ? "DOOH" : "Site";

  extractCard.hidden = false;
  extractCard.innerHTML = `
    <details class="extract-card__details" ${needsInput ? "open" : ""}>
      <summary>Extracted from this request${needsInput ? " — 1 needs input" : ""}</summary>
      <dl class="extract-card__rows">
        <dt>Inventory</dt><dd>${escapeHtml(inventoryLabel)}</dd>
        ${kind === "app"
          ? `<dt>Bundle</dt><dd>${escapeHtml(app.bundle || "—")}</dd>
             <dt>Store URL</dt><dd>${escapeHtml(app.storeurl || "—")}</dd>`
          : `<dt>Domain</dt><dd>${escapeHtml(domain || "—")}</dd>`}
        ${partner ? `<dt>Inventory partner</dt><dd>${escapeHtml(partner)}</dd>` : ""}
        <dt>Supply chain</dt><dd>${nodes.length} node${nodes.length === 1 ? "" : "s"}</dd>
      </dl>
      ${needsInput ? originPrompt(kind, file, app.storeurl) : ""}
    </details>
  `;

  const overrideField = document.getElementById("ortb-origin-domain");
  const target = document.getElementById("ortb-resolved-target");
  if (overrideField && target) {
    overrideField.addEventListener("input", () => {
      updateResolvedTarget(overrideField.value.trim(), file, target);
    });
  }
}

function updateResolvedTarget(domainValue, file, target) {
  target.textContent = `https://${domainValue || "<domain>"}/${file}`;
}

function originPrompt(kind, file, storeurl) {
  const isApp = kind === "app";
  const label = isApp ? "Developer domain" : "Publisher domain";
  // Site and DOOH requests have no store listing and no "developer" — only app requests
  // do, so the explanation and the store link must both be conditioned on origin kind,
  // not just the file name (DOOH shares site's file, "ads.txt").
  const explanation = isApp
    ? "is hosted on the developer's site from the store listing"
    : "is hosted on the publisher's own domain";
  // The store listing is literally where the developer domain is published, so linking
  // it answers "how am I supposed to know this?" rather than just demanding an answer.
  const storeLink = isApp && storeurl ? linkTo(storeurl, "Open the store listing") : "";

  return `
    <div class="extract-card__prompt">
      <label class="field">
        <span>${escapeHtml(label)}</span>
        <input id="ortb-origin-domain" type="text" placeholder="example.com" autocomplete="off" />
      </label>
      <p class="extract-card__hint">
        Not in the bid request. ${escapeHtml(file)} ${escapeHtml(explanation)}.
        Enter the domain and we will fetch <code id="ortb-resolved-target">https://&lt;domain&gt;/${escapeHtml(file)}</code>.
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

// Reads straight from the DOM rather than caching the typed value: renderExtractCard
// rebuilds the card's innerHTML (and this field along with it) on every keystroke in the
// JSON textarea, so a cached value could silently outlive the field that produced it.
function getOverride() {
  return document.getElementById("ortb-origin-domain")?.value.trim() ?? "";
}

const resultsPanel = document.getElementById("results");
const emptyState = document.getElementById("empty-state");
const summaryGrid = document.getElementById("summary-grid");
const resultsMeta = document.getElementById("results-meta");
const recordsList = document.getElementById("records-list");
const adsTxtUrlField = document.getElementById("adsTxtUrl");

function goToAdsTxtForm(text) {
  setMessage(text, "error");
  adsTxtUrlField.focus();
  adsTxtUrlField.scrollIntoView({ behavior: "smooth", block: "center" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const reduced = parseCurrent();
  if (!reduced || reduced === "invalid") {
    setMessage("Paste or upload a bid request first.", "error");
    return;
  }

  // Mirrors the server's own no_schain check (POST /api/audit-chain returns 422 with
  // reason: "no_schain" for the same condition) so an empty chain is caught before a
  // round trip. Goes through the same schainNodes(reduced) helper renderExtractCard
  // uses — the array coercion there is what keeps a hostile `nodes` shape from reaching
  // an innerHTML sink, and that guard has to hold everywhere `reduced` is read, not just
  // in the one place it was first fixed.
  if (schainNodes(reduced).length === 0) {
    goToAdsTxtForm("This bid request declares no supply chain, so there is nothing to audit. Enter an ads.txt URL and account ID instead.");
    return;
  }

  setMessage("Auditing...");
  setLoading(true);
  setLatestPayload(null);
  submitButton.disabled = true;

  // Backstops the wall-clock cap the server now enforces on the walk itself
  // (AUDIT_BUDGET_MS). Without this, a hung connection could leave the panel stuck on
  // "Auditing..." indefinitely with no way to submit again.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

  try {
    const response = await fetch("/api/audit-chain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bidRequest: reduced,
        ...(getOverride() ? { originDomainOverride: getOverride() } : {})
      }),
      signal: controller.signal
    });

    const payload = await response.json();

    // A request with no schain has nothing to audit, so hand the user to the existing
    // two-field form rather than leaving them at a dead end. That form takes a full URL
    // and an account ID, which is exactly what this case needs.
    if (payload.reason === "no_schain") {
      goToAdsTxtForm(payload.error);
      return;
    }

    if (!response.ok) {
      setMessage(payload.error || "Audit failed.", "error");
      return;
    }

    renderChainResults(payload);
    setMessage("Audit complete.", "success");
  } catch (error) {
    if (error.name === "AbortError") {
      setMessage(`No response after ${Math.round(CLIENT_TIMEOUT_MS / 1000)} seconds. The server may be unreachable.`, "error");
    } else {
      setMessage(error.message || "Audit failed.", "error");
    }
  } finally {
    clearTimeout(deadline);
    submitButton.disabled = false;
    setLoading(false);
    // setLoading(true) above hid both the results panel and the empty state. On success
    // renderChainResults unhides the results panel; on any failure path neither was ever
    // unhidden, which would otherwise leave the panel blank instead of back at rest.
    if (resultsPanel.hidden) {
      emptyState.hidden = false;
    }
  }
});

function renderChainResults(payload) {
  // This results surface is shared with the ads.txt form. Its "Copy JSON" button and
  // latestPayload are owned by app.js and would otherwise still point at whatever the
  // ads.txt form last produced, exporting a payload that doesn't match what's on screen.
  setLatestPayload(null);

  emptyState.hidden = true;
  resultsPanel.hidden = false;

  summaryGrid.innerHTML = [
    ["Hops", payload.summary.hops],
    ["Valid", payload.summary.pass],
    ["Broken", payload.summary.broken],
    ["Unverifiable", payload.summary.unverifiable]
  ].map(([label, value]) => `
    <div class="summary-card">
      <span class="summary-card__value">${escapeHtml(String(value))}</span>
      <span class="summary-card__label">${escapeHtml(label)}</span>
    </div>
  `).join("");

  // A non-pass verdict with firstFailedHop null means no WALKED hop itself failed — a
  // chain-level check did instead (e.g. complete_flag_contradicted, or the server's own
  // audit_budget_exceeded truncation guard). That covers both verdict "broken" (a
  // chain-level check earned FAIL outright) and "unverifiable" (the truncation guard
  // downgrades to this precisely because the unwalked hops are genuinely not-knowable,
  // not because anything walked was found broken). Either way the generic "could not be
  // fully verified" copy would bury the actual finding, so surface the failing check's
  // own message instead of gating this on a specific verdict string.
  const firstFailedChainCheck = payload.chainChecks.find((check) => check.status === "fail");
  const banner = payload.verdict === "pass"
    ? "Chain verified end to end"
    : payload.firstFailedHop !== null
      ? `Chain broken at hop ${payload.firstFailedHop + 1} of ${payload.summary.hops}`
      : firstFailedChainCheck
        ? firstFailedChainCheck.message
        : "Chain could not be fully verified";

  resultsMeta.innerHTML = `
    <p class="chain-verdict chain-verdict--${escapeHtml(payload.verdict)}">${escapeHtml(banner)}</p>
    <div class="chain-sources">
      <span class="label">Sources</span>
      ${payload.sources.map((source) => linkTo(source.url, source.label)).join(" ")}
    </div>
    ${payload.chainChecks.map((check) => `
      <p class="chain-check chain-check--${escapeHtml(check.status)}">${escapeHtml(check.message)}</p>
    `).join("")}
  `;

  recordsList.innerHTML = `
    <div class="chain-flow">
      <div class="chain-node chain-node--origin">
        <span class="chain-node__hop">origin</span>
        <span class="chain-node__domain">${escapeHtml(payload.origin.domain)}</span>
      </div>
      ${payload.hops.map((hop) => `
        <span class="chain-arrow chain-arrow--${escapeHtml(hop.verdict)}">&rarr;</span>
        <div class="chain-node chain-node--${escapeHtml(hop.verdict)}">
          <span class="chain-node__hop">hop ${hop.index + 1}</span>
          <span class="chain-node__domain">${escapeHtml(hop.asi)}</span>
          <span class="chain-node__sid">${escapeHtml(hop.sid)}</span>
        </div>
      `).join("")}
    </div>
    ${payload.hops.map((hop) => renderHopDetail(hop, payload)).join("")}
  `;
}

function renderHopDetail(hop, payload) {
  const adsTxtUrl = payload.sources.find((source) => source.kind === "ads-txt");
  const previous = payload.hops[hop.index - 1];

  // Each check links to the file that produced it. The chain link check links to both
  // files being compared, because "compare these two" is the actual instruction.
  const checks = [
    ["sellersJsonReachable", "sellers.json reachable", [[hop.sellerJsonUrl, `${hop.asi}/sellers.json`]]],
    ["sellerIdPresent", "Seller ID present", [[hop.sellerJsonUrl, `${hop.asi}/sellers.json`]]],
    ["sellerTypeValid", "Seller type valid", [[hop.sellerJsonUrl, `${hop.asi}/sellers.json`]]],
    ["chainLink", "Chain link to previous hop", previous
      ? [[hop.sellerJsonUrl, `${hop.asi}/sellers.json`], [previous.sellerJsonUrl, `${previous.asi}/sellers.json`]]
      : []],
    ["adsTxtDeclared", "Declared in ads.txt", adsTxtUrl ? [[adsTxtUrl.url, adsTxtUrl.label]] : []],
    ["sellerDomainAlignment", "Seller domain alignment", [[hop.sellerJsonUrl, `${hop.asi}/sellers.json`]]]
  ];

  return `
    <article class="chain-detail chain-detail--${escapeHtml(hop.verdict)}">
      <header class="chain-detail__head">
        <span>hop ${hop.index + 1} &middot; ${escapeHtml(hop.asi)} &middot; sid ${escapeHtml(hop.sid)}</span>
        <span class="badge badge--${escapeHtml(hop.verdict)}">${escapeHtml(hop.verdict)}</span>
      </header>
      ${checks.filter(([key]) => hop.checks[key].status !== "skip").map(([key, label, links]) => `
        <div class="chain-detail__check chain-detail__check--${escapeHtml(hop.checks[key].status)}">
          <strong>${escapeHtml(label)}</strong>
          <p>${escapeHtml(hop.checks[key].message)}</p>
          ${links.length
            ? `<p class="chain-detail__check-sources">${links.map(([url, label]) => linkTo(url, label)).join(" ")}</p>`
            : ""}
        </div>
      `).join("")}
      ${hop.seller ? `<pre class="chain-detail__raw">${escapeHtml(JSON.stringify(hop.seller, null, 2))}</pre>` : ""}
      ${hop.adsTxtLine ? `<pre class="chain-detail__raw">${escapeHtml(hop.adsTxtLine)}</pre>` : ""}
    </article>
  `;
}
