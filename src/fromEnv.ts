// The ordinary way to build the flow: read the environment, and get a flow that
// is already switched off if the environment says it should be.
//
// This is the only module that touches `process.env`, so "where is this value
// read" stays an answerable question. Everything else takes its configuration
// as an argument.

import {discordLinkConfigFromEnv, stateSecretFromEnv, type EnvSource} from './config.js';
import {createDiscordLinkFlow, type DiscordLinkFlow} from './flow.js';
import type {AccountLinkStore} from './linkStore.js';
import {createHmacStateSigner, type StateSigner} from './stateSigner.js';
import type {FetchLike} from './discordOAuth.js';

export interface FromEnvOptions {
    env?: EnvSource;
    store?: AccountLinkStore;
    // Bring your own signer and the state secret is never read from the
    // environment at all. Useful when the site already issues signed values to
    // browsers and would rather keep one secret than two.
    signer?: StateSigner | null;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: () => number;
}

export const discordLinkFlowFromEnv = (options: FromEnvOptions = {}): DiscordLinkFlow => {
    const env = options.env ?? (process.env as EnvSource);
    const signer = options.signer !== undefined
        ? options.signer
        : createHmacStateSigner(stateSecretFromEnv(env));
    return createDiscordLinkFlow({
        config: discordLinkConfigFromEnv(env),
        signer,
        store: options.store,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        now: options.now
    });
};
