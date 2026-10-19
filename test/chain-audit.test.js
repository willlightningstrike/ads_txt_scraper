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

test("a confidential mid-chain seller typed PUBLISHER is broken, not unverifiable", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: ADS_ENTRIES,
    originDomain: "dailynews.example",
    loadSellers: async (url) => url.includes("bigssp")
      ? { sellers: [{ seller_id: "ex-a-7788", is_confidential: 1, seller_type: "PUBLISHER" }] }
      : SELLERS[url]
  });

  assert.equal(result.hops[1].checks.sellerTypeValid.status, "fail");
  assert.equal(result.hops[1].checks.chainLink.status, "skip");
  assert.equal(result.hops[1].verdict, "broken");
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
      adsEntries: [...ADS_ENTRIES, { adSystemDomain: "gone.example", accountId: "1", relationship: "RESELLER", lineNumber: 10, raw: "gone.example, 1, RESELLER" }],
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

test("a benign normalizer warning is surfaced but does not flip verdict to broken", async () => {
  const result = await run({
    warnings: [{ code: "site_domain_page_mismatch", message: "site.domain differs from the host of site.page." }]
  });

  assert.equal(result.verdict, "pass");
  assert.equal(result.firstFailedHop, null);
  assert.deepEqual(result.summary, { hops: 2, pass: 2, broken: 0, unverifiable: 0, undeclared: 0 });

  const check = result.chainChecks.find((c) => c.code === "site_domain_page_mismatch");
  assert.ok(check);
  assert.equal(check.status, "warn");
});

test("a hostile seller_id does not throw and reports the seller as not found", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: ADS_ENTRIES,
    originDomain: "dailynews.example",
    loadSellers: async (url) => url.includes("bigssp")
      ? { sellers: [{ seller_id: { toString: 1 }, name: "Exchange A", domain: "exchange-a.com", seller_type: "INTERMEDIARY" }] }
      : SELLERS[url]
  });

  assert.equal(result.hops[1].checks.sellerIdPresent.status, "fail");
  assert.equal(result.hops[1].verdict, "broken");
});

test("a hostile seller domain does not throw and degrades instead of crashing", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: ADS_ENTRIES,
    originDomain: "dailynews.example",
    loadSellers: async (url) => url.includes("bigssp")
      ? { sellers: [{ seller_id: "ex-a-7788", name: "Exchange A", domain: { toString: 1 }, seller_type: "INTERMEDIARY" }] }
      : SELLERS[url]
  });

  assert.equal(result.hops[1].seller.domain, null);
  assert.equal(result.hops[1].checks.chainLink.status, "fail");
});

test("a hostile seller name does not throw and falls back to a safe label", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: ADS_ENTRIES,
    originDomain: "dailynews.example",
    loadSellers: async (url) => url.includes("bigssp")
      ? { sellers: [{ seller_id: "ex-a-7788", name: { toString: 1 }, domain: "exchange-a.com", seller_type: "INTERMEDIARY" }] }
      : SELLERS[url]
  });

  assert.equal(result.hops[1].seller.name, "Unknown seller");
});

test("a hostile seller_type does not throw and degrades to a mismatch, not a pass", async () => {
  const result = await auditChain(normalized(), {
    adsEntries: ADS_ENTRIES,
    originDomain: "dailynews.example",
    loadSellers: async (url) => url.includes("bigssp")
      ? { sellers: [{ seller_id: "ex-a-7788", name: "Exchange A", domain: "exchange-a.com", seller_type: { toString: 1 } }] }
      : SELLERS[url]
  });

  assert.equal(result.hops[1].checks.sellerTypeValid.status, "fail");
  assert.equal(result.hops[1].verdict, "broken");
});

test("a numeric seller_id of 0 is treated as a valid ID, not absent", async () => {
  const result = await auditChain(
    normalized({ nodes: [{ asi: "exchange-a.com", sid: "0", name: null, domain: null, hp: 1, rid: null }] }),
    {
      adsEntries: [{ adSystemDomain: "exchange-a.com", accountId: "0", relationship: "DIRECT",
        certificationAuthorityId: null, lineNumber: 1, raw: "exchange-a.com, 0, DIRECT" }],
      originDomain: "dailynews.example",
      loadSellers: async () => ({
        sellers: [{ seller_id: 0, name: "Zero Seller", domain: "dailynews.example", seller_type: "PUBLISHER" }]
      })
    }
  );

  assert.equal(result.hops[0].checks.sellerIdPresent.status, "pass");
  assert.equal(result.hops[0].seller.sellerId, "0");
});

test("a sellers.json override domain gets a label matching the URL it actually opens", async () => {
  const result = await auditChain(
    normalized({ nodes: [{ asi: "google.com", sid: "pub-1", name: null, domain: null, hp: 1, rid: null }] }),
    {
      adsEntries: [{ adSystemDomain: "google.com", accountId: "pub-1", relationship: "DIRECT",
        certificationAuthorityId: null, lineNumber: 1, raw: "google.com, pub-1, DIRECT" }],
      originDomain: "dailynews.example",
      loadSellers: async () => ({
        sellers: [{ seller_id: "pub-1", name: "Daily News", domain: "dailynews.example", seller_type: "PUBLISHER" }]
      })
    }
  );

  const source = result.sources.find((s) => s.kind === "sellers-json");
  assert.equal(source.url, "https://storage.googleapis.com/adx-rtb-dictionaries/sellers.json");
  assert.equal(source.label, "storage.googleapis.com/adx-rtb-dictionaries/sellers.json");
});

test("an aborted signal stops the walk before starting the next hop", async () => {
  const controller = new AbortController();
  let hopsAttempted = 0;

  const result = await auditChain(
    normalized({ nodes: [
      NODES[0],
      { asi: "bigssp.com", sid: "ex-a-7788", name: null, domain: null, hp: 1, rid: null },
      { asi: "gone.example", sid: "1", name: null, domain: null, hp: 1, rid: null }
    ] }),
    {
      adsEntries: ADS_ENTRIES,
      originDomain: "dailynews.example",
      signal: controller.signal,
      loadSellers: async (url) => {
        hopsAttempted += 1;
        // Abort partway through: after hop 0's fetch resolves, the caller has gone away.
        // Hop 1 must not be started.
        if (url.includes("exchange-a")) {
          controller.abort();
        }
        return SELLERS[url];
      }
    }
  );

  assert.equal(hopsAttempted, 1, "only the first hop's sellers.json fetch should have started");
  assert.equal(result.hops.length, 1, "the walk should stop before starting hop 1");
  assert.equal(result.summary.hops, 1);
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

for (const relationship of ["RESELLER", "INVALID"]) {
  test(`the first-hop declaration ${relationship} cannot certify a publisher`, async () => {
    const result = await run({ nodes: [NODES[0]] }, {
      adsEntries: [{ ...ADS_ENTRIES[0], relationship }]
    });
    assert.equal(result.verdict, "broken");
    assert.equal(result.hops[0].checks.sellerTypeValid.status, "fail");
    assert.match(result.hops[0].checks.sellerTypeValid.message, new RegExp(relationship));
  });
}

test("a later DIRECT declaration cannot pass just because the seller is BOTH", async () => {
  const result = await run({}, {
    adsEntries: [ADS_ENTRIES[0], { ...ADS_ENTRIES[1], relationship: "DIRECT" }],
    loadSellers: async (url) => ({ sellers: SELLERS[url].sellers.map((seller) => ({ ...seller, seller_type: "BOTH" })) })
  });
  assert.equal(result.verdict, "broken");
  assert.equal(result.hops[1].checks.adsTxtDeclared.status, "fail");
});

test("a valid duplicate declaration is not hidden by an invalid earlier row", async () => {
  const result = await run({}, {
    adsEntries: [{ ...ADS_ENTRIES[0], relationship: "INVALID" }, ...ADS_ENTRIES]
  });
  assert.equal(result.verdict, "pass");
  assert.match(result.hops[0].checks.adsTxtDeclared.message, /as DIRECT/);
});

test("a chain truncated by normalization remains unverifiable", async () => {
  const { extractBidRequest } = require("../lib/ortb");
  const nodes = Array.from({ length: 33 }, (_,i) => ({ asi: `ssp${i}.example`, sid: String(i) }));
  const input = extractBidRequest({ site: { domain: "dailynews.example" }, source: { schain: { complete: 1, nodes } } });
  const result = await auditChain(input, {
    originDomain: "dailynews.example",
    adsEntries: nodes.map((node, i) => ({ adSystemDomain: node.asi, accountId: node.sid, relationship: i ? "RESELLER" : "DIRECT", lineNumber: i+1, raw: "fixture" })),
    loadSellers: async (url) => {
      const i = Number(new URL(url).hostname.match(/ssp(\d+)/)[1]);
      return { sellers: [{ seller_id: String(i), seller_type: i ? "INTERMEDIARY" : "PUBLISHER", domain: i ? `ssp${i-1}.example` : "dailynews.example" }] };
    }
  });
  assert.equal(result.summary.hops, 32);
  assert.equal(result.verdict, "unverifiable");
});

test("a dropped malformed node makes the chain broken", async () => {
  const { extractBidRequest } = require("../lib/ortb");
  const input = extractBidRequest({ site: { domain: "dailynews.example" }, source: { schain: { complete: 1, nodes: [NODES[0], { asi: "bad.example" }] } } });
  const result = await auditChain(input, { adsEntries: ADS_ENTRIES, loadSellers, originDomain: "dailynews.example" });
  assert.equal(result.verdict, "broken");
  assert.equal(result.chainChecks.find((c) => c.code === "invalid_schain_node").status, "fail");
});

test("an incomplete chain starting with a declared reseller does not invent a publisher failure", async () => {
  const result = await run({ complete: 0, nodes: [NODES[1]] });
  assert.equal(result.hops[0].checks.sellerTypeValid.status, "pass");
  assert.equal(result.hops[0].checks.sellerDomainAlignment.status, "skip");
  assert.equal(result.hops[0].verdict, "pass");
  assert.equal(result.verdict, "unverifiable");
});

test("missing completeness cannot certify an end-to-end chain", async () => {
  const result = await run({ complete: null });
  assert.equal(result.verdict, "unverifiable");
});

test("a known undeclared downstream hop remains broken when sellers.json is unavailable", async () => {
  const result = await run({}, {
    adsEntries: [ADS_ENTRIES[0]],
    loadSellers: async (url) => { if (url.includes("bigssp")) throw new Error("unavailable"); return SELLERS[url]; }
  });
  assert.equal(result.verdict, "broken");
  assert.equal(result.hops[1].verdict, "broken");
  assert.equal(result.summary.undeclared, 1);
});

for (const confidential of [0, 1]) {
  test(`incomplete first-hop duplicate declarations use the known seller type (confidential=${confidential})`, async () => {
    const direct = { ...ADS_ENTRIES[1], relationship: "DIRECT", ownerDomain: "exchange-a.com", sourceFile: "owner.example/ads.txt" };
    const reseller = { ...ADS_ENTRIES[1], ownerDomain: "partner.example", sourceFile: "partner.example/ads.txt" };
    for (const adsEntries of [[direct, reseller], [reseller, direct]]) {
      const result = await run({ complete: 0, nodes: [NODES[1]] }, {
        adsEntries,
        loadSellers: async () => ({ sellers: [{ seller_id: "ex-a-7788", seller_type: "INTERMEDIARY", domain: confidential ? undefined : "exchange-a.com", is_confidential: confidential }] })
      });
      assert.equal(result.verdict, "unverifiable");
      assert.equal(result.hops[0].checks.sellerTypeValid.status, "pass");
      assert.equal(result.hops[0].checks.sellerDomainAlignment.status, "skip");
      assert.match(result.hops[0].checks.adsTxtDeclared.message, /partner\.example/);
    }
  });
}
