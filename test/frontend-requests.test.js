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
    return { value: "", hidden: false, disabled: false, innerHTML: "", textContent: "", dataset: {}, style: {}, listeners: {}, attributes: {}, selectionStart: 0, selectionEnd: 0,
      setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; }, setSelectionRange() {},
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
    request.respond = (payload, ok = true) => finish(resolve, { ok, json: async () => payload });
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
  const mount = (id) => {
    const element = makeElement();
    elements.set(id, element);
    return element;
  };
  return { el, requests, submit, mount };
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

test("Fire TV listings offer automatic resolution with an optional domain override", async (t) => {
  const { el } = await page(t);
  el("ortb-input").value = JSON.stringify({ app: { bundle: "B075NTHVJW", storeurl: "https://www.amazon.com/Tubi-Inc/dp/B075NTHVJW/" } });
  el("ortb-input").listeners.input();
  assert.match(el("ortb-extract").innerHTML, /Fire TV/);
  assert.match(el("ortb-extract").innerHTML, /Developer domain \(optional\)/);
  assert.doesNotMatch(el("ortb-extract").innerHTML, /1 needs input/);
});

test("a Fire TV ASIN without a store URL gets the same automatic-resolution prompt", async (t) => {
  const { el } = await page(t);
  el("ortb-input").value = JSON.stringify({ app: { bundle: "b075nthvjw" } });
  el("ortb-input").listeners.input();
  assert.match(el("ortb-extract").innerHTML, /Fire TV/);
  assert.match(el("ortb-extract").innerHTML, /Developer domain \(optional\)/);
});

test("a Google Play listing offers automatic resolution in the request inspector", async (t) => {
  const { el } = await page(t);
  el("ortb-input").value = JSON.stringify({ app: { bundle: "com.philo.philo.google", storeurl: "https://play.google.com/store/apps/details?id=com.philo.philo.google" } });
  el("ortb-input").listeners.input();
  assert.match(el("ortb-extract").innerHTML, /Google Play/);
  assert.match(el("ortb-extract").innerHTML, /Developer domain \(optional\)/);
});

test("a Vizio catalog URL identifies Vizio in the request inspector", async (t) => {
  const { el } = await page(t);
  el("ortb-input").value = JSON.stringify({ app: { bundle: "vizio.paramountplus", storeurl: "https://www.vizio.com/en/smart-tv-apps?appName=paramountplus&appId=vizio.paramountplus" } });
  el("ortb-input").listeners.input();
  assert.match(el("ortb-extract").innerHTML, /Vizio App Catalog/);
  assert.match(el("ortb-extract").innerHTML, /Developer domain \(optional\)/);
});

test("malformed seller fields remain editable without breaking the request inspector", async (t) => {
  const { el } = await page(t);
  el("ortb-input").value = JSON.stringify({ app: { bundle: "B075NTHVJW" }, source: { schain: { nodes: [
    { asi: { toString: {} }, sid: { toString: {} } }, null, { asi: "ssp.example", sid: 123 }
  ] } } });
  assert.doesNotThrow(() => el("ortb-input").listeners.input());
  assert.match(el("ortb-extract").innerHTML, /Unknown/);
  assert.match(el("ortb-extract").innerHTML, /No account ID/);
  assert.match(el("ortb-extract").innerHTML, /ssp.example/);
  assert.match(el("ortb-extract").innerHTML, /123/);
});

test("formatting and expanding the editor preserve the request", async (t) => {
  const { el } = await page(t);
  const before = el("ortb-input").value;
  assert.equal(typeof el("format-json").listeners.click, "function");
  el("format-json").listeners.click();
  assert.deepEqual(JSON.parse(el("ortb-input").value), JSON.parse(before));
  assert.ok(el("ortb-input").value.includes("\n"));
  assert.match(el("editor-stats").textContent, /lines/);
  el("expand-editor").listeners.click();
  assert.equal(el("request-workbench").dataset.expanded, "true");
  el("expand-editor").listeners.click();
  assert.equal(el("request-workbench").dataset.expanded, "false");
});

test("pasting a complete request formats it and updates the app-store preview", async (t) => {
  const { el } = await page(t);
  el("ortb-input").value = "";
  let prevented = false;
  assert.equal(typeof el("ortb-input").listeners.paste, "function");
  el("ortb-input").listeners.paste({ preventDefault() { prevented = true; }, clipboardData: { getData: () => '{"app":{"bundle":"B075NTHVJW"}}' } });
  assert.equal(prevented, true);
  assert.match(el("ortb-input").value, /\n  "app"/);
  assert.match(el("ortb-extract").innerHTML, /Amazon Appstore/);
});

test("invalid JSON remains available for editing when Format is clicked", async (t) => {
  const { el } = await page(t);
  el("ortb-input").value = '{"app":';
  assert.equal(typeof el("format-json").listeners.click, "function");
  el("format-json").listeners.click();
  assert.equal(el("ortb-input").value, '{"app":');
  assert.match(el("ortb-message").textContent, /valid JSON/);
});

test("manual domains survive formatting but are cleared for a different inventory origin", async (t) => {
  const { el, mount } = await page(t);
  const override = mount("ortb-origin-domain");
  mount("ortb-resolved-target");
  el("ortb-input").value = '{"app":{"bundle":"B075NTHVJW"}}';
  el("ortb-input").listeners.input();
  override.value = "tubitv.com";
  el("format-json").listeners.click();
  assert.equal(override.value, "tubitv.com");
  el("ortb-input").value = '{"app":{"bundle":"B076X8FKXP"}}';
  el("ortb-input").listeners.input();
  assert.equal(override.value, "");
  override.value = "fawesome.tv";
  el("ortb-input").value = "";
  el("ortb-input").listeners.input();
  el("ortb-input").value = '{"app":{"bundle":"B076X8FKXP"}}';
  el("ortb-input").listeners.input();
  assert.equal(override.value, "");
});

test("the seller tab changes workspace without discarding the pasted request", async (t) => {
  const { el } = await page(t);
  const before = el("ortb-input").value;
  assert.equal(typeof el("seller-tab").listeners.click, "function");
  el("seller-tab").listeners.click();
  assert.equal(el("bid-workspace").hidden, true);
  assert.equal(el("seller-workspace").hidden, false);
  el("bid-tab").listeners.click();
  assert.equal(el("ortb-input").value, before);
  assert.equal(el("bid-workspace").hidden, false);
});

const discovery = { store: "amazon", storeUrl: "https://www.amazon.com/dp/B075NTHVJW", lookupAttempted: true, domain: "tubitv.com", resolvedFrom: "known-map", file: "app-ads.txt", fileStatus: "fetched", fileUrl: "https://tubitv.com/app-ads.txt" };

for (const success of [true, false]) {
  test(`a ${success ? "successful" : "failed"} Google Play lookup names Google Play in the report`, async (t) => {
    const { el, requests, submit } = await page(t);
    const pending = submit("ortb-form");
    requests[0].respond({
      ...(success ? auditPayload : { reason: "origin_domain_required", error: "No developer domain found." }),
      discovery: { ...discovery, store: "google", storeUrl: "https://play.google.com/store/apps/details?id=com.philo.philo.google", domain: success ? "help.philo.com" : null, resolvedFrom: success ? "store-listing" : null, fileStatus: success ? "fetched" : "not_requested", fileUrl: success ? "https://help.philo.com/app-ads.txt" : null }
    }, success);
    await pending;
    assert.match(el("discovery-status").innerHTML, /Google Play checked/);
    assert.doesNotMatch(el("discovery-status").innerHTML, /Apple/);
    assert.match(el("discovery-status").innerHTML, success ? /app-ads.txt found/ : /Developer domain not resolved/);
  });
}

for (const success of [true, false]) {
  test(`a ${success ? "successful" : "failed"} Vizio lookup names Vizio in the report`, async (t) => {
    const { el, requests, submit } = await page(t);
    const pending = submit("ortb-form");
    requests[0].respond({
      ...(success ? auditPayload : { reason: "origin_domain_required", error: "No developer domain found." }),
      discovery: { ...discovery, store: "vizio", storeUrl: "https://www.vizio.com/en/smart-tv-apps?appId=vizio.paramountplus", domain: success ? "www.paramount.com" : null, resolvedFrom: success ? "store-listing" : null, fileStatus: success ? "fetched" : "not_requested", fileUrl: success ? "https://www.paramount.com/app-ads.txt" : null }
    }, success);
    await pending;
    assert.match(el("discovery-status").innerHTML, /Vizio App Catalog checked/);
    assert.doesNotMatch(el("discovery-status").innerHTML, /Apple/);
    assert.match(el("discovery-status").innerHTML, success ? /app-ads.txt found/ : /Developer domain not resolved/);
  });
}

for (const resolvedFrom of ["store-listing", "known-map"]) {
  test(`Pluto's ${resolvedFrom} result reports Google Play checked and the actual resolution method`, async (t) => {
    const { el, requests, submit } = await page(t);
    const pending = submit("ortb-form");
    requests[0].respond({ ...auditPayload, discovery: {
      ...discovery, store: "google", storeUrl: "https://play.google.com/store/apps/details?id=tv.pluto.android",
      domain: "pluto.tv", resolvedFrom, fileUrl: "https://pluto.tv/app-ads.txt"
    } });
    await pending;
    const report = el("discovery-status").innerHTML;
    assert.match(report, /Google Play checked/);
    assert.doesNotMatch(report, /not queried/);
    assert.match(report, resolvedFrom === "known-map" ? /verified app mapping/ : /Developer domain found in store metadata/);
    assert.doesNotMatch(report, resolvedFrom === "known-map" ? /Developer domain found in store metadata/ : /verified app mapping/);
  });
}

test("WatchFree+ discovery identifies its verified mapping instead of live developer metadata", async (t) => {
  const { el, requests, submit } = await page(t);
  const pending = submit("ortb-form");
  requests[0].respond({ ...auditPayload, discovery: {
    ...discovery, store: "vizio", storeUrl: "https://www.vizio.com/en/smart-tv-apps?appName=watchfree&appId=vizio.watchfree",
    domain: "www.vizio.com", resolvedFrom: "known-map", fileUrl: "https://www.vizio.com/app-ads.txt"
  } });
  await pending;
  assert.match(el("discovery-status").innerHTML, /Vizio App Catalog checked/);
  assert.match(el("discovery-status").innerHTML, /verified app mapping/);
  assert.match(el("discovery-status").innerHTML, /https:\/\/www\.vizio\.com\/app-ads\.txt/);
  assert.doesNotMatch(el("discovery-status").innerHTML, /Developer domain found in store metadata/);
});

for (const [mode, other, form, payload] of [
  ["seller", "bid", "validator-form", validationPayload],
  ["bid", "seller", "ortb-form", { ...auditPayload, discovery }]
]) {
  test(`switching from ${mode} clears the completed report but preserves form inputs`, async (t) => {
    const { el, requests, submit } = await page(t);
    el(`${mode}-tab`).listeners.click();
    const bidText = el("ortb-input").value;
    const pending = submit(form);
    requests[0].respond(payload);
    await pending;
    assert.equal(el("results").hidden, false);
    el(`${mode}-tab`).listeners.click();
    assert.equal(el("results").hidden, false, "reselecting the current tab keeps its report");
    el(`${other}-tab`).listeners.click();
    assert.equal(el("results").hidden, true);
    assert.equal(el("empty-state").hidden, false);
    for (const id of ["summary-grid", "results-meta", "records-list", "discovery-status"]) {
      assert.equal(el(id).innerHTML, "");
    }
    assert.equal(el("discovery-status").hidden, true);
    assert.equal(el("copy-json-button").hidden, true);
    assert.equal(el("form-message").textContent, "");
    assert.equal(el("ortb-message").textContent, "");
    assert.equal(el("ortb-input").value, bidText);
    assert.equal(el("adsTxtUrl").value, "https://validation.example/ads.txt");
    assert.equal(el("accountId").value, "1");
  });

  for (const outcome of ["success", "failure"]) {
    test(`a late ${mode} ${outcome} cannot restore its report after switching tabs`, async (t) => {
      const { el, requests, submit } = await page(t, { ignoreAbort: true });
      el(`${mode}-tab`).listeners.click();
      const pending = submit(form);
      el(`${other}-tab`).listeners.click();
      assert.equal(requests[0].signal.aborted, true);
      assert.equal(el("loading-state").hidden, true);
      assert.equal(el("cancel-button").hidden, true);
      assert.equal(el("submit-button").disabled, false);
      assert.equal(el("ortb-submit").disabled, false);
      if (outcome === "success") requests[0].respond(payload);
      else requests[0].reject(new Error("Old lookup failed"));
      await pending;
      assert.equal(el("results").hidden, true);
      assert.equal(el("discovery-status").hidden, true);
      assert.equal(el("empty-state").hidden, false);
      assert.equal(el("copy-json-button").hidden, true);
      assert.equal(el("form-message").textContent, "");
      assert.equal(el("ortb-message").textContent, "");
    });
  }
}

test("a successful file lookup identifies the store and fallback separately from the chain verdict", async (t) => {
  const { el, requests, submit } = await page(t);
  const pending = submit("ortb-form");
  requests[0].respond({ ...auditPayload, verdict: "broken", discovery });
  await pending;
  assert.equal(el("discovery-status").hidden, false);
  assert.match(el("discovery-status").innerHTML, /app-ads.txt found/i);
  assert.match(el("discovery-status").innerHTML, /Amazon Appstore.*checked/);
  assert.match(el("discovery-status").innerHTML, /verified app mapping/i);
});

test("an unresolved domain names the queried store and never claims that the file was found", async (t) => {
  const { el, requests, submit } = await page(t);
  const pending = submit("ortb-form");
  requests[0].respond({ reason: "origin_domain_required", error: "Developer metadata is missing.", discovery: { ...discovery, store: "lg", domain: null, resolvedFrom: null, fileUrl: null, fileStatus: "not_requested" } }, false);
  await pending;
  assert.match(el("discovery-status").innerHTML, /LG Content Store.*checked/);
  assert.match(el("discovery-status").innerHTML, /Developer domain not resolved/);
  assert.doesNotMatch(el("discovery-status").innerHTML, /app-ads.txt found/i);
});

test("a failed file fetch preserves the resolved domain and the store lookup outcome", async (t) => {
  const { el, requests, submit } = await page(t);
  const pending = submit("ortb-form");
  requests[0].respond({ error: "Remote server returned HTTP 404.", discovery: { ...discovery, resolvedFrom: "store-listing", fileStatus: "failed" } }, false);
  await pending;
  assert.match(el("discovery-status").innerHTML, /app-ads.txt could not be fetched/i);
  assert.match(el("discovery-status").innerHTML, /tubitv.com/);
  assert.match(el("discovery-status").innerHTML, /Amazon Appstore.*checked/);
  assert.equal(el("empty-state").hidden, true);
});

test("a later audit failure preserves file success without promising absent seller results", async (t) => {
  const { el, requests, submit } = await page(t);
  const pending = submit("ortb-form");
  requests[0].respond({ error: "The inventory partner file was unavailable.", discovery }, false);
  await pending;
  assert.match(el("discovery-status").innerHTML, /app-ads.txt found/i);
  assert.match(el("discovery-status").innerHTML, /audit could not be completed/i);
  assert.doesNotMatch(el("discovery-status").innerHTML, /results are shown below/i);
});

test("manual overrides do not falsely claim that the app store was queried", async (t) => {
  const { el, requests, submit } = await page(t);
  const pending = submit("ortb-form");
  requests[0].respond({ ...auditPayload, discovery: { ...discovery, lookupAttempted: false, resolvedFrom: "user" } });
  await pending;
  assert.match(el("discovery-status").innerHTML, /Amazon Appstore.*not queried/);
  assert.match(el("discovery-status").innerHTML, /manual domain/i);
});
