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

// Only change whitespace: reserializing would round large numeric IDs and discard
// duplicate keys in the original evidence the user is inspecting.
export function formatJson(raw) {
  JSON.parse(raw);
  let result = "", depth = 0, inString = false, escaped = false, previous = "";
  const compact = raw.trim();
  const newline = () => "\n" + "  ".repeat(depth);
  for (let index = 0; index < compact.length; index += 1) {
    const char = compact[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (/\s/.test(char)) continue;
    else if (char === '"') { inString = true; result += char; }
    else if (char === "{" || char === "[") {
      result += char;
      depth += 1;
      if (!/^\s*[}\]]/.test(compact.slice(index + 1))) result += newline();
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (previous !== "{" && previous !== "[") result += newline();
      result += char;
    } else if (char === ",") result += char + newline();
    else if (char === ":") result += ": ";
    else result += char;
    previous = char;
  }
  return result;
}

export function reduceBidRequest(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const reduced = {};

  for (const key of ALLOWED_TOP_LEVEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key) && parsed[key] !== undefined) {
      // Deep copy so nothing downstream shares a reference with the full request.
      reduced[key] = JSON.parse(JSON.stringify(parsed[key]));
    }
  }

  return reduced;
}
