const { normalizeHostname } = require("./validation");

function parseAdsTxt(input) {
  return input
    .split(/\r?\n/)
    .map((line, index) => parseAdsTxtLine(line, index + 1))
    .filter(Boolean);
}

function parseAdsTxtLine(line, lineNumber) {
  const commentIndex = line.indexOf("#");
  const withoutComment = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const trimmed = withoutComment.trim();

  if (!trimmed) {
    return null;
  }

  const fields = trimmed.split(",").map((part) => part.trim());
  if (fields.length < 3) {
    return null;
  }

  // An empty ad system domain or account ID cannot identify anything to look up.
  // An unrecognised relationship is kept: validateSellerType reports it as a
  // mismatch, which is more useful to a publisher than silently dropping the row.
  const adSystemDomain = normalizeHostname(fields[0]);
  const accountId = fields[1];
  if (!adSystemDomain || !accountId) {
    return null;
  }

  return {
    adSystemDomain,
    accountId,
    relationship: fields[2].toUpperCase(),
    certificationAuthorityId: fields[3] || null,
    lineNumber,
    raw: line.trim()
  };
}

// ads.txt 1.1 variable lines take the form NAME=value (CONTACT, SUBDOMAIN,
// INVENTORYPARTNERDOMAIN, OWNERDOMAIN, MANAGERDOMAIN). Names are case-insensitive and
// may repeat, so each maps to the list of values in file order. Values are trimmed but
// otherwise left alone: not every variable holds a hostname, so any normalization is
// the caller's job. Data lines never match — they carry no "=" before their first comma.
function parseAdsTxtVariables(input) {
  const variables = {};

  for (const line of String(input || "").split(/\r?\n/)) {
    const commentIndex = line.indexOf("#");
    const trimmed = (commentIndex >= 0 ? line.slice(0, commentIndex) : line).trim();
    const match = trimmed.match(/^([A-Za-z]+)\s*=\s*(.+)$/);

    if (!match) {
      continue;
    }

    const name = match[1].toLowerCase();
    (variables[name] ||= []).push(match[2].trim());
  }

  return variables;
}

module.exports = { parseAdsTxt, parseAdsTxtLine, parseAdsTxtVariables };
