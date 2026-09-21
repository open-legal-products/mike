# Renewing the USPTO trademark-search WAF token

The connector uses the search service behind
[tmsearch.uspto.gov](https://tmsearch.uspto.gov/). USPTO protects that service
with AWS WAF. When WAF rejects automated requests, the connector needs a valid
`aws-waf-token` cookie issued to a real browser session.

`TMSEARCH_WAF_TOKEN` is temporary. Repeat this procedure when trademark
searches return an AWS WAF, HTTP 202, HTTP 403, or `WAF_CHALLENGE` error.

## 1. Obtain a fresh token

Use a browser on the same machine or network as the backend. AWS WAF can tie
tokens to browser and network characteristics.

1. Open [USPTO Trademark Search](https://tmsearch.uspto.gov/) in Chrome or
   Edge.
2. Complete any challenge shown by USPTO.
3. Run an ordinary trademark search and wait for its results.
4. Open Developer Tools (`F12`, or `Command+Option+I` on macOS).
5. Select **Application**.
6. Under **Storage**, expand **Cookies** and select
   `https://tmsearch.uspto.gov`.
7. Copy the complete value of the cookie named `aws-waf-token`.

If the cookie is absent, open the **Console** on the USPTO page and run:

```javascript
await AwsWafIntegration.getToken();
```

Then return to **Application > Cookies** and copy the new `aws-waf-token`
value.

## 2. Configure the backend

Add or replace this line in `backend/.env`:

```dotenv
TMSEARCH_WAF_TOKEN=paste-the-complete-cookie-value-here
```

- Keep the value on one line, with no spaces around `=`.
- Use only the cookie value, not the entire `Cookie:` header.
- Keep the token secret. Never commit it or put it in
  `backend/.env.example`.

## 3. Restart the backend

Restart only the backend process. The connector starts one short-lived child
process per operation, so it picks the token up at its next launch.

## 4. Verify the repair

Run a narrow exact-owner trademark search in the Assistant, for example a
search for one known owner through the `owner_name` argument. A successful
response contains exact-owner results without a WAF, HTTP 202, or HTTP 403
error. After that succeeds, retry the larger search.

## HTTP 429 is not a WAF failure

HTTP 429 is a request-rate limit. Do not renew the token for 429. Mike retries
the same search after 10 s, 20 s, and 30 s and paces bulk owner searches. On
continued throttling, wait at least 60 s and retry only the failed owners.

## Why renewal cannot be automated

AWS WAF issues the token only after a browser completes its challenge. The
backend cannot complete that challenge, and the web application cannot read
cookies belonging to the USPTO domain. Manual browser renewal preserves the
protection boundary.

For connector setup and configuration, see the
[USPTO Patent & Trademark connector](patent-mcp-connector.md) guide.
