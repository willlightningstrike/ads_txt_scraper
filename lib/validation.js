function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
}

function normalizeSellerType(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function validateSellerType(relationship, sellerType) {
  const expectedTypes = relationship === "DIRECT"
    ? ["PUBLISHER", "BOTH"]
    : relationship === "RESELLER"
      ? ["INTERMEDIARY", "BOTH"]
      : [];

  if (expectedTypes.includes(sellerType)) {
    return {
      status: "valid",
      statusLabel: "Valid",
      message: `ads.txt relationship ${relationship} matches sellers.json seller_type ${sellerType}.`
    };
  }

  if (!expectedTypes.length) {
    return {
      status: "mismatch",
      statusLabel: "Mismatch",
      message: `Unsupported ads.txt relationship ${relationship} cannot be validated confidently.`
    };
  }

  return {
    status: "mismatch",
    statusLabel: "Mismatch",
    message: `ads.txt relationship ${relationship} does not align with sellers.json seller_type ${sellerType || "UNKNOWN"}.`
  };
}

function summarize(records) {
  return records.reduce(
    (summary, record) => {
      summary.total += 1;
      summary[record.status] += 1;

      if (record.confidential) {
        summary.confidential += 1;
      }

      if (record.domainCheck?.status === "match") {
        summary.domainMatches += 1;
      }

      if (record.domainCheck?.status === "related") {
        summary.domainRelated += 1;
      }

      if (record.domainCheck?.status === "mismatch") {
        summary.domainMismatches += 1;
      }

      return summary;
    },
    {
      total: 0,
      valid: 0,
      mismatch: 0,
      not_found: 0,
      unreachable: 0,
      confidential: 0,
      domainMatches: 0,
      domainRelated: 0,
      domainMismatches: 0
    }
  );
}

function compareDomains(publisherDomain, sellerDomain) {
  if (!sellerDomain) {
    return {
      status: "unknown",
      message: "No seller domain provided in sellers.json."
    };
  }

  if (publisherDomain === sellerDomain) {
    return {
      status: "match",
      message: `Seller domain ${sellerDomain} matches publisher domain ${publisherDomain}.`,
      sellerDomain
    };
  }

  // A suffix relationship is reported separately rather than as a match. Telling
  // a registrable domain from a public suffix needs the Public Suffix List, so
  // tenant.example.io under example.io looks identical here to a real subdomain.
  if (publisherDomain.endsWith(`.${sellerDomain}`) || sellerDomain.endsWith(`.${publisherDomain}`)) {
    return {
      status: "related",
      message: `Seller domain ${sellerDomain} shares a suffix with publisher domain ${publisherDomain}. A shared suffix alone does not establish common ownership.`,
      sellerDomain
    };
  }

  return {
    status: "mismatch",
    message: `Seller domain ${sellerDomain} does not match publisher domain ${publisherDomain}.`,
    sellerDomain
  };
}

module.exports = {
  compareDomains,
  normalizeHostname,
  normalizeSellerType,
  summarize,
  validateSellerType
};
