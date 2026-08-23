// Everything outside id/site/app/dooh/source is dropped before anything is sent
// to the server. The five allowed subtrees are kept WHOLE, not scrubbed — they can
// still carry identifiers: site.page and site.ref are full URLs that routinely carry
// query-string identifiers, site.content.data[].segment[] and app.content.data[] can
// carry inferred audience segments, app.bundle and app.storeurl reveal the user's
// installed app, and site.ext / app.ext / site.publisher.ext are free-form exchange
// blobs with no schema guarantee.
//
// The list is deliberately coarse. Keeping it to top-level key names means this file
// needs no ORTB field-path knowledge; lib/ortb.js stays the single source of truth for
// that. A fine-grained per-field whitelist would duplicate those paths in client code
// and would fail open the moment a spec revision moved a field.
export const ALLOWED_TOP_LEVEL_KEYS = Object.freeze(["id", "site", "app", "dooh", "source"]);

export function reduceBidRequest(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const reduced = {};

  for (const key of ALLOWED_TOP_LEVEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      // Deep copy so nothing downstream shares a reference with the full request.
      reduced[key] = JSON.parse(JSON.stringify(parsed[key]));
    }
  }

  return reduced;
}
