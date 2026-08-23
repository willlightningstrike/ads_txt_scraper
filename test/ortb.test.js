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
