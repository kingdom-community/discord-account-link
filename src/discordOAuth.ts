// The Discord OAuth2 authorization-code flow. Server-side only.
//
// THE EXCHANGE BELONGS IN THE LAYER THAT OWNS THE BROWSER REDIRECT, not in a
// back-end service behind it. The redirect URI is a public URL a person's
// browser visits, and an internal API has no public browser route to land it
// on. More to the point, the signed `state` is bound to the session, and only
// the component holding the session cookie can verify it. The Discord client
// secret therefore stays in the layer that owns the redirect and never reaches
// an internal service.
//
// SCOPE IS `identify` ONLY: an id and a username, nothing else. No guild
// membership, no email, no message access. The access token is used for exactly
// one `/users/@me` call and then discarded — it is never stored, never logged,
// and never forwarded to a back end, so there is no Discord token in anybody's
// database to leak.

import type {DiscordLinkConfig} from './config.js';

// Discord's own endpoints. Pinned to the documented v10 API rather than to
// whatever `/api/` resolves to today, so a version bump is a change here rather
// than a surprise in production.
export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
export const DISCORD_TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
export const DISCORD_IDENTITY_URL = 'https://discord.com/api/v10/users/@me';

// The only scope this package asks for. There is deliberately no option to add
// another: a linking flow that can read your guilds is a different feature with
// a different consent conversation, and it is not this one.
export const DISCORD_SCOPE = 'identify';

// Bounded: a person is sitting in front of a redirect waiting for this.
export const DISCORD_TIMEOUT_MS = 8000;

// A display name longer than this is the caller's problem rather than a 413
// from whatever stores it.
export const DISCORD_USERNAME_MAX_LENGTH = 64;

export interface DiscordIdentity {
    // The snowflake. THIS is the identity; everything else is decoration.
    id: string;
    // Current display name or handle. Allowed to go stale.
    username: string;
}

export type DiscordExchange =
    | {state: 'ok'; identity: DiscordIdentity}
    // Discord answered, and the answer is no: a reused or expired code, a
    // redirect-uri mismatch, a revoked application. Nothing the visitor can fix
    // by trying harder, and nothing to blame them for.
    | {state: 'refused'; detail: string}
    // Discord could not be reached, or answered something that is not an answer.
    | {state: 'unavailable'; detail: string};

// Injectable so tests can stub it and so a caller can wrap it with its own
// retry or instrumentation. Defaults to the runtime's `fetch`.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExchangeOptions {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
}

// Where to send the browser.
//
// `state` is produced by `issueState` and must already be signed; it is never
// generated here, so there is no path through this module that can build an
// authorize URL with an unsigned one.
export const authorizeUrl = (config: DiscordLinkConfig, state: string): string => {
    const parameters = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: DISCORD_SCOPE,
        state,
        // Ask every time. Silent re-authorisation would mean a person who
        // already consented once could be walked through the flow by a link
        // without seeing a screen, which is the one thing consent is for.
        prompt: 'consent'
    });
    return `${DISCORD_AUTHORIZE_URL}?${parameters.toString()}`;
};

const fetchWithTimeout = async (
    url: string,
    init: RequestInit,
    options: ExchangeOptions
): Promise<Response> => {
    const call = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!call) {
        throw new Error('no fetch implementation available');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DISCORD_TIMEOUT_MS);
    try {
        return await call(url, {...init, signal: controller.signal});
    } finally {
        clearTimeout(timer);
    }
};

// Exchange the authorization code for an access token, use it once, and throw it
// away.
//
// The token never leaves this function. It is not returned, not logged, not
// attached to a thrown error, and not put anywhere a caller could accidentally
// persist it — which is why the exchange and the identity read are one function
// rather than two. Every failure path returns a value; nothing here throws, so
// there is no stack trace with a bearer header in it either.
export const exchangeCodeForIdentity = async (
    config: DiscordLinkConfig,
    code: string,
    options: ExchangeOptions = {}
): Promise<DiscordExchange> => {
    let accessToken: string;
    try {
        const response = await fetchWithTimeout(DISCORD_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            },
            body: new URLSearchParams({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                grant_type: 'authorization_code',
                code,
                redirect_uri: config.redirectUri
            }).toString()
        }, options);
        if (response.status >= 500) {
            return {state: 'unavailable', detail: `Discord answered HTTP ${response.status}`};
        }
        const body = await response.json().catch(() => null);
        if (!response.ok || !body || typeof (body as Record<string, unknown>).access_token !== 'string') {
            // Deliberately does NOT forward Discord's error body. It echoes the
            // request, which carries the client id and, in some error shapes, the
            // redirect uri — neither of which belongs in a page a visitor reads.
            return {state: 'refused', detail: 'Discord did not accept that authorisation'};
        }
        accessToken = (body as Record<string, unknown>).access_token as string;
    } catch {
        return {state: 'unavailable', detail: 'Discord could not be reached'};
    }

    try {
        const response = await fetchWithTimeout(DISCORD_IDENTITY_URL, {
            method: 'GET',
            headers: {Authorization: `Bearer ${accessToken}`, Accept: 'application/json'}
        }, options);
        if (response.status >= 500) {
            return {state: 'unavailable', detail: `Discord answered HTTP ${response.status}`};
        }
        const body = await response.json().catch(() => null);
        const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
        if (!response.ok || !record || typeof record.id !== 'string' || record.id === '') {
            return {state: 'refused', detail: 'Discord did not return an account'};
        }
        // `global_name` is the current display name and `username` the handle;
        // either is fine to cache and both are allowed to go stale, because the
        // IDENTITY is the snowflake.
        const displayName = [record.global_name, record.username]
            .find((candidate) => typeof candidate === 'string' && candidate !== '') as string | undefined;
        return {
            state: 'ok',
            identity: {id: record.id, username: (displayName ?? '').slice(0, DISCORD_USERNAME_MAX_LENGTH)}
        };
    } catch {
        return {state: 'unavailable', detail: 'Discord could not be reached'};
    }
    // The access token goes out of scope here and is never stored.
};
