import {describe, expect, it} from 'vitest';

import {
    DISCORD_AUTHORIZE_URL,
    DISCORD_IDENTITY_URL,
    DISCORD_SCOPE,
    DISCORD_TIMEOUT_MS,
    DISCORD_TOKEN_URL,
    DISCORD_USERNAME_MAX_LENGTH,
    authorizeUrl,
    exchangeCodeForIdentity,
    type DiscordLinkConfig,
    type FetchLike
} from '../src/index.js';
import {stubFetch, type StubResponse} from './support/fetchStub.js';

// The two raw steps, exercised as the published API the README advertises them
// as rather than through the flow that ordinarily calls them.
//
// `flow.test.ts` covers what a route sees. What is covered here is what a caller
// reaching for `authorizeUrl` / `exchangeCodeForIdentity` directly gets: the
// exact request put on the wire, the exact identity that comes back out, and the
// bound on how long either can take. Several assertions are over the WHOLE
// recorded request rather than over one field, because the failure being guarded
// against is somebody adding a parameter or a header nobody thought to check.

const ACCESS_TOKEN = 'discord-access-token-do-not-leak';

const CONFIG: DiscordLinkConfig = {
    clientId: 'client-id-1234',
    clientSecret: 'client-secret-abcd',
    redirectUri: 'https://community.example/api/v1/link/discord/callback'
};

const tokenGrant = (body: unknown): StubResponse => ({status: 200, body});

const identityOf = (body: unknown): StubResponse[] => [
    tokenGrant({access_token: ACCESS_TOKEN, token_type: 'Bearer'}),
    {status: 200, body}
];

const exchangeWith = async (responses: StubResponse[]) => {
    const {calls, fetchImpl} = stubFetch(responses);
    const outcome = await exchangeCodeForIdentity(CONFIG, 'the-code', {fetchImpl});
    return {calls, outcome};
};

describe('the authorize URL', () => {
    it('carries exactly the parameters Discord is asked for, and no others', () => {
        const url = new URL(authorizeUrl(CONFIG, 'a-signed-state.and-its-signature'));

        expect(url.origin + url.pathname).toBe(DISCORD_AUTHORIZE_URL);
        // Asserted as a whole set: a sixth parameter is a change to what a
        // browser is sent to Discord carrying, and it should not arrive quietly.
        expect([...url.searchParams.keys()].sort()).toEqual([
            'client_id',
            'prompt',
            'redirect_uri',
            'response_type',
            'scope',
            'state'
        ]);
        expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
        expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('scope')).toBe(DISCORD_SCOPE);
    });

    it('asks every time, so nobody is walked through consent by a link', () => {
        // Silent re-authorisation would mean a person who consented once could
        // finish the flow without seeing a screen, which is the one thing
        // consent is for.
        const url = new URL(authorizeUrl(CONFIG, 'a-state'));

        expect(url.searchParams.get('prompt')).toBe('consent');
    });

    it('passes the state through untouched, dot and all', () => {
        // A signed state is `payload.signature`, and base64url payloads contain
        // `-` and `_`. Anything that mangles them turns a valid callback into a
        // bad-signature refusal.
        const state = 'eyJuIjoiYWJj-XyJ9.c2ln_bmF0dXJl-Zm9y';

        expect(new URL(authorizeUrl(CONFIG, state)).searchParams.get('state')).toBe(state);
    });

    it('never puts the client secret in a URL a browser follows', () => {
        expect(authorizeUrl(CONFIG, 'a-state')).not.toContain(CONFIG.clientSecret);
    });
});

describe('exchanging the code', () => {
    it('posts the grant Discord expects, and asks for no scope of its own', async () => {
        const {calls} = await exchangeWith(identityOf({id: '1', username: 'alice_mc'}));

        expect(calls[0]?.url).toBe(DISCORD_TOKEN_URL);
        expect(calls[0]?.method).toBe('POST');
        expect(calls[0]?.headers).toEqual({
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        });
        // The whole body, parsed: a `scope` smuggled in here would widen what
        // the token is good for without touching the authorize URL above.
        expect(Object.fromEntries(new URLSearchParams(calls[0]?.body ?? ''))).toEqual({
            client_id: CONFIG.clientId,
            client_secret: CONFIG.clientSecret,
            grant_type: 'authorization_code',
            code: 'the-code',
            redirect_uri: CONFIG.redirectUri
        });
    });

    it('spends the token on exactly one identity read and nothing else', async () => {
        const {calls} = await exchangeWith(identityOf({id: '1', username: 'alice_mc'}));

        // The whole recorded call, because the token is in it and this is the
        // only request that is ever allowed to carry one.
        expect(calls[1]).toEqual({
            url: DISCORD_IDENTITY_URL,
            method: 'GET',
            headers: {Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/json'},
            body: null
        });
        expect(calls).toHaveLength(2);
    });

    it('refuses a grant that answered without a usable access token', async () => {
        // Discord answering 200 with a shape nobody planned for is not a reason
        // to carry on with `undefined` in an Authorization header.
        for (const body of [{}, {access_token: 12345}, null]) {
            const {calls, outcome} = await exchangeWith([tokenGrant(body)]);

            expect(outcome).toEqual({state: 'refused', detail: 'Discord did not accept that authorisation'});
            // The identity read never happened.
            expect(calls).toHaveLength(1);
        }
    });

    it('spends an EMPTY access token on the identity read, and lets Discord refuse it', async () => {
        // Characterisation, not endorsement. `access_token: ''` is a string, so
        // it passes the type check the grant applies and produces a request with
        // a bare `Bearer ` header; the identity read then refuses it. The
        // identity half rejects `id: ''` explicitly and this half does not,
        // which is the asymmetry recorded here rather than changed under a
        // test-expansion change.
        const {calls, outcome} = await exchangeWith([
            tokenGrant({access_token: ''}),
            {status: 401, body: {}}
        ]);

        expect(calls).toHaveLength(2);
        expect(calls[1]?.headers.Authorization).toBe('Bearer ');
        expect(outcome).toEqual({state: 'refused', detail: 'Discord did not return an account'});
    });

    it('does not forward Discord’s error body, which echoes the request', async () => {
        const {outcome} = await exchangeWith([
            {status: 400, body: {error: 'invalid_grant', error_description: 'client_id=client-id-1234'}}
        ]);

        expect(outcome).toEqual({state: 'refused', detail: 'Discord did not accept that authorisation'});
        expect(JSON.stringify(outcome)).not.toContain(CONFIG.clientId);
    });

    it('separates “Discord said no” from “Discord is having a bad day”', async () => {
        // A 5xx is not the visitor's fault and not something they can fix by
        // trying a different account, so it is `unavailable` rather than
        // `refused` — the two earn different pages.
        expect((await exchangeWith([{status: 500}])).outcome)
            .toEqual({state: 'unavailable', detail: 'Discord answered HTTP 500'});
        expect((await exchangeWith([{status: 0, networkError: true}])).outcome)
            .toEqual({state: 'unavailable', detail: 'Discord could not be reached'});
        expect((await exchangeWith(
            [tokenGrant({access_token: ACCESS_TOKEN}), {status: 503}]
        )).outcome).toEqual({state: 'unavailable', detail: 'Discord answered HTTP 503'});
    });
});

describe('the identity that comes back', () => {
    const identityFrom = async (body: unknown) => (await exchangeWith(identityOf(body))).outcome;

    it('is the snowflake, with the display name preferred over the handle', async () => {
        expect(await identityFrom({id: '112233445566778899', username: 'alice_mc', global_name: 'Alice'}))
            .toEqual({state: 'ok', identity: {id: '112233445566778899', username: 'Alice'}});
    });

    it('falls back to the handle when Discord sends a null display name', async () => {
        // The shape Discord actually sends for an account that has not set one.
        expect(await identityFrom({id: '1', username: 'alice_mc', global_name: null}))
            .toEqual({state: 'ok', identity: {id: '1', username: 'alice_mc'}});
    });

    it('settles for an empty name rather than inventing one', async () => {
        // A nameless account still has an id, and the id is the identity.
        expect(await identityFrom({id: '1'}))
            .toEqual({state: 'ok', identity: {id: '1', username: ''}});
    });

    it('bounds the name at the documented maximum, exactly', async () => {
        const atTheLimit = 'a'.repeat(DISCORD_USERNAME_MAX_LENGTH);
        expect(await identityFrom({id: '1', global_name: atTheLimit}))
            .toEqual({state: 'ok', identity: {id: '1', username: atTheLimit}});

        const overIt = 'a'.repeat(DISCORD_USERNAME_MAX_LENGTH + 1);
        expect(await identityFrom({id: '1', global_name: overIt}))
            .toEqual({state: 'ok', identity: {id: '1', username: atTheLimit}});
    });

    it('refuses an answer with no usable id, which is the only part that matters', async () => {
        for (const body of [{username: 'alice_mc'}, {id: ''}, {id: 12345}, null, 'not an object']) {
            expect(await identityFrom(body))
                .toEqual({state: 'refused', detail: 'Discord did not return an account'});
        }
    });

    it('carries nothing but an id and a username out of the package', async () => {
        const outcome = await identityFrom({
            id: '1',
            username: 'alice_mc',
            email: 'alice@example.com',
            mfa_enabled: true
        });

        expect(outcome).toEqual({state: 'ok', identity: {id: '1', username: 'alice_mc'}});
        // Asserted over the whole value: `identify` buys an id and a name, and
        // anything else Discord volunteers is dropped rather than passed on.
        expect(JSON.stringify(outcome)).not.toContain('alice@example.com');
        expect(JSON.stringify(outcome)).not.toContain(ACCESS_TOKEN);
    });
});

describe('the call to Discord is bounded', () => {
    // Somebody is sitting in front of a redirect waiting for this, so a Discord
    // that accepts the connection and then says nothing must not hold the tab
    // open indefinitely.
    const neverAnswers = (signals: Array<AbortSignal | null | undefined>): FetchLike =>
        (_url, init) => new Promise<Response>((_resolve, reject) => {
            signals.push(init.signal);
            init.signal?.addEventListener('abort', () => reject(new Error('the request was aborted')));
        });

    it('aborts a request that outlives the timeout and degrades rather than hanging', async () => {
        const signals: Array<AbortSignal | null | undefined> = [];

        const outcome = await exchangeCodeForIdentity(CONFIG, 'the-code', {
            fetchImpl: neverAnswers(signals),
            timeoutMs: 5
        });

        expect(signals).toHaveLength(1);
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(signals[0]?.aborted).toBe(true);
        expect(outcome).toEqual({state: 'unavailable', detail: 'Discord could not be reached'});
    });

    it('bounds the identity read too, not merely the token exchange', async () => {
        const signals: Array<AbortSignal | null | undefined> = [];
        const granted = neverAnswers(signals);
        let call = 0;
        const fetchImpl: FetchLike = (url, init) => {
            call += 1;
            if (call === 1) {
                return Promise.resolve({
                    status: 200,
                    ok: true,
                    json: async () => ({access_token: ACCESS_TOKEN})
                } as unknown as Response);
            }
            return granted(url, init);
        };

        const outcome = await exchangeCodeForIdentity(CONFIG, 'the-code', {fetchImpl, timeoutMs: 5});

        expect(signals).toHaveLength(1);
        expect(signals[0]?.aborted).toBe(true);
        expect(outcome).toEqual({state: 'unavailable', detail: 'Discord could not be reached'});
    });

    it('leaves the signal alone when Discord answers in time', async () => {
        const signals: Array<AbortSignal | null | undefined> = [];
        const {fetchImpl} = stubFetch(identityOf({id: '1', username: 'alice_mc'}));
        const recording: FetchLike = (url, init) => {
            signals.push(init.signal);
            return fetchImpl(url, init);
        };

        const outcome = await exchangeCodeForIdentity(CONFIG, 'the-code', {fetchImpl: recording});

        expect(outcome).toEqual({state: 'ok', identity: {id: '1', username: 'alice_mc'}});
        expect(signals).toHaveLength(2);
        expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    });
});

describe('the constants the README quotes', () => {
    it('pins every Discord endpoint to the documented v10 API', () => {
        // Not to an unversioned `/api/`, so a version bump is a change here
        // rather than a surprise in production. The authorize URL is Discord's
        // browser-facing one and is deliberately not under `/api/`.
        expect(DISCORD_TOKEN_URL).toBe('https://discord.com/api/v10/oauth2/token');
        expect(DISCORD_IDENTITY_URL).toBe('https://discord.com/api/v10/users/@me');
        expect(DISCORD_AUTHORIZE_URL).toBe('https://discord.com/oauth2/authorize');
    });

    it('asks for one scope, and the README says which', () => {
        expect(DISCORD_SCOPE).toBe('identify');
    });

    it('times Discord calls out after the eight seconds the README promises', () => {
        expect(DISCORD_TIMEOUT_MS).toBe(8000);
    });

    it('bounds a display name at sixty-four characters', () => {
        expect(DISCORD_USERNAME_MAX_LENGTH).toBe(64);
    });
});
