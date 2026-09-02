# @kingdom-community/discord-account-link

Link a Discord identity to an account on **your own** community site, using the
Discord OAuth2 authorization-code flow.

This is deliberately not "Sign in with Discord". It attaches a Discord id to an
account somebody already has, so your site can show a verified Discord handle on
a profile, gate a forum section, or reconcile a roster. There is no function in
this package that turns a Discord identity into a session.

Server-side only, no runtime dependencies, works with any framework.

## What it guarantees

These are the properties worth having, and they are enforced by the code and by
the test suite rather than by convention.

- **Scope is `identify` only** — an id and a username, nothing else. No guild
  membership, no email, no message access. There is no option to add a second
  scope: a linking flow that can read your guilds is a different feature with a
  different consent conversation, and it is not this one.
- **The access token is used once and discarded.** It buys exactly one
  `/users/@me` call and then goes out of scope. It is never returned, never
  logged, never attached to a thrown error, and never forwarded to a back end —
  so there is no Discord token in anybody's database to leak. The exchange and
  the identity read are one function precisely so there is no seam a caller could
  persist it through.
- **Endpoints are pinned to Discord API v10**, not to an unversioned `/api/`, so
  a version bump is a deliberate change in this package rather than a surprise in
  production.
- **The flow refuses to render or start unless it is fully configured** — client
  id, client secret, base URL *and* the state-signing secret. Without the signing
  secret the `state` cannot be signed, and **an unsigned `state` is the one thing
  this flow must never accept**. `discordLinkingConfigured()` is first-class
  exported API for exactly this reason.
- **The `state` is bound to the account that started the flow**, not merely
  random. A random state stops a replayed callback; it does not stop an attacker
  completing Discord's consent screen with *their* account against *your*
  session. The binding does.
- **The signer is injected.** Signing is a two-method port; an HMAC-SHA256
  implementation ships in the box, and a site that already issues signed values
  to browsers can pass its own and keep one secret instead of two.

## Install

```
npm install @kingdom-community/discord-account-link
```

Node 18 or newer (it uses the global `fetch`). Types are included.

## Configuration

| Variable | Required | What it is |
|---|---|---|
| `DISCORD_CLIENT_ID` | yes | From your Discord application's OAuth2 page. |
| `DISCORD_CLIENT_SECRET` | yes | Same page. Never leaves your server. |
| `DISCORD_STATE_SECRET` | yes | Signs the OAuth `state`. Any long random string. Not needed if you inject your own signer. |
| `SITE_BASE_URL` | yes | Absolute public origin, e.g. `https://community.example`. |
| `DISCORD_CALLBACK_PATH` | no | Defaults to `/api/v1/link/discord/callback`. |

The redirect URI is `SITE_BASE_URL` + the callback path, and it must be
registered on the Discord application **character for character** — a mismatch is
refused by Discord on an error page your site never sees.

`SITE_BASE_URL` has no default on purpose. In frameworks that inline public
environment variables at build time, an image built without one cannot acquire it
by restarting; guessing `http://localhost:3000` would turn a missing value into a
silently broken OAuth flow.

## Hiding the affordance

The degradation story is the important one, because "no Discord application
exists in this deployment" is an ordinary state, not a bug. Nothing in a library
can register an application for you, so the only honest behaviours are to hide
the button and refuse the route.

```ts
import {discordLinkingConfigured} from '@kingdom-community/discord-account-link';

// In whatever renders the account page:
const showDiscordButton = discordLinkingConfigured();
```

Check it before an affordance is **rendered**, and check it again before a route
**acts** — `flow.configured()` is the same gate, and every flow method already
answers `{state: 'not-configured'}` rather than half-running.

## Usage

```ts
import {
    discordLinkFlowFromEnv,
    callbackResponse,
    unlinkResponse,
    type AccountLinkStore
} from '@kingdom-community/discord-account-link';

// Where the link is recorded is your business. This is the only thing the
// package needs from you.
const store: AccountLinkStore = {
    async saveDiscordLink({accountUsername, identity}) {
        const taken = await db.findMemberByDiscordId(identity.id);
        if (taken && taken.username !== accountUsername) {
            // A conflict is not an error to apologise for. It is the system
            // telling somebody the identity they are claiming is already
            // somebody's, and the message should say which.
            return {
                state: 'refused',
                status: 409,
                code: 'identity_already_linked',
                message: 'That Discord account is already linked to another member.'
            };
        }
        await db.setDiscordLink(accountUsername, identity);
        return {state: 'ok', value: null};
    },
    async removeDiscordLink({accountUsername}) {
        const had = await db.clearDiscordLink(accountUsername);
        // Idempotent: unlinking something already unlinked is a success.
        return {state: 'ok', value: {unlinked: had}};
    }
};

const flow = discordLinkFlowFromEnv({store});
```

**Starting the flow** — a route your "Link Discord" button points at:

```ts
const begun = flow.begin(session.username);
if (begun.state !== 'ok') {
    return response.status(503).json({error: 'discord_linking_unavailable'});
}
response.setHeader('Cache-Control', 'no-store');
response.redirect(302, begun.url);
```

**Finishing it** — the route Discord redirects back to:

```ts
const outcome = await flow.link({
    accountUsername: session.username,   // the state is checked against THIS
    code: request.query.code,
    state: request.query.state,
    error: request.query.error           // set when the person pressed Cancel
});

const {status, body, headers} = callbackResponse(outcome);
// ...or branch on outcome.state yourself and redirect to your account page.
```

`flow.link` verifies the `state` **before** it says anything to Discord, so a
callback bound to somebody else's session never causes an authorization code to
be exchanged at all.

**Unlinking:**

```ts
const {status, body} = unlinkResponse(await flow.unlink(session.username));
```

`unlink` deliberately sits *outside* the configuration gate: an operator who
removes the Discord application must not strand people who are already linked.

Unlinking is a state change, so apply the same cross-origin check you apply to
every other state change. A cross-site page silently detaching somebody's
verified identity is a small attack, but it is still an attack.

## Bringing your own signer

`state` signing is a port:

```ts
export interface StateSigner {
    sign(payload: string): string;
    verify(token: string):
        | {ok: true; payload: string}
        | {ok: false; reason: 'malformed' | 'bad-signature'};
}
```

Pass one in and `DISCORD_STATE_SECRET` is never read:

```ts
const flow = discordLinkFlowFromEnv({store, signer: myExistingHmacSigner});
```

`verify` must not throw on arbitrary attacker-supplied input, and must check the
signature before decoding anything. The bundled `createHmacStateSigner(secret)`
does both — it compares in constant time and is length-safe, because Node's
`timingSafeEqual` *throws* on differing lengths, which would turn a forged state
into a 500 and leak the expected signature length through the difference between
an error page and a redirect.

`createHmacStateSigner` returns `null` when the secret is unset. That null is the
point: it makes "not configured" a value the rest of the package carries around
and checks, rather than an exception thrown from deep inside a redirect handler.

`@kingdom-community/web-guards` implements the same signed-state scheme, but
exposes it as `issueState`/`verifyState` functions that take the signing secret
directly rather than as a `StateSigner` object, so there is nothing there to
pass in here as one. Neither package depends on the other.

## Testing your integration

Every network call goes through an injectable `fetch`:

```ts
const flow = createDiscordLinkFlow({config, signer, store, fetchImpl: myStub});
```

## API

| Export | What it does |
|---|---|
| `discordLinkFlowFromEnv(options?)` | The ordinary entry point. Reads the environment, returns a flow that is already switched off if it should be. |
| `createDiscordLinkFlow(options)` | Explicit construction: `config`, `signer`, optional `store`, `fetchImpl`, `timeoutMs`, `now`. |
| `flow.configured()` / `discordLinkingConfigured(env?)` | The gate. |
| `flow.begin(username)` | `{state:'ok', url, oauthState}` or `{state:'not-configured'}`. |
| `flow.complete(params)` | Verified identity, without touching the store. |
| `flow.link(params)` | `complete` plus a write to the store. |
| `flow.unlink(username)` | Idempotent removal. Outside the gate. |
| `createHmacStateSigner(secret)` | The default signer, or `null`. |
| `issueState` / `verifyState` / `STATE_TTL_MS` | The signed, session-bound state, if you want it directly. |
| `authorizeUrl` / `exchangeCodeForIdentity` | The raw two steps. |
| `callbackResponse` / `unlinkResponse` | Framework-agnostic status/body decision tables. |
| `activeSessionFrom` | Picks the rotated token over the cookie token when a session was renewed mid-request. |
| `linkOutcomeFrom` / `refusalFrom` | Status-to-outcome mapping for a store backed by your own HTTP API. |

State lives for ten minutes (`STATE_TTL_MS`). Discord calls time out after eight
seconds — somebody is sitting in front of a redirect waiting for them.

## What is deliberately not here

- **No login.** Nothing mints a session from a Discord identity.
- **No token storage or refresh.** There is nothing to refresh; the token is gone.
- **No second scope.** See above.
- **No framework glue.** Cookies, cross-origin checks, session resolution and
  method allow-lists belong to your framework and differ between all of them.
  What does not differ is which outcome deserves which status, and that is what
  `callbackResponse` and `unlinkResponse` are.

## Origins

Extracted from the website and infrastructure stack behind a Minecraft community
server, generalised and released under the MIT license.
