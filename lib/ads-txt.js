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

module.exports = { parseAdsTxt, parseAdsTxtLine };
