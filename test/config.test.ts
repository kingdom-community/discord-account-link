import {describe, expect, it} from 'vitest';

import {
    DEFAULT_CALLBACK_PATH,
    discordLinkConfigFromEnv,
    discordLinkFlowFromEnv,
    discordLinkingConfigured,
    type EnvSource
} from '../src/index.js';

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
});
