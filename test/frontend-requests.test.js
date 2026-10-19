const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
let fixtureId = 0;
const auditPayload = {
  origin: { domain: "audit.example" }, verdict: "pass", firstFailedHop: null,
  summary: { hops: 0, pass: 0, broken: 0, unverifiable: 0 }, chainChecks: [], sources: [], hops: []
};
const validationPayload = {
  publisherDomain: "validation.example", accountId: "1", adsTxtEntryCount: 0, matchedEntryCount: 0,
  summary: { total: 0 }, records: []
};

// Exercise the actual ES modules with only browser DOM and network boundaries replaced.
// data: imports resolve the browser's root-relative imports without a build dependency.
async function page(t, { ignoreAbort = false } = {}) {
  const oldDocument = global.document;
  const oldFetch = global.fetch;
  const elements = new Map();
  function makeElement() {
    return { value: "", hidden: false, disabled: false, innerHTML: "", textContent: "", dataset: {}, style: {}, listeners: {},
      addEventListener(event, listener) { this.listeners[event] = listener; }, appendChild() {}, focus() {}, scrollIntoView() {}, querySelector() { return null; } };
  }
  const html = await fs.readFile(path.join(__dirname, "../public/index.html"), "utf8");
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, makeElement());
  for (const id of ["results", "loading-state", "cancel-button", "copy-json-button"]) elements.get(id).hidden = true;
  global.document = { getElementById: (id) => elements.get(id) || null, createElement: makeElement };
  const requests = [], submissions = [];
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    const request = { url, signal: options.signal, settled: false };
    const finish = (callback, value) => {
      request.settled = true;
      options.signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, options.signal.reason);
    request.respond = (payload) => finish(resolve, { ok: true, json: async () => payload });
    request.reject = (error) => finish(reject, error);
    if (!ignoreAbort) options.signal.addEventListener("abort", onAbort, { once: true });
    requests.push(request);
  });
  t.after(async () => {
    for (const request of requests) if (!request.settled) request.reject(new Error("fixture cleanup"));
    await Promise.allSettled(submissions);
    global.document = oldDocument;
    global.fetch = oldFetch;
  });
  const read = (name) => fs.readFile(path.join(__dirname, "../public", name), "utf8");
  const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const appUrl = moduleUrl(`${await read("app.js")}\n// fixture ${++fixtureId}`);
  const extractUrl = moduleUrl(await read("bid-request-extract.js"));
  const panelSource = (await read("ortb-panel.js"))
    .replace('from "/app.js"', `from ${JSON.stringify(appUrl)}`)
    .replace('from "/bid-request-extract.js"', `from ${JSON.stringify(extractUrl)}`);
  await import(moduleUrl(panelSource));
  const el = (id) => elements.get(id);
  el("adsTxtUrl").value = "https://validation.example/ads.txt";
  el("accountId").value = "1";
  el("ortb-input").value = JSON.stringify({ site: { domain: "audit.example" }, source: { schain: { complete: 1, nodes: [{ asi: "ssp.example", sid: "1" }] } } });
  const submit = (id) => {
    const result = el(id).listeners.submit({ preventDefault() {} });
    submissions.push(result);
    return result;
  };
  return { el, requests, submit };
}

test("Cancel aborts the active audit and returns both forms to idle", async (t) => {
  const { el, requests, submit } = await page(t);
  const pending = submit("ortb-form");
  assert.equal(el("cancel-button").hidden, false);
  el("cancel-button").listeners.click();
  assert.equal(requests[0].signal.aborted, true);
  await pending;
  assert.match(el("ortb-message").textContent, /cancelled/i);
  assert.equal(el("loading-state").hidden, true);
  assert.equal(el("submit-button").disabled, false);
  assert.equal(el("ortb-submit").disabled, false);
});

test("a pending validation disables both submission controls", async (t) => {
  const { el, submit } = await page(t);
  submit("validator-form");
  assert.equal(el("submit-button").disabled, true);
  assert.equal(el("ortb-submit").disabled, true);
});

test("late validation success cannot overwrite a newer completed audit", async (t) => {
  const { el, requests, submit } = await page(t, { ignoreAbort: true });
  const validation = submit("validator-form");
  const audit = submit("ortb-form");
  requests[1].respond(auditPayload);
  await audit;
  const displayed = el("results-meta").innerHTML;
  requests[0].respond(validationPayload);
  await validation;
  assert.equal(el("results-meta").innerHTML, displayed);
  assert.equal(el("copy-json-button").hidden, true);
  assert.equal(requests[0].signal.aborted, true);
});

test("late validation failure cannot clear a pending audit's loading state", async (t) => {
  const { el, requests, submit } = await page(t, { ignoreAbort: true });
  const validation = submit("validator-form");
  const audit = submit("ortb-form");
  requests[0].reject(new Error("old request failed"));
  await validation;
  assert.equal(el("loading-state").hidden, false);
  assert.equal(el("submit-button").disabled, true);
  assert.equal(el("form-message").textContent.includes("old request failed"), false);
  requests[1].respond(auditPayload);
  await audit;
});

test("late audit success cannot replace a newer validation or its copy payload", async (t) => {
  const { el, requests, submit } = await page(t, { ignoreAbort: true });
  const audit = submit("ortb-form");
  const validation = submit("validator-form");
  requests[1].respond(validationPayload);
  await validation;
  const displayed = el("results-meta").innerHTML;
  requests[0].respond(auditPayload);
  await audit;
  assert.equal(el("results-meta").innerHTML, displayed);
  assert.equal(el("copy-json-button").hidden, false);
});
