import {describe, expect, it} from 'vitest';

import {
    DISCORD_IDENTITY_URL,
    DISCORD_TOKEN_URL,
    createDiscordLinkFlow,
    createHmacStateSigner,
    issueState,
    type AccountLinkStore,
    type DiscordLinkConfig,
    type LinkOutcome
} from '../src/index.js';
import {stubFetch, type StubResponse} from './support/fetchStub.js';

// The Discord authorization-code flow, both halves.
//
// What crosses out of this package is two strings — a snowflake and a name — and
// never a Discord token. Several of the assertions below are over the WHOLE
// recorded request or the WHOLE returned value rather than over one field,
// because the failure being guarded against is somebody adding the token
// somewhere new.

const STATE_SECRET = 'state-secret-0123456789-0123456789';
const ACCESS_TOKEN = 'discord-access-token-do-not-leak';

const CONFIG: DiscordLinkConfig = {
    clientId: 'client-id-1234',
    clientSecret: 'client-secret-abcd',
    redirectUri: 'https://community.example/api/v1/link/discord/callback'
};

const signer = createHmacStateSigner(STATE_SECRET)!;

const flowWith = (responses: StubResponse[], store?: AccountLinkStore) => {
    const {calls, fetchImpl} = stubFetch(responses);
    const flow = createDiscordLinkFlow({config: CONFIG, signer, store, fetchImpl});
    return {flow, calls};
};

const SUCCESSFUL_EXCHANGE: StubResponse[] = [
    {status: 200, body: {access_token: ACCESS_TOKEN, token_type: 'Bearer'}},
    {status: 200, body: {id: '112233445566778899', username: 'alice_mc', global_name: 'Alice'}}
];

describe('the configuration gate', () => {
    it('is off when there is no Discord application', () => {
        const flow = createDiscordLinkFlow({config: null, signer});

        expect(flow.configured()).toBe(false);
        expect(flow.begin('alice')).toEqual({state: 'not-configured'});
    });

    it('is off when the state-signing secret alone is missing', async () => {
        // The secret signs the `state` and nothing else, so its absence takes
        // out Discord linking and nothing else — but it must take that out
        // completely, because an unsigned state is the one thing this flow can
        // never send.
        const flow = createDiscordLinkFlow({config: CONFIG, signer: null});

        expect(flow.configured()).toBe(false);
        expect(flow.begin('alice')).toEqual({state: 'not-configured'});
    });

    it('is inert at the callback too, not merely at the button', async () => {
        const {calls, fetchImpl} = stubFetch(SUCCESSFUL_EXCHANGE);
        const flow = createDiscordLinkFlow({config: CONFIG, signer: null, fetchImpl});

        const outcome = await flow.complete({accountUsername: 'alice', code: 'the-code', state: 'anything'});

        expect(outcome).toEqual({state: 'not-configured'});
        // Nothing was said to Discord. A route that is switched off does not
        // half-run.
        expect(calls).toHaveLength(0);
    });

    it('is on when everything is present', () => {
        const {flow} = flowWith([]);

        expect(flow.configured()).toBe(true);
    });
});

describe('beginning the flow', () => {
    it('sends the browser to Discord with identify scope and a signed state', () => {
        const {flow} = flowWith([]);
        const begun = flow.begin('alice');

        expect(begun.state).toBe('ok');
        const url = new URL((begun as {url: string}).url);
        expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
        expect(url.searchParams.get('client_id')).toBe('client-id-1234');
        expect(url.searchParams.get('response_type')).toBe('code');
        // identify ONLY: an id and a username. No guilds, no email, no messages.
        expect(url.searchParams.get('scope')).toBe('identify');
        expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
        expect(url.searchParams.get('prompt')).toBe('consent');
        expect(url.searchParams.get('state')).toBeTruthy();
        // The client SECRET is never in a URL a browser follows.
        expect((begun as {url: string}).url).not.toContain(CONFIG.clientSecret);
    });

    it('REFUSES to start a flow for nobody, and says so as 401 rather than 503', () => {
        // A state bound to `''` binds to nothing: every signed-out browser
        // shares it. `begin` reports the empty account distinctly from the
        // switched-off deployment, because the two earn different statuses.
        const {flow} = flowWith([]);

        expect(flow.begin('')).toEqual({state: 'unauthenticated'});
        expect(flow.begin('   ')).toEqual({state: 'unauthenticated'});
        // No URL was produced, so no unbound state reached a browser history.
        expect(flow.begin('')).not.toHaveProperty('url');
    });

    it('asks for exactly one scope and never a second', () => {
        const {flow} = flowWith([]);
        const url = new URL((flow.begin('alice') as {url: string}).url);

        expect(url.searchParams.getAll('scope')).toEqual(['identify']);
        const scopes = (url.searchParams.get('scope') ?? '').split(/[\s+]/).filter(Boolean);
        expect(scopes).toEqual(['identify']);
        for (const forbidden of ['guilds', 'email', 'messages.read', 'bot', 'connections']) {
            expect(url.search).not.toContain(forbidden);
        }
    });
});

describe('completing the flow', () => {
    const validState = () => issueState('alice', signer) as string;

    it('exchanges the code and returns only the identity', async () => {
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE);

        const outcome = await flow.complete({
            accountUsername: 'alice',
            code: 'the-code',
            state: validState()
        });

        expect(outcome).toEqual({state: 'ok', identity: {id: '112233445566778899', username: 'Alice'}});
        expect(calls[0]!.url).toBe(DISCORD_TOKEN_URL);
        expect(calls[1]!.url).toBe(DISCORD_IDENTITY_URL);
        // Exactly two calls: one exchange, one identity read. The token is used
        // once and then goes out of scope.
        expect(calls).toHaveLength(2);
        // THE TOKEN IS NOT IN THE RETURNED VALUE. Asserted over the whole value
        // rather than over one field.
        expect(JSON.stringify(outcome)).not.toContain(ACCESS_TOKEN);
    });

    it('requests the identity with the token and asks Discord for nothing else', async () => {
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE);
        await flow.complete({accountUsername: 'alice', code: 'the-code', state: validState()});

        // Pinned to v10 rather than to an unversioned /api/, so a version bump
        // is a deliberate change.
        expect(calls[0]!.url).toBe('https://discord.com/api/v10/oauth2/token');
        expect(calls[1]!.url).toBe('https://discord.com/api/v10/users/@me');
        expect(calls[1]!.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
        // The token exchange never asks for a scope of its own either.
        expect(calls[0]!.body).not.toContain('scope');
        expect(calls[0]!.body).toContain('grant_type=authorization_code');
    });

    it('REFUSES A CALLBACK BOUND TO A DIFFERENT SESSION, before talking to Discord', async () => {
        // The attack the binding exists for: an attacker starts the flow, gets
        // a valid signed state, and finishes it against the victim's session so
        // that THEIR Discord id lands on the victim's profile.
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE);
        const attackersState = issueState('mallory', signer) as string;

        const outcome = await flow.complete({
            accountUsername: 'alice',
            code: 'the-code',
            state: attackersState
        });

        expect(outcome).toEqual({state: 'invalid-state', reason: 'wrong-session'});
        // Discord was never contacted, so the attacker's authorization code was
        // never exchanged.
        expect(calls).toHaveLength(0);
    });

    it('refuses a callback with no state at all, before talking to Discord', async () => {
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE);

        const outcome = await flow.complete({accountUsername: 'alice', code: 'the-code'});

        expect(outcome).toEqual({state: 'invalid-state', reason: 'malformed'});
        expect(calls).toHaveLength(0);
    });

    it('refuses a tampered state, before talking to Discord', async () => {
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE);
        const [payload, signature] = validState().split('.');
        const forged = Buffer.from(JSON.stringify({n: 'x', u: 'alice', e: Date.now() + 60_000}))
            .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        expect(forged).not.toEqual(payload);
        const outcome = await flow.complete({
            accountUsername: 'alice',
            code: 'the-code',
            state: `${forged}.${signature}`
        });

        expect(outcome).toEqual({state: 'invalid-state', reason: 'bad-signature'});
        expect(calls).toHaveLength(0);
    });

    it('refuses an unsigned state, before talking to Discord', async () => {
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE);
        const unsigned = Buffer.from(JSON.stringify({n: 'x', u: 'alice', e: Date.now() + 60_000}))
            .toString('base64').replace(/=+$/, '');

        expect(await flow.complete({accountUsername: 'alice', code: 'c', state: unsigned}))
            .toEqual({state: 'invalid-state', reason: 'malformed'});
        expect(await flow.complete({accountUsername: 'alice', code: 'c', state: `${unsigned}.sig`}))
            .toEqual({state: 'invalid-state', reason: 'bad-signature'});
        expect(calls).toHaveLength(0);
    });

    it('refuses a state signed with somebody else’s secret', async () => {
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE);
        const forged = issueState('alice', createHmacStateSigner('some-other-secret')!) as string;

        expect(await flow.complete({accountUsername: 'alice', code: 'c', state: forged}))
            .toEqual({state: 'invalid-state', reason: 'bad-signature'});
        expect(calls).toHaveLength(0);
    });

    it('refuses an expired state', async () => {
        const {calls, fetchImpl} = stubFetch(SUCCESSFUL_EXCHANGE);
        const flow = createDiscordLinkFlow({
            config: CONFIG,
            signer,
            fetchImpl,
            now: () => 2_000_000_000
        });
        const stale = issueState('alice', signer, 1_000_000) as string;

        expect(await flow.complete({accountUsername: 'alice', code: 'c', state: stale}))
            .toEqual({state: 'invalid-state', reason: 'expired'});
        expect(calls).toHaveLength(0);
    });

    it('treats a cancelled consent screen as an ordinary outcome', async () => {
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE);

        const outcome = await flow.complete({
            accountUsername: 'alice',
            state: validState(),
            error: 'access_denied'
        });

        expect(outcome).toEqual({state: 'denied', detail: 'access_denied'});
        expect(calls).toHaveLength(0);
    });

    it('does not forward Discord error bodies, which echo the client id', async () => {
        const {flow} = flowWith([
            {status: 400, body: {error: 'invalid_grant', error_description: 'client_id=client-id-1234'}}
        ]);

        const outcome = await flow.complete({
            accountUsername: 'alice',
            code: 'the-code',
            state: validState()
        });

        expect(outcome.state).toBe('refused');
        expect(JSON.stringify(outcome)).not.toContain('client-id-1234');
        expect(JSON.stringify(outcome)).not.toContain('invalid_grant');
    });

    it('degrades when Discord cannot be reached', async () => {
        const {flow} = flowWith([{status: 0, networkError: true}]);

        expect(await flow.complete({accountUsername: 'alice', code: 'c', state: validState()}))
            .toEqual({state: 'unavailable', detail: 'Discord could not be reached'});
    });

    it('degrades on a Discord server error rather than blaming the visitor', async () => {
        const {flow} = flowWith([{status: 503}]);

        expect(await flow.complete({accountUsername: 'alice', code: 'c', state: validState()}))
            .toEqual({state: 'unavailable', detail: 'Discord answered HTTP 503'});
    });

    it('refuses when the identity read returns no account', async () => {
        const {flow} = flowWith([
            {status: 200, body: {access_token: ACCESS_TOKEN}},
            {status: 200, body: {username: 'no-id-here'}}
        ]);

        expect(await flow.complete({accountUsername: 'alice', code: 'c', state: validState()}))
            .toEqual({state: 'refused', detail: 'Discord did not return an account'});
    });

    it('falls back to the handle when there is no display name, and bounds it', async () => {
        const {flow} = flowWith([
            {status: 200, body: {access_token: ACCESS_TOKEN}},
            {status: 200, body: {id: '1', username: 'x'.repeat(200), global_name: ''}}
        ]);

        const outcome = await flow.complete({accountUsername: 'alice', code: 'c', state: validState()});

        expect(outcome).toEqual({state: 'ok', identity: {id: '1', username: 'x'.repeat(64)}});
    });
});

describe('a callback for nobody', () => {
    // The binding failure the state exists to prevent, reached through the flow
    // rather than through the primitive.
    const unboundState = () =>
        signer.sign(JSON.stringify({n: 'nonce', u: '', e: Date.now() + 600_000}));

    it('REFUSES an empty session holding a state issued for an empty account', async () => {
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE);

        const outcome = await flow.complete({
            accountUsername: '',
            code: 'the-code',
            state: unboundState()
        });

        expect(outcome).toEqual({state: 'invalid-state', reason: 'unbound'});
        // Nothing was said to Discord: the state is checked before any
        // authorization code is exchanged, and an unbound one is no exception.
        expect(calls).toHaveLength(0);
    });

    it('REFUSES a real state arriving at a callback that resolved nobody', async () => {
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE);

        const outcome = await flow.complete({
            accountUsername: '   ',
            code: 'the-code',
            state: issueState('alice', signer) as string
        });

        expect(outcome).toEqual({state: 'invalid-state', reason: 'unbound'});
        expect(calls).toHaveLength(0);
    });

    it('writes nothing to the store for an unbound callback', async () => {
        // The outcome that matters: a Discord identity landing on an empty
        // account row, which is the row every signed-out visitor would share.
        const saves: unknown[] = [];
        const store: AccountLinkStore = {
            saveDiscordLink: async (input) => {
                saves.push(input);
                return {state: 'ok', value: null};
            },
            removeDiscordLink: async () => ({state: 'ok', value: {unlinked: true}})
        };
        const {flow, calls} = flowWith(SUCCESSFUL_EXCHANGE, store);

        const outcome = await flow.link({accountUsername: '', code: 'the-code', state: unboundState()});

        expect(outcome).toEqual({state: 'invalid-state', reason: 'unbound'});
        expect(saves).toEqual([]);
        expect(calls).toHaveLength(0);
    });
});

describe('the access token never escapes', () => {
    const validState = () => issueState('alice', signer) as string;

    // Every path through the exchange, swept for the token: what is returned,
    // and what is thrown. Nothing in this package throws on a Discord failure,
    // so there is no stack trace carrying a bearer header either.
    const paths: Array<[string, StubResponse[]]> = [
        ['success', SUCCESSFUL_EXCHANGE],
        ['token refused', [{status: 400, body: {error: 'invalid_grant', access_token: ACCESS_TOKEN}}]],
        ['token endpoint down', [{status: 500}]],
        ['token endpoint unreachable', [{status: 0, networkError: true}]],
        ['token endpoint not json', [{status: 200, invalidJson: true}]],
        ['identity refused', [{status: 200, body: {access_token: ACCESS_TOKEN}}, {status: 401, body: {}}]],
        ['identity down', [{status: 200, body: {access_token: ACCESS_TOKEN}}, {status: 500}]],
        ['identity unreachable', [
            {status: 200, body: {access_token: ACCESS_TOKEN}},
            {status: 0, networkError: true}
        ]],
        ['identity not json', [
            {status: 200, body: {access_token: ACCESS_TOKEN}},
            {status: 200, invalidJson: true}
        ]]
    ];

    for (const [name, responses] of paths) {
        it(`is absent from the value returned on: ${name}`, async () => {
            const {flow} = flowWith(responses);
            let thrown: unknown = null;
            let outcome: unknown = null;
            try {
                outcome = await flow.complete({accountUsername: 'alice', code: 'c', state: validState()});
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBeNull();
            expect(JSON.stringify(outcome)).not.toContain(ACCESS_TOKEN);
            expect(JSON.stringify(outcome)).not.toContain(CONFIG.clientSecret);
        });
    }

    it('is absent from everything handed to the link store', async () => {
        const seen: unknown[] = [];
        const store: AccountLinkStore = {
            saveDiscordLink: async (input) => {
                seen.push(input);
                return {state: 'ok', value: null};
            },
            removeDiscordLink: async () => ({state: 'ok', value: {unlinked: true}})
        };
        const {flow} = flowWith(SUCCESSFUL_EXCHANGE, store);

        await flow.link({accountUsername: 'alice', code: 'the-code', state: validState()});

        expect(seen).toEqual([
            {accountUsername: 'alice', identity: {id: '112233445566778899', username: 'Alice'}}
        ]);
        // Asserted over the whole recorded input, because the failure being
        // guarded against is somebody adding the token "for debugging".
        expect(JSON.stringify(seen)).not.toContain(ACCESS_TOKEN);
        expect(JSON.stringify(seen)).not.toContain(CONFIG.clientSecret);
    });
});

describe('recording and removing the link', () => {
    const validState = () => issueState('alice', signer) as string;

    const storeReturning = (
        save: LinkOutcome<null>,
        remove: LinkOutcome<{unlinked: boolean}> = {state: 'ok', value: {unlinked: true}}
    ): AccountLinkStore => ({
        saveDiscordLink: async () => save,
        removeDiscordLink: async () => remove
    });

    it('reports a taken Discord account as an actionable refusal, not a failure', async () => {
        const {flow} = flowWith(SUCCESSFUL_EXCHANGE, storeReturning({
            state: 'refused',
            status: 409,
            code: 'identity_already_linked',
            message: 'That Discord account is already linked to another member.'
        }));

        expect(await flow.link({accountUsername: 'alice', code: 'c', state: validState()})).toEqual({
            state: 'refused',
            status: 409,
            code: 'identity_already_linked',
            detail: 'That Discord account is already linked to another member.'
        });
    });

    it('marks a Discord refusal as having no machine code of its own', async () => {
        const {flow} = flowWith([{status: 400, body: {error: 'invalid_grant'}}], storeReturning({state: 'ok', value: null}));

        expect(await flow.link({accountUsername: 'alice', code: 'c', state: validState()})).toEqual({
            state: 'refused',
            detail: 'Discord did not accept that authorisation',
            code: null,
            status: null
        });
    });

    it('does not write to the store when the state was invalid', async () => {
        let written = false;
        const store: AccountLinkStore = {
            saveDiscordLink: async () => {
                written = true;
                return {state: 'ok', value: null};
            },
            removeDiscordLink: async () => ({state: 'ok', value: {unlinked: true}})
        };
        const {flow} = flowWith(SUCCESSFUL_EXCHANGE, store);

        await flow.link({accountUsername: 'alice', code: 'c', state: issueState('mallory', signer) as string});

        expect(written).toBe(false);
    });

    it('unlinks even when the Discord application is gone', async () => {
        // An operator who removes the application must not strand people who
        // are already linked, so unlink is deliberately outside the gate.
        const flow = createDiscordLinkFlow({
            config: null,
            signer: null,
            store: storeReturning({state: 'ok', value: null})
        });

        expect(flow.configured()).toBe(false);
        expect(await flow.unlink('alice')).toEqual({state: 'ok', value: {unlinked: true}});
    });

    it('treats unlinking something already unlinked as an ordinary success', async () => {
        const flow = createDiscordLinkFlow({
            config: CONFIG,
            signer,
            store: storeReturning({state: 'ok', value: null}, {state: 'ok', value: {unlinked: false}})
        });

        expect(await flow.unlink('alice')).toEqual({state: 'ok', value: {unlinked: false}});
    });

    it('says so plainly when no store was provided', async () => {
        const {flow} = flowWith(SUCCESSFUL_EXCHANGE);

        expect((await flow.link({accountUsername: 'alice', code: 'c', state: validState()})).state)
            .toBe('unavailable');
        expect((await flow.unlink('alice')).state).toBe('unavailable');
    });
});

describe('Discord is a link, not a login', () => {
    it('has no function that turns a Discord identity into a session', async () => {
        const {flow} = flowWith(SUCCESSFUL_EXCHANGE);
        const outcome = await flow.complete({
            accountUsername: 'alice',
            code: 'c',
            state: issueState('alice', signer) as string
        });

        // The flow's whole product is an id and a name. There is no token, no
        // session, and no cookie anywhere in what it hands back.
        expect(Object.keys((outcome as {identity: object}).identity).sort()).toEqual(['id', 'username']);
        expect(Object.keys(flow)).not.toContain('signIn');
    });
});
