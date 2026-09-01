// What the flow needs before it is allowed to exist, and how to read it from
// the environment.
//
// DEGRADATION IS THE DEFAULT STATE, NOT AN ERROR STATE. Plenty of deployments
// have no Discord application at all — nobody has registered one yet, or the
// site is running in a preview environment, or the operator simply does not
// want Discord linking. Nothing in a library can create an application, so the
// only honest behaviours are: hide the affordance, and refuse the route.
//
// `discordLinkingConfigured()` is therefore first-class API and is meant to be
// called in two places: before an affordance is RENDERED, and again before a
// route DOES anything. Hide the option rather than offering a flow that dies at
// the redirect.
//
// The state-signing secret is part of that same gate. Without it the `state`
// cannot be signed, and an unsigned `state` is the one thing this flow must
// never accept — so its absence disables Discord linking completely, and
// nothing else.

// The path Discord redirects back to. It must be registered, character for
// character, on the Discord application — a mismatch is refused by Discord with
// an error page your site never sees — so it is one constant rather than
// something assembled at three call sites.
export const DEFAULT_CALLBACK_PATH = '/api/v1/link/discord/callback';

export interface DiscordLinkConfig {
    clientId: string;
    clientSecret: string;
    // Absolute and public. Must match the Discord application exactly.
    redirectUri: string;
}

// The environment variable names read by `discordLinkConfigFromEnv`.
export const ENV_CLIENT_ID = 'DISCORD_CLIENT_ID';
export const ENV_CLIENT_SECRET = 'DISCORD_CLIENT_SECRET';
export const ENV_STATE_SECRET = 'DISCORD_STATE_SECRET';
export const ENV_BASE_URL = 'SITE_BASE_URL';
export const ENV_CALLBACK_PATH = 'DISCORD_CALLBACK_PATH';

export type EnvSource = Record<string, string | undefined>;

const value = (env: EnvSource, name: string): string => (env[name] ?? '').trim();

// Everything the exchange needs, or null. Null is the degraded state.
//
// The base URL is part of it because the redirect URI has to be an absolute,
// public URL and there is nothing sensible to invent when it is unset. In
// frameworks that inline public environment variables at BUILD time, an image
// built without one cannot acquire it by restarting — which is exactly why this
// returns null rather than guessing `http://localhost:3000`. A wrong canonical
// URL elsewhere on a site is cosmetic; a wrong OAuth redirect is a broken flow
// at best.
export const discordLinkConfigFromEnv = (
    env: EnvSource = process.env as EnvSource
): DiscordLinkConfig | null => {
    const clientId = value(env, ENV_CLIENT_ID);
    const clientSecret = value(env, ENV_CLIENT_SECRET);
    const baseUrl = value(env, ENV_BASE_URL).replace(/\/+$/, '');
    if (!clientId || !clientSecret || !baseUrl) {
        return null;
    }
    const path = value(env, ENV_CALLBACK_PATH) || DEFAULT_CALLBACK_PATH;
    return {
        clientId,
        clientSecret,
        redirectUri: `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    };
};

// The state-signing secret, or an empty string. Kept separate from the config
// because the signer is an injected dependency: a site with its own signing
// helper never reads this at all.
export const stateSecretFromEnv = (env: EnvSource = process.env as EnvSource): string =>
    value(env, ENV_STATE_SECRET);

// THE GATE. True only when the client id, the client secret, the base URL AND
// the state-signing secret are all present. Check it before rendering an
// affordance and again before a route acts.
export const discordLinkingConfigured = (
    env: EnvSource = process.env as EnvSource
): boolean => discordLinkConfigFromEnv(env) !== null && stateSecretFromEnv(env) !== '';
