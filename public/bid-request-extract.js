// The browser keeps whole subtrees for these five keys and drops everything else —
// device, user, regs and imp among them — before anything is sent to the server.
//
// The list is deliberately coarse. Keeping it to top-level key names means this file
// needs no ORTB field-path knowledge; lib/ortb.js stays the single source of truth for
// that. A fine-grained per-field whitelist would duplicate those paths in client code
// and would fail open the moment a spec revision moved a field.
export const ALLOWED_TOP_LEVEL_KEYS = ["id", "site", "app", "dooh", "source"];

export function reduceBidRequest(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const reduced = {};

  for (const key of ALLOWED_TOP_LEVEL_KEYS) {
    if (parsed[key] !== undefined) {
      // Deep copy so nothing downstream shares a reference with the full request.
      reduced[key] = JSON.parse(JSON.stringify(parsed[key]));
    }
  }

  return reduced;
}
