const form = document.getElementById("validator-form");
const adsTxtUrlInput = document.getElementById("adsTxtUrl");
const accountIdInput = document.getElementById("accountId");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const copyJsonButton = document.getElementById("copy-json-button");
const formMessage = document.getElementById("form-message");
const loadingState = document.getElementById("loading-state");
const emptyState = document.getElementById("empty-state");
const results = document.getElementById("results");
const summaryGrid = document.getElementById("summary-grid");
const resultsMeta = document.getElementById("results-meta");
const recordsList = document.getElementById("records-list");

// The server caps each outbound fetch at REQUEST_TIMEOUT_MS (20s by default) and
// runs the ads.txt fetch before the sellers.json fetches, so a legitimate request
// tops out near 40s. This is a backstop for what the server cannot bound: a lost
// connection, a crashed process, or a machine that slept mid-request.
const CLIENT_TIMEOUT_MS = 60_000;

let latestPayload = null;
let inFlight = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const adsTxtUrl = adsTxtUrlInput.value.trim();
  const accountId = accountIdInput.value.trim();

  if (!adsTxtUrl || !accountId) {
    setFormMessage("Enter both the ads.txt URL and the account ID.", "error");
    return;
  }

  if (!isSecureUrl(adsTxtUrl)) {
    setFormMessage("Use a full HTTPS URL for ads.txt.", "error");
    return;
  }

  abortInFlight("superseded");
  const request = startRequest();

  setLoading(true);
  setFormMessage("");

  try {
    const response = await fetch("/api/validate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ adsTxtUrl, accountId }),
      signal: request.controller.signal
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Validation failed.");
    }

    latestPayload = payload;
    renderResults(payload);
    copyJsonButton.hidden = false;
    setFormMessage("Validation completed.", "success");
  } catch (error) {
    // A superseded request lost ownership of the UI to a newer submission, so
    // it must not overwrite that request's results or error message.
    if (request.reason !== "superseded") {
      latestPayload = null;
      copyJsonButton.hidden = true;
      showEmptyState();
      setFormMessage(describeFailure(error, request), request.reason === "cancelled" ? "neutral" : "error");
    }
  } finally {
    finishRequest(request);
  }
});

cancelButton.addEventListener("click", () => {
  abortInFlight("cancelled");
});

copyJsonButton.addEventListener("click", async () => {
  if (!latestPayload) {
    return;
  }

  try {
    await navigator.clipboard.writeText(JSON.stringify(latestPayload, null, 2));
    setFormMessage("Copied the latest results as JSON.", "success");
  } catch {
    setFormMessage("Clipboard access was unavailable in this browser.", "error");
  }
});

function renderResults(payload) {
  emptyState.hidden = true;
  results.hidden = false;
  summaryGrid.innerHTML = "";
  recordsList.innerHTML = "";

  const metrics = [
    ["Matches", payload.summary.total],
    ["Valid", payload.summary.valid],
    ["Mismatch", payload.summary.mismatch],
    ["Not Found", payload.summary.not_found],
    ["Unreachable", payload.summary.unreachable],
    ["Confidential", payload.summary.confidential],
    ["Domain Match", payload.summary.domainMatches],
    ["Domain Related", payload.summary.domainRelated],
    ["Domain Mismatch", payload.summary.domainMismatches]
  ];

  metrics.forEach(([label, value]) => {
    const card = document.createElement("article");
    card.className = "summary-card";
    card.innerHTML = `
      <p class="summary-card__label">${escapeHtml(label)}</p>
      <p class="summary-card__value">${escapeHtml(String(value))}</p>
    `;
    summaryGrid.appendChild(card);
  });

  resultsMeta.innerHTML = `
    <p>
      Publisher domain: <strong>${escapeHtml(payload.publisherDomain)}</strong><br />
      Parsed <strong>${escapeHtml(String(payload.adsTxtEntryCount))}</strong> ads.txt entries and found
      <strong>${escapeHtml(String(payload.matchedEntryCount))}</strong> entries for seller ID
      <strong>${escapeHtml(payload.accountId)}</strong>.
    </p>
  `;

  if (!payload.records.length) {
    const emptyCard = document.createElement("article");
    emptyCard.className = "record-card";
    emptyCard.innerHTML = `
      <h3>No matching ads.txt entries</h3>
      <p class="record-card__subtitle">
        The seller ID was not present in the fetched ads.txt file, so no sellers.json lookups were needed.
      </p>
    `;
    recordsList.appendChild(emptyCard);
    return;
  }

  payload.records.forEach((record, index) => {
    const card = document.createElement("article");
    card.className = "record-card";
    // Cap the stagger. Growing it per card left the tail of a large result set
    // invisible for minutes, which read as a truncated report.
    card.style.animationDelay = `${Math.min(index, 12) * 55}ms`;

    const sellerName = record.seller?.name || "Seller not present";
    const sellerType = record.seller?.sellerType || "Unavailable";
    const sellerDomainValue = record.seller?.domain || "Not listed";
    const endpointLabel = record.sellerJsonStrategy === "override" ? "Override endpoint" : "Standard endpoint";
    const domainTone =
      record.domainCheck?.status === "match"
        ? "detail__value--ok"
        : record.domainCheck?.status === "related"
          ? "detail__value--info"
          : record.domainCheck?.status === "mismatch"
            ? "detail__value--warn"
            : "detail__value--muted";

    card.innerHTML = `
      <div class="record-card__top">
        <div>
          <h3>${escapeHtml(record.adSystemDomain)}</h3>
          <p class="record-card__subtitle">ads.txt line ${escapeHtml(String(record.lineNumber))}</p>
          ${
            record.raw
              ? `<code class="record-card__raw">${escapeHtml(record.raw)}</code>`
              : ""
          }
        </div>
        <div class="badge badge--${escapeHtml(toBadgeClass(record.status))}">
          ${escapeHtml(record.statusLabel)}
        </div>
      </div>

      <div class="pill-row">
        <span class="pill">Account ID: ${escapeHtml(record.accountId)}</span>
        <span class="pill">Relationship: ${escapeHtml(record.relationship)}</span>
        <span class="pill">${escapeHtml(endpointLabel)}</span>
        ${
          record.confidential
            ? '<span class="pill">Confidential seller</span>'
            : ""
        }
      </div>

      <div class="record-grid">
        <div class="detail">
          <span class="detail__label">Validation</span>
          <div class="detail__value">${escapeHtml(record.message)}</div>
        </div>
        <div class="detail">
          <span class="detail__label">Seller</span>
          <div class="detail__value">
            ${escapeHtml(sellerName)}<br />
            ${escapeHtml(sellerType)}
          </div>
        </div>
        <div class="detail">
          <span class="detail__label">Domain Check</span>
          <div class="detail__value ${domainTone}">
            ${escapeHtml(record.domainCheck?.message || "No seller domain provided.")}
          </div>
        </div>
        <div class="detail">
          <span class="detail__label">Endpoints</span>
          <div class="detail__value">
            Seller domain: ${escapeHtml(sellerDomainValue)}<br />
            ${
              record.sellerJsonOverrideReason
                ? `${escapeHtml(record.sellerJsonOverrideReason)}<br />`
                : ""
            }
            <a href="${escapeAttribute(record.sellerJsonUrl)}" target="_blank" rel="noreferrer">Open sellers.json</a>
          </div>
        </div>
      </div>
    `;

    recordsList.appendChild(card);
  });
}

function showEmptyState() {
  results.hidden = true;
  emptyState.hidden = false;
  summaryGrid.innerHTML = "";
  resultsMeta.innerHTML = "";
  recordsList.innerHTML = "";
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  cancelButton.hidden = !isLoading;
  loadingState.hidden = !isLoading;

  if (isLoading) {
    results.hidden = true;
    emptyState.hidden = true;
  }
}

function startRequest() {
  const request = { controller: new AbortController(), reason: null };

  request.deadline = setTimeout(() => {
    request.reason = "timeout";
    request.controller.abort();
  }, CLIENT_TIMEOUT_MS);

  inFlight = request;
  return request;
}

function abortInFlight(reason) {
  if (!inFlight) {
    return;
  }

  inFlight.reason = reason;
  inFlight.controller.abort();
}

function finishRequest(request) {
  clearTimeout(request.deadline);

  // Only the request that still owns the UI clears the loading state; a
  // superseded one would otherwise stop the spinner for its replacement.
  if (inFlight === request) {
    inFlight = null;
    setLoading(false);
  }
}

function describeFailure(error, request) {
  if (request.reason === "cancelled") {
    return "Validation cancelled.";
  }

  if (request.reason === "timeout") {
    return `No response after ${Math.round(CLIENT_TIMEOUT_MS / 1000)} seconds. The server may be unreachable.`;
  }

  return error.message || "Something went wrong during validation.";
}

function setFormMessage(message, tone = "neutral") {
  formMessage.textContent = message;

  if (tone === "error") {
    formMessage.dataset.tone = "error";
  } else {
    formMessage.dataset.tone = "";
  }
}

function isSecureUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function toBadgeClass(status) {
  switch (status) {
    case "not_found":
      return "not-found";
    default:
      return status;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
