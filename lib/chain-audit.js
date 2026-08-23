const { resolveSellersJsonTarget } = require("./sellers-json");
const { compareDomains, normalizeSellerType, validateSellerType } = require("./validation");

const PASS = "pass";
const FAIL = "fail";
const SKIP = "skip";
const WARN = "warn";

// sellers.json fields are third-party JSON and may carry values whose String()
// coercion throws (e.g. { toString: 1 }, where toString is not callable). This mirrors
// lib/ortb.js's stringOrNull so bid-request and sellers.json data get the same
// crash-safe treatment before they reach any comparison or the renderer.
function stringOrNull(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() || null;
  }
  try {
    return String(value).trim() || null;
  } catch {
    return null;
  }
}

async function auditChain(normalized, { adsEntries, loadSellers, originDomain }) {
  const hops = [];

  for (let index = 0; index < normalized.nodes.length; index += 1) {
    // Sequential rather than concurrent: the chain link check reads the previous hop's
    // resolved seller, so hop N cannot be evaluated until hop N-1 has one. The shared
    // sellers.json cache and in-flight dedupe keep the cost down when hops repeat an
    // endpoint, which is the common case.
    hops.push(await auditHop({
      node: normalized.nodes[index],
      index,
      previous: hops[index - 1] || null,
      adsEntries,
      loadSellers,
      originDomain
    }));
  }

  const chainChecks = buildChainChecks(normalized, hops);
  const summary = summarizeHops(hops);
  const firstFailedHop = hops.findIndex((hop) => hop.verdict === "broken");

  return {
    verdict: chainVerdict(hops, chainChecks),
    firstFailedHop: firstFailedHop === -1 ? null : firstFailedHop,
    summary,
    hops,
    chainChecks,
    sources: buildSources(normalized, originDomain, hops)
  };
}

async function auditHop({ node, index, previous, adsEntries, loadSellers, originDomain }) {
  const target = resolveSellersJsonTarget(node.asi);
  const hop = {
    index,
    asi: node.asi,
    sid: node.sid,
    name: node.name,
    sellerJsonUrl: target.sellerJsonUrl,
    seller: null,
    adsTxtLine: null,
    checks: {
      sellersJsonReachable: { status: SKIP, message: "" },
      sellerIdPresent: { status: SKIP, message: "" },
      sellerTypeValid: { status: SKIP, message: "" },
      chainLink: { status: SKIP, message: "" },
      adsTxtDeclared: { status: SKIP, message: "" },
      sellerDomainAlignment: { status: SKIP, message: "" }
    },
    verdict: "unverifiable"
  };

  applyAdsTxtCheck(hop, node, adsEntries);

  let payload;
  try {
    payload = await loadSellers(target.sellerJsonUrl);
    hop.checks.sellersJsonReachable = { status: PASS, message: `Fetched ${target.sellerJsonUrl}.` };
  } catch (error) {
    hop.checks.sellersJsonReachable = {
      status: FAIL,
      message: error.message || "Unable to fetch sellers.json."
    };
    hop.verdict = "unverifiable";
    return hop;
  }

  const seller = (payload.sellers || []).find(
    (candidate) => candidate && stringOrNull(candidate.seller_id) === node.sid
  );

  if (!seller) {
    hop.checks.sellerIdPresent = {
      status: FAIL,
      message: `Seller ID ${node.sid} was not found in ${target.sellerJsonUrl}.`
    };
    hop.verdict = "broken";
    return hop;
  }

  const sellerType = normalizeSellerType(stringOrNull(seller.seller_type));
  const isConfidential = stringOrNull(seller.is_confidential) === "1";
  const sellerDomain = stringOrNull(seller.domain);

  hop.seller = {
    sellerId: stringOrNull(seller.seller_id) || "",
    name: stringOrNull(seller.name) || "Unknown seller",
    sellerType,
    domain: sellerDomain ? sellerDomain.toLowerCase() : null,
    isConfidential
  };
  hop.checks.sellerIdPresent = { status: PASS, message: `Seller ID ${node.sid} found.` };

  // Hop 0 is the publisher's own relationship, so it expects the DIRECT side of the
  // mapping. Every later hop is an intermediary reselling upstream.
  const expected = index === 0 ? "DIRECT" : "RESELLER";
  const typeResult = validateSellerType(expected, sellerType);
  hop.checks.sellerTypeValid = {
    status: typeResult.status === "valid" ? PASS : FAIL,
    message: typeResult.message
  };

  applyChainLinkCheck(hop, previous, index, isConfidential);
  applyDomainAlignmentCheck(hop, index, originDomain, isConfidential);

  const hasFailingCheck = Object.values(hop.checks).some((check) => check.status === FAIL);

  // is_confidential redacts seller.name and seller.domain only; seller_id and
  // seller_type are still required and published (IAB sellers.json spec), so
  // sellerIdPresent/sellerTypeValid/adsTxtDeclared remain fully authoritative and can
  // still fail a confidential hop. chainLink and sellerDomainAlignment depend on the
  // redacted domain, so they were set to a non-failing status above and can never be
  // the reason hasFailingCheck is true. Only when nothing authoritative failed is the
  // hop genuinely not knowable.
  if (isConfidential) {
    hop.verdict = hasFailingCheck ? "broken" : "unverifiable";
    return hop;
  }

  hop.verdict = hasFailingCheck ? "broken" : "pass";
  return hop;
}

function applyAdsTxtCheck(hop, node, adsEntries) {
  const match = adsEntries.find(
    (entry) => entry.adSystemDomain === node.asi && entry.accountId === node.sid
  );

  if (match) {
    hop.adsTxtLine = match.raw;
    hop.checks.adsTxtDeclared = {
      status: PASS,
      message: `Declared on line ${match.lineNumber} as ${match.relationship}.`
    };
    return;
  }

  hop.checks.adsTxtDeclared = {
    status: FAIL,
    message: `No ads.txt line declares ${node.asi} with account ${node.sid}.`
  };
}

function applyChainLinkCheck(hop, previous, index, isConfidential) {
  if (index === 0) {
    hop.checks.chainLink = { status: SKIP, message: "First hop has no upstream node to link to." };
    return;
  }

  const expectedDomain = previous ? previous.asi : null;

  // is_confidential redacts seller.domain, so there is nothing here to compare — this
  // is genuinely not knowable, not a failure. FAIL stays reserved for a seller that
  // published a domain and it didn't match.
  if (isConfidential) {
    hop.checks.chainLink = {
      status: SKIP,
      message: `Seller record is confidential, so its domain could not be checked against the previous hop ${expectedDomain}.`
    };
    return;
  }

  const sellerDomain = hop.seller ? hop.seller.domain : null;

  if (!sellerDomain) {
    hop.checks.chainLink = {
      status: FAIL,
      message: `Seller record has no domain, so the link to ${expectedDomain} cannot be established.`
    };
    return;
  }

  const comparison = compareDomains(expectedDomain, sellerDomain);
  hop.checks.chainLink = {
    status: comparison.status === "match" ? PASS : FAIL,
    message: comparison.status === "match"
      ? `Seller domain ${sellerDomain} links back to ${expectedDomain}.`
      : `Seller domain ${sellerDomain} does not link back to the previous hop ${expectedDomain}.`
  };
}

function applyDomainAlignmentCheck(hop, index, originDomain, isConfidential) {
  if (index !== 0) {
    hop.checks.sellerDomainAlignment = { status: SKIP, message: "Only checked on the first hop." };
    return;
  }

  // Same redaction as chainLink above: a confidential hop 0 has no published domain to
  // compare against the publisher's own domain.
  if (isConfidential) {
    hop.checks.sellerDomainAlignment = {
      status: SKIP,
      message: `Seller record is confidential, so its domain could not be checked against publisher domain ${originDomain}.`
    };
    return;
  }

  const comparison = compareDomains(originDomain, hop.seller ? hop.seller.domain : null);
  hop.checks.sellerDomainAlignment = {
    status: comparison.status === "match" || comparison.status === "related" ? PASS : FAIL,
    message: comparison.message
  };
}

function buildChainChecks(normalized, hops) {
  const checks = [];
  const firstHop = hops[0];

  if (normalized.complete === 1 && firstHop && firstHop.checks.adsTxtDeclared.status === FAIL) {
    checks.push({
      code: "complete_flag_contradicted",
      status: FAIL,
      message: "The chain asserts complete: 1, but its first hop is not declared in the publisher's ads.txt."
    });
  }

  // Normalizer-sourced warnings (e.g. site.domain vs site.page host, app.bundle vs
  // storeurl) describe a metadata discrepancy, not a chain failure — routine cases like
  // www-vs-apex or an AMP page trigger these on an otherwise perfect chain. They are
  // surfaced here so the renderer can show them, but "warn" (not FAIL) keeps them from
  // ever flipping the chain verdict to "broken" on their own.
  for (const warning of normalized.warnings || []) {
    checks.push({ code: warning.code, status: WARN, message: warning.message });
  }

  return checks;
}

function summarizeHops(hops) {
  return hops.reduce(
    (summary, hop) => {
      summary.hops += 1;
      summary[hop.verdict] += 1;
      if (hop.checks.adsTxtDeclared.status === FAIL) {
        summary.undeclared += 1;
      }
      return summary;
    },
    { hops: 0, pass: 0, broken: 0, unverifiable: 0, undeclared: 0 }
  );
}

function chainVerdict(hops, chainChecks) {
  if (!hops.length) {
    return "unverifiable";
  }
  if (hops.some((hop) => hop.verdict === "broken") || chainChecks.some((c) => c.status === FAIL)) {
    return "broken";
  }
  if (hops.some((hop) => hop.verdict === "unverifiable")) {
    return "unverifiable";
  }
  return "pass";
}

function buildSources(normalized, originDomain, hops) {
  const sources = [{
    kind: "ads-txt",
    label: `${originDomain}/${normalized.origin.file}`,
    url: `https://${originDomain}/${normalized.origin.file}`
  }];

  for (const hop of hops) {
    if (!sources.some((source) => source.url === hop.sellerJsonUrl)) {
      // Derive the label from the resolved URL itself, not hop.asi — an override (e.g.
      // Google's GCS endpoint) means the file actually opened can differ from the ad
      // system's own domain, and the label must describe what a click-through opens.
      sources.push({
        kind: "sellers-json",
        label: hop.sellerJsonUrl.replace(/^https:\/\//, ""),
        url: hop.sellerJsonUrl
      });
    }
  }

  return sources;
}

module.exports = { auditChain };
