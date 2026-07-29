# Ads.txt ↔ Sellers.json Validator

A small web tool that verifies a publisher's declared monetization rights by cross-referencing two IAB Tech Lab transparency files: the publisher's `ads.txt` and each ad system's `sellers.json`.

You give it an `ads.txt` URL and an account/seller ID. It finds every line in that `ads.txt` claiming the ID, then fetches the corresponding `sellers.json` from each ad system and checks that the two files tell the same story.

## What it checks

For each matching `ads.txt` entry, the validator reports one of four statuses:

| Status | Meaning |
|---|---|
| **Valid** | The `ads.txt` relationship matches the `seller_type` declared in `sellers.json`. |
| **Mismatch** | Both files list the seller, but the relationship and `seller_type` disagree. |
| **Not Found** | The seller ID is absent from the ad system's `sellers.json`. |
| **Unreachable** | The `sellers.json` file could not be fetched, parsed, or validated. |

The relationship rules applied are:

- `DIRECT` in `ads.txt` expects `PUBLISHER` or `BOTH` in `sellers.json`
- `RESELLER` in `ads.txt` expects `INTERMEDIARY` or `BOTH` in `sellers.json`

Alongside the status, each result also surfaces:

- **Domain alignment** — whether the seller's declared `domain` matches the publisher domain the `ads.txt` was served from
- **Confidential sellers** — entries flagged `is_confidential: 1`, where the ad system withholds seller name and domain
- **Endpoint used** — whether the standard `https://{adsystem}/sellers.json` path was used or a known non-standard override (Google, for example, publishes its `sellers.json` from a Google Cloud Storage endpoint)
- **Raw source line** — the original `ads.txt` line and its line number

Results can be copied as JSON from the UI for use elsewhere.

## Why it needs a server

Most adtech servers do not send CORS headers, so a browser cannot fetch `ads.txt` or `sellers.json` files directly from another origin. All outbound requests are therefore proxied through the Express backend. A purely static version of this tool is not possible.

## Requirements

- **Node.js 18 or newer** (uses `net.BlockList`, `String.prototype.replaceAll`, and the built-in `node --test` runner)
- **npm** (ships with Node.js)
- Outbound HTTPS internet access — the server fetches live `ads.txt` and `sellers.json` files

No database, API keys, or accounts are required.

## Setup

```bash
git clone https://github.com/<your-username>/<your-repo>.git
```

```bash
cd <your-repo>
```

```bash
npm install
```

## Running the app

Start the server:

```bash
npm start
```

Then open **http://localhost:3000** in your browser.

For development with automatic restarts on file changes:

```bash
npm run dev
```

To stop the server, press `Ctrl+C` in the terminal.

## Using it

1. Enter an `ads.txt` URL. It must be a full **HTTPS** URL — for example `https://www.example-publisher.com/ads.txt`.
2. Enter the account or seller ID you want to verify — for example `pub-1234567890`.
3. Click **Validate Monetization Rights**.
4. Review the summary counts at the top, then the per-entry cards below. Click **Copy JSON** to copy the full result payload.

If the seller ID does not appear anywhere in the `ads.txt` file, the report says so and no `sellers.json` lookups are performed.

## Running the tests

```bash
npm test
```

The suite covers the SSRF/URL-validation layer (private IP detection, IPv6 handling, DNS pinning). There is no end-to-end test — manual testing is done by running the server and using the UI.

## Configuration

All settings are optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `HOST` | `127.0.0.1` | Server bind address |
| `REQUEST_TIMEOUT_MS` | `20000` | Timeout for outbound HTTP requests |
| `MAX_JSON_BYTES` | `134217728` (128 MiB) | Max `sellers.json` response size |
| `MAX_CACHEABLE_JSON_BYTES` | `10485760` (10 MiB) | Max `sellers.json` size eligible for caching |
| `SELLERS_CACHE_SIZE` | `10` | Number of `sellers.json` files held in the LRU cache |

Example:

```bash
PORT=8080 HOST=0.0.0.0 npm start
```

Note that `HOST` defaults to `127.0.0.1`, so the server is only reachable from the local machine unless you change it.

## How it works

1. The browser POSTs `{ adsTxtUrl, accountId }` to `POST /api/validate`.
2. The server validates the URL, fetches the `ads.txt` file, and parses it into entries.
3. Entries whose account ID matches the input are kept; the rest are ignored.
4. For each match, the server fetches `https://{adSystemDomain}/sellers.json` (or a known override URL).
5. The seller ID is looked up in the `sellers` array and the relationship is validated.
6. Results, plus domain-alignment and confidentiality checks and a summary tally, are returned as JSON and rendered in the UI.

`sellers.json` responses are cached in memory for one hour under an LRU cache, so repeat lookups against the same ad system are fast. The cache is per-process and is cleared on restart.

### API

The backend can also be called directly:

```bash
curl -X POST http://localhost:3000/api/validate -H "Content-Type: application/json" -d '{"adsTxtUrl":"https://www.example-publisher.com/ads.txt","accountId":"pub-1234567890"}'
```

A health check is available at `GET /api/health`.

## Security notes

Because the server fetches URLs supplied by the user, it includes SSRF protections. Every outbound URL must satisfy all of the following:

- HTTPS only, on port 443
- No credentials embedded in the URL
- No `localhost`, `.localhost`, or `.local` hostnames
- Hostnames are resolved via DNS and every resolved address is checked against private, loopback, and link-local IPv4 and IPv6 ranges (including IPv4-mapped IPv6 forms) before any request is made
- Connections are pinned to the already-validated IP address to prevent DNS rebinding
- Redirects are followed manually, with each hop re-validated, capped at 4 hops
- Response sizes are capped

All user-supplied strings are HTML-escaped before being inserted into the page.

## Project structure

```
server.js              Express server, fetching, parsing, validation, SSRF guards
public/index.html      UI markup
public/app.js          Form handling and result rendering (vanilla JS, no build step)
public/style.css       Styles
test/server.test.js    Tests for the URL-validation layer
```

## License

Not currently licensed. Add a `LICENSE` file if you intend others to use or contribute to this code.
