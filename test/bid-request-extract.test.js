const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePath = pathToFileURL(
  path.join(__dirname, "..", "public", "bid-request-extract.js")
).href;

const load = () => import(modulePath);

const FULL_REQUEST = {
  id: "1a2b3c",
  at: 1,
  cur: ["USD"],
  site: { domain: "dailynews.example", page: "https://dailynews.example/a", publisher: { id: "p-1" } },
  source: { ext: { schain: { ver: "1.0", complete: 1, nodes: [{ asi: "exchange-a.com", sid: "12345" }] } } },
  device: { ip: "203.0.113.9", ua: "Mozilla/5.0", ifa: "AAAA-BBBB", geo: { lat: 40.7, lon: -74 } },
  user: { id: "u-99", buyeruid: "b-99", eids: [{ source: "id5-sync.com", uids: [{ id: "deadbeef" }] }] },
  regs: { gdpr: 1 },
  imp: [{ id: "1", banner: { w: 300, h: 250 }, ext: { bidder: { publisherId: "x" } } }]
};

test("device, user, regs and imp never survive the reduction", async () => {
  const { reduceBidRequest } = await load();
  const reduced = reduceBidRequest(FULL_REQUEST);

  assert.equal(reduced.device, undefined);
  assert.equal(reduced.user, undefined);
  assert.equal(reduced.regs, undefined);
  assert.equal(reduced.imp, undefined);
});

test("no PII value appears anywhere in the serialized output", async () => {
  const { reduceBidRequest } = await load();
  const serialized = JSON.stringify(reduceBidRequest(FULL_REQUEST));

  for (const secret of ["203.0.113.9", "Mozilla/5.0", "AAAA-BBBB", "u-99", "b-99", "deadbeef", "40.7"]) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked into the reduced payload`);
  }
});

test("the five allowed subtrees survive intact", async () => {
  const { reduceBidRequest } = await load();
  const reduced = reduceBidRequest(FULL_REQUEST);

  assert.equal(reduced.id, "1a2b3c");
  assert.deepEqual(reduced.site, FULL_REQUEST.site);
  assert.deepEqual(reduced.source, FULL_REQUEST.source);
});

test("absent allowed keys are omitted rather than set to undefined", async () => {
  const { reduceBidRequest } = await load();
  const reduced = reduceBidRequest({ site: { domain: "a.example" } });

  assert.deepEqual(Object.keys(reduced), ["site"]);
});

test("the reduction is a copy, so later mutation of the input cannot leak", async () => {
  const { reduceBidRequest } = await load();
  const input = { site: { domain: "a.example" } };
  const reduced = reduceBidRequest(input);
  input.site.domain = "b.example";

  assert.equal(reduced.site.domain, "a.example");
});

test("a non-object input reduces to an empty object rather than throwing", async () => {
  const { reduceBidRequest } = await load();

  assert.deepEqual(reduceBidRequest(null), {});
  assert.deepEqual(reduceBidRequest("nope"), {});
});

test("the allow list is exactly the five documented keys", async () => {
  const { ALLOWED_TOP_LEVEL_KEYS } = await load();

  assert.deepEqual([...ALLOWED_TOP_LEVEL_KEYS].sort(), ["app", "dooh", "id", "site", "source"]);
});

test("a polluted Object.prototype cannot inject an allowed key that was never on the input", async () => {
  const { reduceBidRequest } = await load();

  Object.prototype.site = "PROTO_LEAK_VALUE";
  try {
    const reduced = reduceBidRequest({});
    assert.deepEqual(reduced, {});
  } finally {
    delete Object.prototype.site;
  }

  assert.equal({}.site, undefined, "Object.prototype pollution leaked past the test");
});

test("only allowed keys ever appear on the output, no matter what the input carries", async () => {
  const { reduceBidRequest, ALLOWED_TOP_LEVEL_KEYS } = await load();

  const reduced = reduceBidRequest({
    id: "1",
    site: { domain: "a.example" },
    device: { ip: "203.0.113.9" },
    user: { id: "u-1" },
    regs: { gdpr: 1 },
    imp: [{ id: "1" }],
    ext: { foo: "bar" },
    wseat: ["seat-1"],
    constructor: "not-a-function",
    toString: "not-a-function-either"
  });

  for (const key of Object.keys(reduced)) {
    assert.equal(ALLOWED_TOP_LEVEL_KEYS.includes(key), true, `${key} is not in the allow list`);
  }
});
