const express = require("express");
const path = require("path");

const {
  compareDomains,
  normalizeHostname,
  normalizeSellerType,
  summarize,
  validateSellerType
} = require("./lib/validation");
const { parseAdsTxt, parseAdsTxtLine } = require("./lib/ads-txt");
const {
  buildAxiosOptions,
  createPinnedLookup,
  fetchText,
  fetchWithRedirects,
  isPrivateIp,
  shouldRetryWithAnotherAddress,
  validateExternalUrl
} = require("./lib/http-client");
const { fetchSellersJson, resolveSellersJsonTarget } = require("./lib/sellers-json");
const { extractBidRequest } = require("./lib/ortb");
const { resolveAppDomain } = require("./lib/app-domain");
const { auditChain } = require("./lib/chain-audit");

const app = express();
const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_LOOKUPS = Number(process.env.MAX_CONCURRENT_LOOKUPS || 6);

// No CORS middleware: the frontend is served from this same origin, so allowing
// other origins would only let arbitrary pages drive this server's outbound fetches.
// The JSON body parser is scoped per-route rather than mounted globally: /api/validate
// and /api/audit-chain have different size limits, and a global parser running first
// would enforce whichever limit it was given on every request regardless of route.
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/validate", express.json({ limit: "100kb" }), async (req, res) => {
  const adsTxtUrl = typeof req.body?.adsTxtUrl === "string" ? req.body.adsTxtUrl.trim() : "";
  const accountId = typeof req.body?.accountId === "string" ? req.body.accountId.trim() : "";

  if (!adsTxtUrl || !accountId) {
    return res.status(400).json({
      error: "Both ads.txt URL and account ID are required."
    });
  }

  // Cancelling, timing out, or navigating away closes the connection. Nothing
  // can read the result after that, so stop doing the work. This has to hang off
  // the response: req emits "close" as soon as its body finishes streaming, which
  // is every request, not just the abandoned ones.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const adsTarget = await validateExternalUrl(adsTxtUrl);
    const publisherDomain = adsTarget.hostname;
    const adsTxtRaw = await fetchText(adsTarget, controller.signal);
    const adsEntries = parseAdsTxt(adsTxtRaw);
    const matchingEntries = adsEntries.filter((entry) => entry.accountId === accountId);

    const records = await mapWithConcurrency(
      matchingEntries,
      MAX_CONCURRENT_LOOKUPS,
      (entry) => validateEntry(entry, publisherDomain),
      controller.signal
    );

    if (controller.signal.aborted) {
      return;
    }

    const summary = summarize(records);

    return res.json({
      adsTxtUrl: adsTarget.url.toString(),
      publisherDomain,
      accountId,
      adsTxtEntryCount: adsEntries.length,
      matchedEntryCount: matchingEntries.length,
      summary,
      records
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }

    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      error: error.message || "Validation failed."
    });
  }
});

// The reduced bid request is small — the browser strips device, user, regs and imp
// before sending — but site.content metadata can still be chunky. This limit is
// route-local so the existing /api/validate limit does not move.
app.post("/api/audit-chain", express.json({ limit: "512kb" }), async (req, res) => {
  const bidRequest = req.body?.bidRequest;
  const override = typeof req.body?.originDomainOverride === "string"
    ? req.body.originDomainOverride.trim()
    : "";

  if (!bidRequest || typeof bidRequest !== "object") {
    return res.status(400).json({ error: "A bid request object is required." });
  }

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const normalized = extractBidRequest(bidRequest);

    if (!normalized.nodes.length) {
      return res.status(422).json({
        reason: "no_schain",
        error: "This bid request declares no supply chain, so there is nothing to audit. Enter an ads.txt URL and account ID instead.",
        origin: normalized.origin
      });
    }

    const resolved = override
      ? { domain: override, resolvedFrom: "user" }
      : await resolveAppDomain(normalized.origin, {});

    if (!resolved.domain) {
      return res.status(422).json({
        reason: "origin_domain_required",
        error: `Could not determine where ${normalized.origin.file} lives for this request.`,
        origin: normalized.origin
      });
    }

    const origin = { ...normalized.origin, ...resolved };
    const adsTarget = await validateExternalUrl(`https://${origin.domain}/${origin.file}`);
    const adsEntries = parseAdsTxt(await fetchText(adsTarget, controller.signal));

    const result = await auditChain(
      { ...normalized, origin },
      {
        adsEntries,
        loadSellers: fetchSellersJson,
        originDomain: adsTarget.hostname
      }
    );

    if (controller.signal.aborted) {
      return;
    }

    return res.json({ origin, warnings: normalized.warnings, ...result });
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }

    return res.status(error.statusCode || 500).json({
      error: error.message || "Audit failed."
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Ads.txt validator running at http://${HOST}:${PORT}`);
  });
}

async function mapWithConcurrency(items, limit, mapper, signal = null) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    // Stop handing out work once the caller has gone away. Lookups already in
    // flight are left to settle; the queued remainder is what there is to save.
    while (cursor < items.length && !signal?.aborted) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

async function validateEntry(entry, publisherDomain) {
  const sellersTarget = resolveSellersJsonTarget(entry.adSystemDomain);
  const sellerJsonUrl = sellersTarget.sellerJsonUrl;

  try {
    const sellersPayload = await fetchSellersJson(sellerJsonUrl);
    const seller = sellersPayload.sellers.find(
      (candidate) => candidate && String(candidate.seller_id || "").trim() === entry.accountId
    );

    if (!seller) {
      return buildBaseRecord(entry, publisherDomain, sellerJsonUrl, {
        status: "not_found",
        statusLabel: "Not Found",
        message: "Seller ID was not found in sellers.json."
      });
    }

    const sellerType = normalizeSellerType(seller.seller_type);
    const validation = validateSellerType(entry.relationship, sellerType);
    const sellerDomain = seller.domain ? normalizeHostname(seller.domain) : null;
    const domainCheck = compareDomains(publisherDomain, sellerDomain);
    const confidential = String(seller.is_confidential || "0") === "1";

    return buildBaseRecord(entry, publisherDomain, sellerJsonUrl, {
      sellerJsonStrategy: sellersTarget.strategy,
      sellerJsonOverrideReason: sellersTarget.reason,
      status: validation.status,
      statusLabel: validation.statusLabel,
      message: validation.message,
      seller: {
        sellerId: String(seller.seller_id || ""),
        name: seller.name || "Unknown seller",
        sellerType,
        domain: sellerDomain,
        isConfidential: confidential,
        comment: seller.comment || null
      },
      domainCheck,
      confidential
    });
  } catch (error) {
    return buildBaseRecord(entry, publisherDomain, sellerJsonUrl, {
      sellerJsonStrategy: sellersTarget.strategy,
      sellerJsonOverrideReason: sellersTarget.reason,
      status: "unreachable",
      statusLabel: "Unreachable",
      message: error.message || "Unable to fetch sellers.json."
    });
  }
}

function buildBaseRecord(entry, publisherDomain, sellerJsonUrl, overrides) {
  return {
    adSystemDomain: normalizeHostname(entry.adSystemDomain),
    sellerJsonUrl,
    sellerJsonStrategy: "standard",
    sellerJsonOverrideReason: null,
    accountId: entry.accountId,
    relationship: entry.relationship,
    certificationAuthorityId: entry.certificationAuthorityId,
    publisherDomain,
    lineNumber: entry.lineNumber,
    raw: entry.raw,
    seller: null,
    domainCheck: {
      status: "unknown",
      message: "No seller domain provided in sellers.json."
    },
    confidential: false,
    ...overrides
  };
}

module.exports = {
  app,
  buildAxiosOptions,
  compareDomains,
  createPinnedLookup,
  fetchSellersJson,
  fetchWithRedirects,
  isPrivateIp,
  mapWithConcurrency,
  parseAdsTxt,
  shouldRetryWithAnotherAddress,
  validateExternalUrl
};
