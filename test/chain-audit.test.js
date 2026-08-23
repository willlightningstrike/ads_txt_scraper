const test = require("node:test");
const assert = require("node:assert/strict");

const { auditChain } = require("../lib/chain-audit");

const NODES = [
  { asi: "exchange-a.com", sid: "12345", name: null, domain: null, hp: 1, rid: null },
  { asi: "bigssp.com", sid: "ex-a-7788", name: null, domain: null, hp: 1, rid: null }
];

const ADS_ENTRIES = [
  { adSystemDomain: "exchange-a.com", accountId: "12345", relationship: "DIRECT",
    certificationAuthorityId: null, lineNumber: 4, raw: "exchange-a.com, 12345, DIRECT" },
  { adSystemDomain: "bigssp.com", accountId: "ex-a-7788", relationship: "RESELLER",
    certificationAuthorityId: null, lineNumber: 9, raw: "bigssp.com, ex-a-7788, RESELLER" }
];

const SELLERS = {
  "https://exchange-a.com/sellers.json": { sellers: [
    { seller_id: "12345", name: "Daily News", domain: "dailynews.example", seller_type: "PUBLISHER" }
  ] },
  "https://bigssp.com/sellers.json": { sellers: [
    { seller_id: "ex-a-7788", name: "Exchange A", domain: "exchange-a.com", seller_type: "INTERMEDIARY" }
  ] }
};

const loadSellers = async (url) => {
  if (!SELLERS[url]) {
    throw new Error(`sellers.json unreachable at ${url}`);
  }
  return SELLERS[url];
};

const normalized = (overrides = {}) => ({
  origin: { kind: "site", domain: "dailynews.example", file: "ads.txt" },
  nodes: NODES,
  complete: 1,
  warnings: [],
  ...overrides
});

const run = (over = {}, opts = {}) => auditChain(normalized(over), {
  adsEntries: ADS_ENTRIES,
  loadSellers,
  originDomain: "dailynews.example",
  ...opts
});

test("a fully valid chain passes every hop", async () => {
  const result = await run();

  assert.equal(result.verdict, "pass");
  assert.equal(result.firstFailedHop, null);
  assert.deepEqual(result.hops.map((h) => h.verdict), ["pass", "pass"]);
  assert.equal(result.summary.pass, 2);
});

test("hop 0 expects PUBLISHER and hops after it expect INTERMEDIARY", async () => {
  const result = await run();

  assert.equal(result.hops[0].checks.sellerTypeValid.status, "pass");
  assert.equal(result.hops[1].checks.sellerTypeValid.status, "pass");
});

test("a mid-chain seller typed PUBLISHER fails the type check", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: ADS_ENTRIES,
    originDomain: "dailynews.example",
    loadSellers: async (url) => url.includes("bigssp")
      ? { sellers: [{ seller_id: "ex-a-7788", name: "Exchange A", domain: "exchange-a.com", seller_type: "PUBLISHER" }] }
      : SELLERS[url]
  });

  assert.equal(result.hops[1].checks.sellerTypeValid.status, "fail");
  assert.equal(result.verdict, "broken");
  assert.equal(result.firstFailedHop, 1);
});

test("the chain link check fails when a seller domain does not match the previous asi", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: ADS_ENTRIES,
    originDomain: "dailynews.example",
    loadSellers: async (url) => url.includes("bigssp")
      ? { sellers: [{ seller_id: "ex-a-7788", name: "Other SSP", domain: "someotherssp.com", seller_type: "INTERMEDIARY" }] }
      : SELLERS[url]
  });

  assert.equal(result.hops[1].checks.chainLink.status, "fail");
  assert.match(result.hops[1].checks.chainLink.message, /exchange-a\.com/);
  assert.equal(result.verdict, "broken");
});

test("hop 0 has no previous node, so its chain link check is skipped", async () => {
  const result = await run();

  assert.equal(result.hops[0].checks.chainLink.status, "skip");
});

test("a hop missing from ads.txt fails the declaration check", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: [ADS_ENTRIES[0]],
    loadSellers,
    originDomain: "dailynews.example"
  });

  assert.equal(result.hops[1].checks.adsTxtDeclared.status, "fail");
  assert.equal(result.summary.undeclared, 1);
});

test("an unreachable sellers.json is unverifiable, not broken", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: ADS_ENTRIES,
    originDomain: "dailynews.example",
    loadSellers: async (url) => {
      if (url.includes("bigssp")) {
        throw new Error("connection reset");
      }
      return SELLERS[url];
    }
  });

  assert.equal(result.hops[1].verdict, "unverifiable");
  assert.equal(result.hops[1].checks.sellersJsonReachable.status, "fail");
  assert.equal(result.verdict, "unverifiable");
});

test("a confidential seller is unverifiable rather than a pass", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: ADS_ENTRIES,
    originDomain: "dailynews.example",
    loadSellers: async (url) => url.includes("bigssp")
      ? { sellers: [{ seller_id: "ex-a-7788", is_confidential: 1, seller_type: "INTERMEDIARY" }] }
      : SELLERS[url]
  });

  assert.equal(result.hops[1].verdict, "unverifiable");
  assert.equal(result.hops[1].seller.isConfidential, true);
});

// The fixture needs BOTH a broken hop and an unverifiable one, or it cannot test
// precedence. An unreachable sellers.json yields "unverifiable" by design, so a chain
// whose only failure is unreachable is an unverifiable chain, not a broken one.
test("broken outranks unverifiable in the chain verdict", async () => {
  const result = await auditChain(
    normalized({ nodes: [
      NODES[0],
      { asi: "bigssp.com", sid: "not-a-real-seller", name: null, domain: null, hp: 1, rid: null },
      { asi: "gone.example", sid: "1", name: null, domain: null, hp: 1, rid: null }
    ] }),
    {
      adsEntries: ADS_ENTRIES,
      originDomain: "dailynews.example",
      loadSellers: async (url) => {
        if (url.includes("gone.example")) {
          throw new Error("unreachable");
        }
        return SELLERS[url];
      }
    }
  );

  assert.equal(result.hops[1].verdict, "broken");
  assert.equal(result.hops[2].verdict, "unverifiable");
  assert.equal(result.verdict, "broken");
});

test("complete:1 with an undeclared hop 0 contradicts the completeness flag", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: [ADS_ENTRIES[1]],
    loadSellers,
    originDomain: "dailynews.example"
  });

  const check = result.chainChecks.find((c) => c.code === "complete_flag_contradicted");
  assert.equal(check.status, "fail");
});

test("complete:0 with an undeclared hop 0 is not a contradiction", async () => {
  const result = await auditChain(normalized({ complete: 0 }), {
    adsEntries: [ADS_ENTRIES[1]],
    loadSellers,
    originDomain: "dailynews.example"
  });

  assert.equal(result.chainChecks.find((c) => c.code === "complete_flag_contradicted"), undefined);
});

test("an undeclared complete flag is not a contradiction either", async () => {
  const result = await auditChain(normalized({ complete: null }), {
    adsEntries: [ADS_ENTRIES[1]],
    loadSellers,
    originDomain: "dailynews.example"
  });

  assert.equal(result.chainChecks.find((c) => c.code === "complete_flag_contradicted"), undefined);
});

test("sources list the ads.txt file and every sellers.json touched, deduped", async () => {
  const result = await auditChain(
    normalized({ nodes: [NODES[0], NODES[0]] }),
    { adsEntries: ADS_ENTRIES, loadSellers, originDomain: "dailynews.example" }
  );

  const urls = result.sources.map((s) => s.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.includes("https://dailynews.example/ads.txt"));
  assert.ok(urls.includes("https://exchange-a.com/sellers.json"));
});

test("an empty node list produces an unverifiable result rather than a pass", async () => {
  const result = await auditChain(normalized({ nodes: [], complete: 0 }), {
    adsEntries: ADS_ENTRIES,
    loadSellers,
    originDomain: "dailynews.example"
  });

  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.hops.length, 0);
});
