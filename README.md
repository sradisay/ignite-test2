# Los Barriles Bootcamp — trip guide

A single-page trip guide for the Ignite Pickleball bootcamp, behind a shared
"speakeasy" passcode: everyone who is coming gets the same access code.

## Running it

The passcode is supplied as an environment variable. The server refuses to
start without one, so the site can never accidentally go live unprotected.

```bash
docker build -t ignite-trip .

docker run -p 8080:8080 \
  -e SITE_PASSCODE='pick-your-code-here' \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  ignite-trip
```

Locally, without Docker:

```bash
SITE_PASSCODE='pick-your-code-here' SESSION_SECRET='any-long-random-string' node server.js
```

Then open http://localhost:8080 and enter the code.

## Environment variables

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `SITE_PASSCODE` | **yes** | — | The shared access code. Minimum 6 characters. |
| `SESSION_SECRET` | strongly recommended | random per boot | Signs session cookies. Without it, everyone is logged out on each restart. |
| `PORT` | no | `8080` | Port to listen on. |
| `SESSION_DAYS` | no | `14` | How long a guest stays signed in. |
| `COOKIE_SECURE` | no | `auto` | `auto` sets the `Secure` flag when `X-Forwarded-Proto: https`. Force with `true`/`false`. |
| `MAX_ATTEMPTS` | no | `8` | Failed attempts from one IP before lockout. |
| `LOCKOUT_MINUTES` | no | `15` | How long that lockout lasts. |

## What the gate actually protects

`index.html` and everything in `public/` are served **only** after a valid
session cookie is presented. The trip details are never sent to an
unauthenticated browser, so viewing source or disabling JavaScript does not
reveal the itinerary, flight numbers, or contact details.

The one exception is `public/ignite_logo_full.png`, which the login screen
itself displays.

### Security properties

- Passcode compared in constant time; never logged and never echoed back.
- Session cookie is an HMAC-SHA256 signed token: `HttpOnly`, `SameSite=Lax`,
  `Secure` behind HTTPS, with an expiry baked into the signed payload.
- Per-IP rate limiting with lockout, so the code cannot be brute forced.
  While locked out, even the correct passcode is refused.
- Only `index.html` and `public/**` are reachable. `server.js`, the
  `Dockerfile`, and `.git/` are not served, and `../` traversal is blocked.
- Cross-origin form posts to `/login` are rejected.
- HTML responses are `no-store`, so a gated page does not linger in a shared
  or back-button cache.
- `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.

### What it is not

This is a shared-secret gate, appropriate for keeping a private trip page out
of public view. It is not per-guest identity: there are no individual accounts,
so you cannot revoke one person's access without rotating the code for
everyone. Anyone who has the code — or who is handed the link on an already
unlocked device — is in.

To rotate the code, change `SITE_PASSCODE` and restart. To sign everyone out,
change `SESSION_SECRET` as well.

## Deploying behind a proxy

Run it behind TLS. The server reads `X-Forwarded-Proto` to decide whether to
mark the cookie `Secure`, and `X-Forwarded-For` for rate-limit identity, so
make sure your proxy sets both.
