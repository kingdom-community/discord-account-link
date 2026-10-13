import {describe, expect, it} from 'vitest';

import {
    DEFAULT_CALLBACK_PATH,
    DISCORD_IDENTITY_URL,
    DISCORD_TOKEN_URL,
    STATE_TTL_MS,
    discordLinkConfigFromEnv,
    discordLinkFlowFromEnv,
    discordLinkingConfigured,
    type AccountLinkStore,
    type EnvSource,
    type FromEnvOptions
} from '../src/index.js';
import {stubFetch} from './support/fetchStub.js';

// The gate. Deployments with no Discord application are ordinary, and the
// library has to be usable in one: hide the affordance rather than offering a
// flow that dies at the redirect.

const FULL: EnvSource = {
    DISCORD_CLIENT_ID: 'client-id-1234',
    DISCORD_CLIENT_SECRET: 'client-secret-abcd',
    DISCORD_STATE_SECRET: 'state-secret-0123456789',
    SITE_BASE_URL: 'https://community.example'
};

const without = (name: string): EnvSource => {
    const env = {...FULL};
    delete env[name];
    return env;
};

describe('reading the configuration', () => {
    it('builds the redirect uri from the base url and the callback path', () => {
        expect(discordLinkConfigFromEnv(FULL)).toEqual({
            clientId: 'client-id-1234',
            clientSecret: 'client-secret-abcd',
            redirectUri: `https://community.example${DEFAULT_CALLBACK_PATH}`
        });
    });

    it('tolerates a trailing slash on the base url', () => {
        const config = discordLinkConfigFromEnv({...FULL, SITE_BASE_URL: 'https://community.example/'});

        expect(config?.redirectUri).toBe(`https://community.example${DEFAULT_CALLBACK_PATH}`);
    });

    it('accepts an overridden callback path, with or without a leading slash', () => {
        expect(discordLinkConfigFromEnv({...FULL, DISCORD_CALLBACK_PATH: '/oauth/discord'})?.redirectUri)
            .toBe('https://community.example/oauth/discord');
        expect(discordLinkConfigFromEnv({...FULL, DISCORD_CALLBACK_PATH: 'oauth/discord'})?.redirectUri)
            .toBe('https://community.example/oauth/discord');
    });

    it('refuses to guess a base url', () => {
        // A wrong canonical URL elsewhere on a site is cosmetic; a wrong OAuth
        // redirect is a broken flow at best.
        expect(discordLinkConfigFromEnv(without('SITE_BASE_URL'))).toBeNull();
    });

    it('treats whitespace as absence', () => {
        expect(discordLinkConfigFromEnv({...FULL, DISCORD_CLIENT_ID: '   '})).toBeNull();
    });
});

describe('discordLinkingConfigured', () => {
    it('is true only when every part is present', () => {
        expect(discordLinkingConfigured(FULL)).toBe(true);
    });

    it.each([
        'DISCORD_CLIENT_ID',
        'DISCORD_CLIENT_SECRET',
        'DISCORD_STATE_SECRET',
        'SITE_BASE_URL'
    ])('is false without %s', (name) => {
        expect(discordLinkingConfigured(without(name))).toBe(false);
        expect(discordLinkingConfigured({...FULL, [name]: ''})).toBe(false);
    });

    it('is false in an empty environment, which is the common case', () => {
        expect(discordLinkingConfigured({})).toBe(false);
    });
});

describe('building a flow from the environment', () => {
    it('is switched off when the environment says so', () => {
        expect(discordLinkFlowFromEnv({env: {}}).configured()).toBe(false);
        expect(discordLinkFlowFromEnv({env: without('DISCORD_STATE_SECRET')}).configured()).toBe(false);
    });

    it('is switched on when the environment is complete', () => {
        expect(discordLinkFlowFromEnv({env: FULL}).configured()).toBe(true);
    });

    it('never reads the state secret when a signer is injected', () => {
        // The coupling this design removes: a site that already signs values for
        // browsers keeps one secret instead of two.
        const flow = discordLinkFlowFromEnv({
            env: without('DISCORD_STATE_SECRET'),
            signer: {
                sign: (payload) => `signed:${payload}`,
                verify: (token) => token.startsWith('signed:')
                    ? {ok: true, payload: token.slice('signed:'.length)}
                    : {ok: false, reason: 'bad-signature'}
            }
        });

        expect(flow.configured()).toBe(true);
    });

    it('names its options type on the public surface, so a wrapper can be typed', () => {
        // The type is imported from the barrel above rather than from a module
        // path, because the package publishes exactly one entry point and a
        // consumer has no other way to reach it.
        const options: FromEnvOptions = {env: FULL};
        const wrapped = (given: FromEnvOptions) => discordLinkFlowFromEnv(given);

        expect(wrapped(options).configured()).toBe(true);
    });

    it('stays off when a null signer is passed, even against a complete environment', () => {
        // An omitted signer means "read the secret"; an explicit null means "there
        // is no signer", and an unsigned state is the one thing this flow must
        // never accept — so the environment does not get to override it.
        expect(discordLinkFlowFromEnv({env: FULL, signer: null}).configured()).toBe(false);
    });

    it('sends the browser to the redirect uri the environment describes', () => {
        const begun = discordLinkFlowFromEnv({env: {...FULL, DISCORD_CALLBACK_PATH: '/oauth/discord'}})
            .begin('alice');
        if (begun.state !== 'ok') {
            throw new Error(`expected an authorize url, got ${begun.state}`);
        }
        const parameters = new URL(begun.url).searchParams;

        expect(parameters.get('client_id')).toBe('client-id-1234');
        expect(parameters.get('redirect_uri')).toBe('https://community.example/oauth/discord');
    });

    it('hands the injected fetch and store through to the flow', async () => {
        // Were either dropped on the way through, the first would mean a real
        // request to Discord and the second a link that is never recorded.
        const {calls, fetchImpl} = stubFetch([
            {status: 200, body: {access_token: 'discord-access-token-do-not-leak', token_type: 'Bearer'}},
            {status: 200, body: {id: '112233445566778899', username: 'alice_mc', global_name: 'Alice'}}
        ]);
        const saved: unknown[] = [];
        const store: AccountLinkStore = {
            saveDiscordLink: async (input) => {
                saved.push(input);
                return {state: 'ok', value: null};
            },
            removeDiscordLink: async () => ({state: 'ok', value: {unlinked: true}})
        };
        const flow = discordLinkFlowFromEnv({env: FULL, fetchImpl, store});
        const begun = flow.begin('alice');
        if (begun.state !== 'ok') {
            throw new Error(`expected an authorize url, got ${begun.state}`);
        }

        const outcome = await flow.link({accountUsername: 'alice', code: 'the-code', state: begun.oauthState});

        const identity = {id: '112233445566778899', username: 'Alice'};
        expect(outcome).toEqual({state: 'ok', identity});
        expect(calls.map((call) => call.url)).toEqual([DISCORD_TOKEN_URL, DISCORD_IDENTITY_URL]);
        expect(saved).toEqual([{accountUsername: 'alice', identity}]);
    });

    it('reads the time from the injected clock', async () => {
        // The state is issued and checked against the same clock. Were the
        // clock dropped, both would read the wall clock, the state would still
        // be fresh, and the code would be exchanged.
        let clock = 1_000_000;
        const {calls, fetchImpl} = stubFetch([]);
        const flow = discordLinkFlowFromEnv({env: FULL, fetchImpl, now: () => clock});
        const begun = flow.begin('alice');
        if (begun.state !== 'ok') {
            throw new Error(`expected an authorize url, got ${begun.state}`);
        }

        clock += STATE_TTL_MS;

        expect(await flow.complete({accountUsername: 'alice', code: 'the-code', state: begun.oauthState}))
            .toEqual({state: 'invalid-state', reason: 'expired'});
        expect(calls).toHaveLength(0);
    });
});
