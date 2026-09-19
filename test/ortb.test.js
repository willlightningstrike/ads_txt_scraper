const test = require("node:test");
const assert = require("node:assert/strict");

const { extractBidRequest } = require("../lib/ortb");

const SCHAIN = {
  ver: "1.0",
  complete: 1,
  nodes: [
    { asi: "exchange-a.com", sid: "12345", hp: 1 },
    { asi: "bigssp.com", sid: "ex-a-7788", hp: 1 }
  ]
};

test("site.domain resolves the ads.txt origin", () => {
  const result = extractBidRequest({
    site: { domain: "dailynews.example", page: "https://dailynews.example/story" },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.kind, "site");
  assert.equal(result.origin.domain, "dailynews.example");
  assert.equal(result.origin.file, "ads.txt");
  assert.equal(result.origin.resolvedFrom, "site.domain");
});

test("site.page host is the fallback when site.domain is absent", () => {
  const result = extractBidRequest({
    site: { page: "https://news.example.co.uk/a/b?c=1" },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.domain, "news.example.co.uk");
  assert.equal(result.origin.resolvedFrom, "site.page");
});

test("a site.domain and site.page host disagreement is warned about, not fatal", () => {
  const result = extractBidRequest({
    site: { domain: "dailynews.example", page: "https://spoofed.example/story" },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.domain, "dailynews.example");
  assert.ok(result.warnings.some((w) => w.code === "site_domain_page_mismatch"));
});

test("app inventory targets app-ads.txt and leaves domain null when app.domain is absent", () => {
  const result = extractBidRequest({
    app: { bundle: "com.zynga.words", storeurl: "https://apps.apple.com/us/app/id804379658" },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.kind, "app");
  assert.equal(result.origin.file, "app-ads.txt");
  assert.equal(result.origin.domain, null);
  assert.equal(result.origin.bundle, "com.zynga.words");
});

test("source.ext.schain wins over source.schain", () => {
  const result = extractBidRequest({
    site: { domain: "dailynews.example" },
    source: {
      schain: { ver: "1.0", complete: 0, nodes: [{ asi: "twosix.com", sid: "999" }] },
      ext: { schain: SCHAIN }
    }
  });

  assert.equal(result.schainSource, "source.ext.schain");
  assert.equal(result.nodes[0].asi, "exchange-a.com");
  assert.ok(result.warnings.some((w) => w.code === "schain_source_disagreement"));
});

test("source.schain is used when there is no ext schain", () => {
  const result = extractBidRequest({
    site: { domain: "dailynews.example" },
    source: { schain: SCHAIN }
  });

  assert.equal(result.schainSource, "source.schain");
  assert.equal(result.nodes.length, 2);
});

test("node order is preserved and fields are normalized", () => {
  const result = extractBidRequest({
    site: { domain: "dailynews.example" },
    source: { ext: { schain: { ver: "1.0", complete: 1, nodes: [
      { asi: "  Exchange-A.COM ", sid: " 12345 " },
      { asi: "bigssp.com", sid: "ex-a-7788" }
    ] } } }
  });

  assert.deepEqual(result.nodes.map((n) => n.asi), ["exchange-a.com", "bigssp.com"]);
  assert.equal(result.nodes[0].sid, "12345");
});

test("nodes with a missing asi or sid are dropped with a warning", () => {
  const result = extractBidRequest({
    site: { domain: "dailynews.example" },
    source: { ext: { schain: { ver: "1.0", complete: 1, nodes: [
      { asi: "exchange-a.com", sid: "12345" },
      { asi: "", sid: "77" }
    ] } } }
  });

  assert.equal(result.nodes.length, 1);
  assert.ok(result.warnings.some((w) => w.code === "invalid_schain_node"));
});

test("a request with no schain yields no nodes and says so", () => {
  const result = extractBidRequest({ site: { domain: "dailynews.example" } });

  assert.equal(result.nodes.length, 0);
  assert.equal(result.schainSource, null);
  assert.ok(result.warnings.some((w) => w.code === "no_schain"));
});

test("an unrecognised request yields an unknown origin rather than throwing", () => {
  const result = extractBidRequest({ id: "abc" });

  assert.equal(result.origin.kind, "unknown");
  assert.equal(result.origin.domain, null);
});

test("dooh inventory resolves from dooh.domain and targets ads.txt", () => {
  const result = extractBidRequest({
    dooh: { domain: "screens.example", name: "Mall Network" },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.kind, "dooh");
  assert.equal(result.origin.file, "ads.txt");
  assert.equal(result.origin.domain, "screens.example");
  assert.equal(result.origin.resolvedFrom, "dooh.domain");
});

test("a Play store URL whose id disagrees with app.bundle is warned about", () => {
  const result = extractBidRequest({
    app: {
      bundle: "com.zynga.words",
      storeurl: "https://play.google.com/store/apps/details?id=com.other.app"
    },
    source: { ext: { schain: SCHAIN } }
  });

  assert.ok(result.warnings.some((w) => w.code === "app_bundle_storeurl_mismatch"));
});

test("an Apple store URL is not compared to the bundle, because it cannot be", () => {
  const result = extractBidRequest({
    app: {
      bundle: "com.zynga.words",
      storeurl: "https://apps.apple.com/us/app/id804379658"
    },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.warnings.some((w) => w.code === "app_bundle_storeurl_mismatch"), false);
});

test("a non-string site.page never reaches origin.page as an object", () => {
  const result = extractBidRequest({
    site: { domain: "a.example", page: { toString: 1 } },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.page, null);
});

test("a non-object source yields no_schain rather than throwing", () => {
  const result = extractBidRequest({
    site: { domain: "dailynews.example" },
    source: "not-an-object"
  });

  assert.equal(result.nodes.length, 0);
  assert.equal(result.schainSource, null);
  assert.equal(result.complete, null);
  assert.ok(result.warnings.some((w) => w.code === "no_schain"));
});

test("a non-object source.ext falls back to source.schain", () => {
  const result = extractBidRequest({
    site: { domain: "dailynews.example" },
    source: { ext: "not-an-object", schain: SCHAIN }
  });

  assert.equal(result.schainSource, "source.schain");
  assert.equal(result.nodes.length, 2);
});

test("a non-array schain.nodes yields no_schain and no nodes", () => {
  const result = extractBidRequest({
    site: { domain: "dailynews.example" },
    source: { schain: { ver: "1.0", complete: 1, nodes: "not-an-array" } }
  });

  assert.equal(result.nodes.length, 0);
  assert.equal(result.schainSource, null);
  assert.ok(result.warnings.some((w) => w.code === "no_schain"));
});

test("a nodes array containing null and a primitive drops both under one warning", () => {
  const result = extractBidRequest({
    site: { domain: "dailynews.example" },
    source: { schain: { ver: "1.0", complete: 1, nodes: [
      null,
      "oops",
      { asi: "exchange-a.com", sid: "12345" }
    ] } }
  });

  assert.equal(result.nodes.length, 1);
  const invalidNodeWarnings = result.warnings.filter((w) => w.code === "invalid_schain_node");
  assert.equal(invalidNodeWarnings.length, 1);
  assert.ok(invalidNodeWarnings[0].message.includes("2 schain nodes"));
});

test("a site.page that is not a valid URL leaves domain unresolved without throwing", () => {
  const result = extractBidRequest({
    site: { page: "not-a-valid-url" },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.domain, null);
  assert.equal(result.origin.resolvedFrom, null);
  assert.equal(result.origin.page, "not-a-valid-url");
});

test("an omitted schain.complete yields null, and an explicit 0 still yields 0", () => {
  const omitted = extractBidRequest({
    site: { domain: "dailynews.example" },
    source: { ext: { schain: { ver: "1.0", nodes: [{ asi: "exchange-a.com", sid: "12345" }] } } }
  });
  assert.equal(omitted.complete, null);

  const explicitZero = extractBidRequest({
    site: { domain: "dailynews.example" },
    source: { ext: { schain: { ver: "1.0", complete: 0, nodes: [{ asi: "exchange-a.com", sid: "12345" }] } } }
  });
  assert.equal(explicitZero.complete, 0);
});

test("a full URL in site.domain is reduced to its host", () => {
  const result = extractBidRequest({
    site: { domain: "https://news.example/" },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.domain, "news.example");
  assert.equal(result.origin.resolvedFrom, "site.domain");
});

test("a hostile site.domain (non-stringifiable) does not throw and leaves domain unresolved", () => {
  const result = extractBidRequest({ site: { domain: { toString: 1 } } });

  assert.equal(result.origin.kind, "site");
  assert.equal(result.origin.domain, null);
  assert.equal(result.origin.resolvedFrom, null);
});

test("a hostile app.domain (non-stringifiable) does not throw and leaves domain unresolved", () => {
  const result = extractBidRequest({ app: { domain: { toString: 1 } } });

  assert.equal(result.origin.kind, "app");
  assert.equal(result.origin.domain, null);
  assert.equal(result.origin.resolvedFrom, null);
});

test("a hostile app.bundle (non-stringifiable) does not throw and leaves bundle null", () => {
  const result = extractBidRequest({ app: { bundle: { toString: 1 } } });

  assert.equal(result.origin.kind, "app");
  assert.equal(result.origin.bundle, null);
});

test("a hostile schain node.asi (non-stringifiable) does not throw and the node is dropped", () => {
  const result = extractBidRequest({
    site: { domain: "a.example" },
    source: { ext: { schain: { ver: "1.0", complete: 1, nodes: [
      { asi: { toString: 1 }, sid: "1" }
    ] } } }
  });

  assert.equal(result.nodes.length, 0);
  assert.ok(result.warnings.some((w) => w.code === "invalid_schain_node"));
});

test("a hostile schain node.domain (non-stringifiable) does not throw and the node's domain is null", () => {
  const result = extractBidRequest({
    site: { domain: "a.example" },
    source: { ext: { schain: { ver: "1.0", complete: 1, nodes: [
      { asi: "a.com", sid: "1", domain: { toString: 1 } }
    ] } } }
  });

  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].domain, null);
});

test("a hostile schain node.name (non-stringifiable) does not throw and comes back null, not an object", () => {
  const result = extractBidRequest({
    site: { domain: "a.example" },
    source: { ext: { schain: { ver: "1.0", complete: 1, nodes: [
      { asi: "a.com", sid: "1", name: { toString: 1 } }
    ] } } }
  });

  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].name, null);
});

test("a schain with more than 32 valid nodes is truncated to 32 with one warning", () => {
  const nodes = Array.from({ length: 40 }, (_value, index) => ({
    asi: `exchange-${index}.com`,
    sid: String(index)
  }));

  const result = extractBidRequest({
    site: { domain: "a.example" },
    source: { ext: { schain: { ver: "1.0", complete: 1, nodes } } }
  });

  assert.equal(result.nodes.length, 32);
  assert.equal(result.nodes[0].asi, "exchange-0.com");
  assert.equal(result.nodes[31].asi, "exchange-31.com");

  const truncationWarnings = result.warnings.filter((w) => w.code === "schain_truncated");
  assert.equal(truncationWarnings.length, 1);
  assert.match(truncationWarnings[0].message, /8 schain nodes/);
});

test("exactly 32 valid nodes is not truncated", () => {
  const nodes = Array.from({ length: 32 }, (_value, index) => ({
    asi: `exchange-${index}.com`,
    sid: String(index)
  }));

  const result = extractBidRequest({
    site: { domain: "a.example" },
    source: { ext: { schain: { ver: "1.0", complete: 1, nodes } } }
  });

  assert.equal(result.nodes.length, 32);
  assert.ok(!result.warnings.some((w) => w.code === "schain_truncated"));
});

// --- inventorypartnerdomain (ads.txt 1.1 / OpenRTB 2.6 inventory sharing) ---

test("site.inventorypartnerdomain is extracted and normalized", () => {
  const result = extractBidRequest({
    site: { domain: "owner.example", inventorypartnerdomain: " Partner.Example. " },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.inventoryPartnerDomain, "partner.example");
});

test("app.inventorypartnerdomain is extracted too", () => {
  const result = extractBidRequest({
    app: { domain: "dev.example", bundle: "com.a.b", inventorypartnerdomain: "partner.example" },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.inventoryPartnerDomain, "partner.example");
});

test("inventoryPartnerDomain is null when absent", () => {
  const result = extractBidRequest({ site: { domain: "owner.example" }, source: { ext: { schain: SCHAIN } } });
  assert.equal(result.origin.inventoryPartnerDomain, null);
});

test("an inventorypartnerdomain equal to the origin domain is not a partnership", () => {
  const result = extractBidRequest({
    site: { domain: "owner.example", inventorypartnerdomain: "OWNER.example" },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.inventoryPartnerDomain, null);
});

test("a hostile inventorypartnerdomain degrades to null rather than throwing", () => {
  const result = extractBidRequest({
    site: { domain: "owner.example", inventorypartnerdomain: { toString: 1 } },
    source: { ext: { schain: SCHAIN } }
  });

  assert.equal(result.origin.inventoryPartnerDomain, null);
});
