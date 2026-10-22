import { reduceBidRequest, formatJson } from "/bid-request-extract.js";
import { escapeHtml, setLatestPayload, startRequest, isCurrentRequest, finishRequest, describeFailure, showMode } from "/app.js";

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
const lineNumbers = document.getElementById("editor-lines");
const editorStats = document.getElementById("editor-stats");
const discoveryStatus = document.getElementById("discovery-status");
let editVersion = 0;
let overrideIdentity = null;

// Keep the gutter aligned when the user resizes the textarea or expands the editor.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => { lineNumbers.style.maxHeight = `${input.clientHeight}px`; }).observe(input);
}

function updateEditor() {
  const count = input.value.split("\n").length;
  lineNumbers.textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
  lineNumbers.scrollTop = input.scrollTop;
  const kb = new TextEncoder().encode(input.value).length / 1024;
  editorStats.textContent = input.value ? `${count} ${count === 1 ? "line" : "lines"} / ${kb.toFixed(1)} KB` : "No request loaded";
}

function formatInput(silent = false) {
  if (!input.value.trim()) return;
  try {
    input.value = formatJson(input.value);
    input.scrollTop = 0;
    refreshExtract();
  } catch {
    updateEditor();
    if (!silent) setMessage("Enter valid JSON before formatting. Your text has been kept.", "error");
  }
}

document.getElementById("format-json").addEventListener("click", () => formatInput());
document.getElementById("expand-editor").addEventListener("click", () => {
  const workbench = document.getElementById("request-workbench");
  const button = document.getElementById("expand-editor");
  const expanded = workbench.dataset.expanded !== "true";
  workbench.dataset.expanded = String(expanded);
  button.setAttribute("aria-expanded", String(expanded));
  button.textContent = expanded ? "Restore layout" : "Expand editor";
});
input.addEventListener("scroll", () => { lineNumbers.scrollTop = input.scrollTop; });
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!document.getElementById("ortb-submit").disabled) form.requestSubmit();
  }
});
input.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text/plain");
  if (!text) return;
  const next = input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd);
  try {
    const formatted = formatJson(next);
    event.preventDefault();
    input.value = formatted;
    input.setSelectionRange(0, 0);
    input.scrollTop = 0;
    refreshExtract();
  } catch { /* Keep the browser's native paste for incomplete or invalid JSON. */ }
});

async function loadFile(file) {
  if (input.disabled) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    setMessage(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`, "error");
    return;
  }
  const version = ++editVersion;
  try {
    const text = await file.text();
    if (version !== editVersion || input.disabled) return;
    input.value = text;
    refreshExtract();
    formatInput(true);
  } catch { if (version === editVersion) setMessage("Could not read this file. Try uploading it again.", "error"); }
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    return;
  }

  await loadFile(file);
  fileInput.value = "";
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
  await loadFile(file);
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
  editVersion += 1;
  updateEditor();
  const reduced = parseCurrent();
  document.getElementById("inspector-empty").hidden = Boolean(reduced && reduced !== "invalid");

  if (reduced === null) {
    overrideIdentity = null;
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

function sellerField(value, fallback) {
  return (typeof value === "string" && value) || typeof value === "number" ? value : fallback;
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

// Match the server's direct-field precedence and domain normalization for this preview.
function inventoryPartnerDomain(inventory, originDomain) {
  const text = (value) => {
    try { return value == null ? "" : String(value).trim(); }
    catch { return ""; }
  };
  const normalize = (value) => text(value).toLowerCase().replace(/\.+$/, "");
  const partner = normalize(text(inventory?.inventorypartnerdomain) || text(inventory?.ext?.inventorypartnerdomain));
  if (!partner || /[/?#@:\\\s]/.test(partner)) return null;
  return partner !== normalize(originDomain) ? partner : null;
}

// lib/ortb.js's resolveSiteDomain: a URL in site.domain is reduced to its host.
function siteDomainHost(value) {
  return typeof value === "string" && value.includes("/") ? hostOf(value) || value : value;
}

function renderExtractCard(reduced) {
  const site = reduced.site || {};
  const app = reduced.app || {};
  const dooh = reduced.dooh || {};
  const nodes = schainNodes(reduced);
  const kind = inventoryKind(reduced);
  const domain = kind === "app"
    ? app.domain
    : kind === "dooh"
      ? dooh.domain
      : site.domain || hostOf(site.page);
  // Show only the selected inventory's partner, which authorizes a second ads.txt lookup.
  const partner = kind === "dooh" ? null
    : inventoryPartnerDomain(reduced[kind], kind === "site" ? siteDomainHost(domain) : domain);
  // When the store URL names a store the server resolves on its own, a missing app.domain
  // is not something the user has to supply. This only shapes the prompt: the server
  // still decides, and a failed lookup restores the inspector (submit handler).
  const autoStore = kind === "app" && !domain ? autoResolvingStore(app.storeurl, app.bundle) : null;
  const file = kind === "app" ? "app-ads.txt" : "ads.txt";
  const inventoryLabel = kind === "app" ? "App" : kind === "dooh" ? "DOOH" : "Site";
  const identity = JSON.stringify([kind, domain ?? null,
    kind === "app" ? [app.bundle ?? null, app.storeurl ?? null] : kind === "site" ? site.page ?? null : null]);
  const override = identity === overrideIdentity ? getOverride() : "";
  overrideIdentity = identity;
  const store = kind === "app" ? autoResolvingStore(app.storeurl, app.bundle) : null;

  extractCard.hidden = false;
  extractCard.innerHTML = `
      <dl class="extract-card__rows">
        <dt>Inventory</dt><dd>${escapeHtml(inventoryLabel)}</dd>
        ${kind === "app"
          ? `<dt>App store</dt><dd>${escapeHtml(store || "Not identified")}</dd>
             <dt>Bundle</dt><dd>${escapeHtml(app.bundle || "—")}</dd>
             ${app.storeurl ? `<dt>Listing</dt><dd>${linkTo(app.storeurl, "Open store listing")}</dd>` : ""}`
          : `<dt>Domain</dt><dd>${escapeHtml(domain || "—")}</dd>`}
        ${partner ? `<dt>Inventory partner</dt><dd>${escapeHtml(partner)}</dd>` : ""}
        <dt>Supply chain</dt><dd>${nodes.length} node${nodes.length === 1 ? "" : "s"}</dd>
      </dl>
      ${autoStore ? `<p class="lookup-plan">Will check ${escapeHtml(autoStore)} for the developer domain.</p>` : domain ? `<p class="lookup-plan">Use ${escapeHtml(domain)} from the request. No store lookup needed.</p>` : `<p class="lookup-plan">A developer or publisher domain is needed.</p>`}
      ${nodes.length ? `<div class="declared-chain"><h3>Advertising systems declared in this request</h3><ol>${nodes.map((node) => `<li>${escapeHtml(sellerField(node?.asi, "Unknown"))}<span>${escapeHtml(sellerField(node?.sid, "No account ID"))}</span></li>`).join("")}</ol></div>` : ""}
      ${!domain ? originPrompt(kind, file, app.storeurl, autoStore) : ""}
  `;

  const overrideField = document.getElementById("ortb-origin-domain");
  const target = document.getElementById("ortb-resolved-target");
  if (overrideField && target) {
    overrideField.value = override;
    updateResolvedTarget(override, file, target);
    overrideField.addEventListener("input", () => {
      updateResolvedTarget(overrideField.value.trim(), file, target);
    });
  }
}

function updateResolvedTarget(domainValue, file, target) {
  target.textContent = `https://${domainValue || "<domain>"}/${file}`;
}

// Mirrors server store recognition for the prompt only; the server resolves the domain.
const AUTO_RESOLVING_STORES = [
  ["Apple App Store", ["apps.apple.com", "itunes.apple.com"]],
  ["Google Play", ["play.google.com"]],
  ["Roku Channel Store", ["channelstore.roku.com"]],
  ["LG Content Store", ["lgappstv.com"]],
  ["Samsung Apps", ["samsung.com"]],
  ["Vizio App Catalog", ["vizio.com"]],
  ["Amazon Appstore (Fire TV)", ["amazon.com"]]
];

function autoResolvingStore(storeurl, bundle) {
  if (!storeurl && typeof bundle === "string" && /^B[A-Z0-9]{9}$/i.test(bundle.trim())) {
    return "Amazon Appstore (Fire TV)";
  }
  let host;
  try {
    host = new URL(String(storeurl)).hostname.toLowerCase();
  } catch {
    return null;
  }
  const match = AUTO_RESOLVING_STORES.find(([, domains]) =>
    domains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
  return match ? match[0] : null;
}

function originPrompt(kind, file, storeurl, autoStore = null) {
  const isApp = kind === "app";
  const label = autoStore ? "Developer domain (optional)" : isApp ? "Developer domain" : "Publisher domain";
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
        ${autoStore
          ? `We will check ${escapeHtml(autoStore)} and use a verified mapping if available. Enter a domain to skip the store lookup. File to fetch:`
          : `Not in the bid request. ${escapeHtml(file)} ${escapeHtml(explanation)}. Enter the domain and we will fetch`}
        <code id="ortb-resolved-target">https://&lt;domain&gt;/${escapeHtml(file)}</code>.
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
  showMode("seller");
  document.getElementById("form-message").textContent = text;
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
  const request = startRequest(CLIENT_TIMEOUT_MS, "Audit");
  document.getElementById("report-title").scrollIntoView({ block: "start" });

  try {
    const response = await fetch("/api/audit-chain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bidRequest: reduced,
        ...(getOverride() ? { originDomainOverride: getOverride() } : {})
      }),
      signal: request.controller.signal
    });

    const payload = await response.json();
    if (!isCurrentRequest(request)) return;
    request.controller.signal.throwIfAborted();
    renderDiscovery(payload.discovery, payload.error);

    // A request with no schain has nothing to audit, so hand the user to the existing
    // two-field form rather than leaving them at a dead end. That form takes a full URL
    // and an account ID, which is exactly what this case needs.
    if (payload.reason === "no_schain") {
      goToAdsTxtForm(payload.error);
      return;
    }

    if (payload.reason === "origin_domain_required") {
      // Restore the inspector so the manual domain field is available after a failure.
      document.getElementById("request-workbench").dataset.expanded = "false";
      document.getElementById("expand-editor").setAttribute("aria-expanded", "false");
      document.getElementById("expand-editor").textContent = "Expand editor";
    }

    if (!response.ok) {
      setMessage(payload.error || "Audit failed.", "error");
      return;
    }

    renderChainResults(payload);
    setMessage("Audit complete.", "success");
  } catch (error) {
    if (isCurrentRequest(request)) {
      discoveryStatus.hidden = false;
      discoveryStatus.dataset.state = "failed";
      discoveryStatus.innerHTML = `<div><h3>Lookup not completed</h3><p>${escapeHtml(describeFailure(error, request))}</p></div><p>The server did not return a lookup outcome. No store or file result has been confirmed.</p>`;
      setMessage(describeFailure(error, request), request.reason === "cancelled" ? "neutral" : "error");
    }
  } finally {
    // Only the current request owns this shared surface, including error cleanup.
    if (finishRequest(request) && resultsPanel.hidden) {
      emptyState.hidden = !discoveryStatus.hidden;
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

  // Surface a known failure before explaining incomplete evidence. A skipped
  // chain-level check (truncation, timeout or missing completeness) prevents a pass.
  const firstFailedChainCheck = payload.chainChecks.find((check) => check.status === "fail");
  const firstIncompleteChainCheck = payload.chainChecks.find((check) => check.status === "skip");
  const banner = payload.verdict === "pass"
    ? "Chain verified end to end"
    : payload.firstFailedHop !== null
      ? `Chain broken at hop ${payload.firstFailedHop + 1} of ${payload.summary.hops}`
      : firstFailedChainCheck
        ? firstFailedChainCheck.message
        : firstIncompleteChainCheck?.message || "Chain could not be fully verified";

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
        <span>Hop ${hop.index + 1}: ${escapeHtml(hop.asi)} <small>Account ${escapeHtml(hop.sid)}</small></span>
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
      ${hop.seller || hop.adsTxtLine ? `<details class="chain-evidence"><summary>View source records</summary>${hop.seller ? `<pre class="chain-detail__raw">${escapeHtml(JSON.stringify(hop.seller, null, 2))}</pre>` : ""}${hop.adsTxtLine ? `<pre class="chain-detail__raw">${escapeHtml(hop.adsTxtLine)}</pre>` : ""}</details>` : ""}
    </article>
  `;
}

function renderDiscovery(discovery, error) {
  if (!discovery) return;
  const labels = { amazon: "Amazon Appstore (Fire TV)", apple: "Apple App Store", google: "Google Play", lg: "LG Content Store", roku: "Roku Channel Store", samsung: "Samsung Apps", vizio: "Vizio App Catalog" };
  const store = labels[discovery.store];
  const found = discovery.fileStatus === "fetched";
  const failedFile = discovery.fileStatus === "failed";
  const title = found ? `${discovery.file} found` : failedFile ? `${discovery.file} could not be fetched` : "Developer domain not resolved";
  const storeResult = store ? `${store} ${discovery.lookupAttempted ? "checked" : "not queried"}` : "No app-store lookup";
  const method = discovery.resolvedFrom === "known-map" ? "Used a verified app mapping."
    : discovery.resolvedFrom === "user" ? "Used your manual domain."
    : discovery.fallbackFrom ? `Store metadata named ${discovery.fallbackFrom}, which did not serve the file, so its parent domain was tried.`
    : ["store-listing", "itunes"].includes(discovery.resolvedFrom) ? "Developer domain found in store metadata."
    : discovery.domain ? "Used the domain supplied in the bid request."
    : discovery.lookupAttempted ? "The lookup did not provide a usable developer domain."
    : "Supply a developer or publisher domain to continue.";
  discoveryStatus.hidden = false;
  discoveryStatus.dataset.state = found ? "found" : "failed";
  discoveryStatus.innerHTML = `
    <div><h3>${escapeHtml(title)}</h3><p>${found ? error ? "Authorization file retrieved. The audit could not be completed." : "Authorization file retrieved. Seller-chain results are shown below." : failedFile ? "The domain resolved, but the authorization file was unavailable." : "No authorization file was fetched."}</p></div>
    <div><p class="discovery-title">${escapeHtml(storeResult)}</p><p>${escapeHtml(method)}${discovery.storeUrl && discovery.lookupAttempted ? ` ${linkTo(discovery.storeUrl, "View lookup source")}` : ""}</p>
      ${discovery.fileUrl ? `<span class="discovery-file">${linkTo(discovery.fileUrl, discovery.fileUrl)}</span>` : ""}</div>
    ${error ? `<p class="discovery-error">${escapeHtml(error)}</p>` : ""}`;
}
