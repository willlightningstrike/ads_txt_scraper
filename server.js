const express = require("express");
const path = require("path");

const {
  compareDomains,
  normalizeHostname,
  normalizeSellerType,
  summarize,
  validateSellerType
} = require("./lib/validation");
const { parseAdsTxt, parseAdsTxtVariables } = require("./lib/ads-txt");
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
const { resolveAppDomain, storeOf } = require("./lib/app-domain");
const { auditChain } = require("./lib/chain-audit");
const { awaitWithSignal } = require("./lib/abort");

const app = express();
const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_LOOKUPS = positiveIntegerSetting("MAX_CONCURRENT_LOOKUPS", 6);
// One deadline covers resolution, authorization files, and the entire chain walk.
const AUDIT_BUDGET_MS = positiveIntegerSetting("AUDIT_BUDGET_MS", 120_000);

// "0" or "abc" would otherwise survive `|| default` and start zero lookup workers, which
// returns empty records, so a bad value stops the server instead.
function positiveIntegerSetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

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
  const budget = new AbortController();
  const deadline = setTimeout(() => budget.abort(new Error("Audit time budget exceeded.")), AUDIT_BUDGET_MS);
  const signal = AbortSignal.any([controller.signal, budget.signal]);
  let discovery = null;
  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const normalized = extractBidRequest(bidRequest);
    discovery = {
      store: normalized.origin.kind === "app" ? storeOf(normalized.origin.storeurl) : null,
      storeUrl: normalized.origin.storeurl,
      lookupAttempted: false,
      domain: null,
      resolvedFrom: null,
      file: normalized.origin.file,
      fileUrl: null,
      fileStatus: "not_requested"
    };

    if (!normalized.nodes.length) {
      return res.status(422).json({
        reason: "no_schain",
        discovery,
        error: "This bid request declares no supply chain, so there is nothing to audit. Enter an ads.txt URL and account ID instead.",
        origin: normalized.origin
      });
    }

    const resolved = override
      ? { domain: override, resolvedFrom: "user" }
      : await awaitWithSignal(resolveAppDomain(normalized.origin, {
        signal,
        onStoreLookup: ({ store, url }) => {
          discovery.store = store;
          discovery.storeUrl = storeOf(normalized.origin.storeurl) === store ? normalized.origin.storeurl : url;
          discovery.lookupAttempted = true;
        }
      }), signal);
    discovery.domain = resolved.domain;
    discovery.resolvedFrom = resolved.resolvedFrom;

    if (!resolved.domain) {
      return res.status(422).json({
        reason: "origin_domain_required",
        discovery,
        error: resolved.resolutionError?.message || `Could not determine where ${normalized.origin.file} lives for this request.`,
        ...(resolved.resolutionError ? { resolutionError: resolved.resolutionError } : {}),
        origin: normalized.origin
      });
    }

    const origin = { ...normalized.origin, ...resolved };
    discovery.fileStatus = "fetching";
    let adsTarget = await awaitWithSignal(validateExternalUrl(`https://${origin.domain}/${origin.file}`), signal);
    const originChecks = [];
    discovery.domain = adsTarget.hostname;
    discovery.fileUrl = adsTarget.url.toString();
    let ownerText;
    try {
      ownerText = await awaitWithSignal(fetchText(adsTarget, signal), signal);
    } catch (error) {
      const parent = signal.aborted ? null : storeListingParent(origin.resolvedFrom, adsTarget.hostname, error);
      if (!parent) {
        throw error;
      }
      const listed = adsTarget.hostname;
      discovery.fallbackFrom = listed;
      try {
        adsTarget = await awaitWithSignal(validateExternalUrl(`https://${parent}/${origin.file}`), signal);
        discovery.domain = adsTarget.hostname;
        discovery.fileUrl = adsTarget.url.toString();
        ownerText = await awaitWithSignal(fetchText(adsTarget, signal), signal);
      } catch (parentError) {
        if (signal.aborted) {
          throw parentError;
        }
        throw Object.assign(new Error(`${error.message} Its parent domain was tried too: ${parentError.message}`), {
          statusCode: parentError.statusCode || error.statusCode
        });
      }
      originChecks.push({
        code: "origin_parent_domain_fallback",
        status: "warn",
        message: `The store listing names ${listed}, whose ${origin.file} returned HTTP ${error.remoteStatus}. ${adsTarget.hostname}/${origin.file} was used instead.`
      });
    }
    discovery.fileStatus = "fetched";
    // origin.domain may still carry a raw user-supplied override (e.g. one with a stray
    // path segment); adsTarget.hostname is what was actually validated and fetched, so
    // the reported origin must match the file that was actually read, not the raw input.
    origin.domain = adsTarget.hostname;
    // extractBidRequest can only drop a self-named partner when the request declares the
    // domain; one resolved from a store or override is only known here.
    if (origin.inventoryPartnerDomain === adsTarget.hostname) {
      origin.inventoryPartnerDomain = null;
    }
    const ownerFile = `${adsTarget.hostname}/${origin.file}`;
    const ownerVariables = parseAdsTxtVariables(ownerText);
    const ownerDomain = normalizeHostname(ownerVariables.ownerdomain?.[0]) || adsTarget.hostname;
    const adsEntries = tagAdsEntries(parseAdsTxt(ownerText), ownerFile, ownerDomain);
    const partnerChecks = [];
    let partnerSource = null;

    // OpenRTB 2.6 inventory sharing: the partner's file is where the schain's sellers are
    // expected to be declared, and the owner's file must carry an INVENTORYPARTNERDOMAIN=
    // line authorizing the arrangement — without it, the bid request is asserting a
    // partnership the owner never agreed to. The schain is then checked against the
    // UNION of both files' entries, so a seller declared by either file passes.
    if (origin.inventoryPartnerDomain) {
      const partner = origin.inventoryPartnerDomain;
      const declared = (ownerVariables.inventorypartnerdomain || [])
        .map((value) => normalizeHostname(value))
        .includes(partner);

      if (!declared) {
        partnerChecks.push({
          code: "inventory_partner_undeclared",
          status: "fail",
          message: `The bid request names ${partner} as an inventory partner, but ${ownerFile} has no INVENTORYPARTNERDOMAIN=${partner} line authorizing that arrangement.`
        });
      }

      try {
        const partnerTarget = await awaitWithSignal(validateExternalUrl(`https://${partner}/ads.txt`), signal);
        const partnerFile = `${partnerTarget.hostname}/ads.txt`;
        const partnerText = await awaitWithSignal(fetchText(partnerTarget, signal), signal);
        const partnerOwner = normalizeHostname(parseAdsTxtVariables(partnerText).ownerdomain?.[0]) || partnerTarget.hostname;
        adsEntries.push(...tagAdsEntries(parseAdsTxt(partnerText), partnerFile, partnerOwner));
        partnerSource = { kind: "ads-txt", label: partnerFile, url: `https://${partnerFile}` };
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        // The declaration check above is the security control; a partner file that
        // cannot be read only narrows what can be verified, so it is a warning.
        partnerChecks.push({
          code: "inventory_partner_unreachable",
          status: "warn",
          message: `The inventory partner file https://${partner}/ads.txt could not be fetched (${error.message}). The supply chain was checked against ${ownerFile} only.`
        });
      }
    }

    const result = await auditChain(
      { ...normalized, origin },
      {
        adsEntries,
        loadSellers: fetchSellersJson,
        originDomain: adsTarget.hostname,
        chainChecks: [...originChecks, ...partnerChecks],
        signal
      }
    );

    if (controller.signal.aborted) {
      return;
    }

    if (partnerSource) {
      // Keep both ads.txt files together at the head of the sources bar.
      result.sources.splice(1, 0, partnerSource);
    }

    if (budget.signal.aborted) {
      // A timed-out final hop can be present in the result but not fully checked.
      // Incomplete evidence must not erase a failure established before the timeout.
      if (result.verdict !== "broken") result.verdict = "unverifiable";
      result.chainChecks.push({
        code: "audit_budget_exceeded",
        status: "skip",
        message: `The audit exceeded its time budget after reaching ${result.summary.hops} of ${normalized.nodes.length} hops. Pending and remaining checks were not completed.`
      });
    }

    return res.json({ origin, discovery, warnings: normalized.warnings, ...result });
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }

    if (discovery?.fileStatus === "fetching") discovery.fileStatus = "failed";
    if (budget.signal.aborted) {
      return res.status(504).json({ reason: "audit_budget_exceeded", discovery, error: "The audit exceeded its time budget while resolving the origin or fetching authorization files." });
    }

    return res.status(error.statusCode || 500).json({
      discovery,
      error: error.message || "Audit failed."
    });
  } finally {
    clearTimeout(deadline);
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Express's default error handler serves an HTML page with a full stack trace (visible
// node_modules paths included) — for example on the 413 express.json() throws for an
// oversized body. The frontend calls response.json() on error responses, so an HTML body
// would throw there too. Keep every error path, handled or not, on a plain JSON contract.
app.use((err, _req, res, _next) => {
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({ error: err.message || "Request failed." });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Ads.txt validator running at http://${HOST}:${PORT}`);
  });
}

// Store listings sometimes name a product subdomain whose host refuses app-ads.txt while
// the developer publishes it one level up (DirecTV's Samsung listing names
// streamtv.directv.com; the file is at directv.com). Only store metadata is second-guessed
// this way, never a domain the request declared or the user typed, and only one level:
// telling a company's parent from a public suffix (co.uk, github.io) needs the Public
// Suffix List, which is why the fallback is reported as a warning rather than silently.
function storeListingParent(resolvedFrom, hostname, error) {
  if (resolvedFrom !== "store-listing" || ![403, 404].includes(error.remoteStatus)) {
    return null;
  }
  const labels = hostname.split(".");
  return labels.length > 2 && !/^\d+$/.test(labels.at(-1)) ? labels.slice(1).join(".") : null;
}

// Entries from two ads.txt files are audited together; the tag lets a hop say which
// file declared it, since line numbers alone collide across files.
function tagAdsEntries(entries, sourceFile, ownerDomain) {
  return entries.map((entry) => ({ ...entry, sourceFile, ownerDomain }));
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
        name: typeof seller.name === "string" && seller.name.trim() ? seller.name.trim() : "Unknown seller",
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
