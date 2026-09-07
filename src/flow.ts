// The two halves of the flow, as one object with a configuration gate on it.
//
// Half one, `begin`, happens when somebody clicks "Link Discord": issue a signed
// state bound to their account and hand back the URL to send them to. Half two,
// `complete`, happens when Discord redirects them back: check the state BEFORE
// talking to Discord, then exchange the code for an identity.
//
// The order in `complete` matters and is not an optimisation. Verifying the
// state first means a callback bound to somebody else's session never causes an
// authorization code to be exchanged at all.

import {
    authorizeUrl,
    exchangeCodeForIdentity,
    type DiscordIdentity,
    type ExchangeOptions,
    type FetchLike
} from './discordOAuth.js';
import type {DiscordLinkConfig} from './config.js';
import type {AccountLinkStore, LinkOutcome} from './linkStore.js';
import {issueState, unbindable, verifyState, type StateVerdict} from './oauthState.js';
import type {StateSigner} from './stateSigner.js';

export interface DiscordLinkFlowOptions {
    // Null when the deployment has no Discord application. Not an error.
    config: DiscordLinkConfig | null;
    // Null when there is no state-signing secret. Also not an error, and also
    // disabling: an unsigned state is the one thing this flow must never accept.
    signer: StateSigner | null;
    // Optional. Without it, `link` and `unlink` are unavailable and the caller
    // persists the verified identity itself.
    store?: AccountLinkStore;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: () => number;
}

export type BeginOutcome =
    | {state: 'ok'; url: string; oauthState: string}
    // Every caller must handle this, and the right handling is to hide the
    // affordance rather than to show an error.
    | {state: 'not-configured'}
    // Nobody is signed in, so there is no account to bind a state to. Named the
    // same as the `LinkFlowOutcome` member because it is the same fact, and the
    // right handling is a 401 rather than the 503 `not-configured` earns.
    | {state: 'unauthenticated'};

export type CompleteOutcome =
    | {state: 'ok'; identity: DiscordIdentity}
    | {state: 'not-configured'}
    // The person pressed Cancel on Discord's consent screen. An ordinary
    // outcome, not a failure, and nothing to apologise for.
    | {state: 'denied'; detail: string}
    // The state was missing, forged, expired, or bound to another session. All
    // of them look identical to the visitor and different to an operator.
    | {state: 'invalid-state'; reason: Extract<StateVerdict, {ok: false}>['reason']}
    | {state: 'refused'; detail: string}
    | {state: 'unavailable'; detail: string};

export type LinkFlowOutcome =
    | {state: 'ok'; identity: DiscordIdentity}
    | {state: 'not-configured'}
    | {state: 'denied'; detail: string}
    | {state: 'invalid-state'; reason: Extract<StateVerdict, {ok: false}>['reason']}
    | {state: 'unauthenticated'}
    // `code` and `status` are populated when the store refused; they are null
    // when Discord did, because Discord's error bodies are not forwarded.
    | {state: 'refused'; detail: string; code: string | null; status: number | null}
    | {state: 'unavailable'; detail: string};

export interface CallbackParameters {
    // The account the session says is finishing the flow. The state is checked
    // against THIS, so it must be a real account identifier: an empty or
    // whitespace-only value — what `session?.username ?? ''` yields for a
    // visitor who is not signed in — is refused as `invalid-state`/`unbound`
    // rather than matching another empty one.
    accountUsername: string;
    code?: string | string[] | null;
    state?: string | string[] | null;
    // Discord's `error` query parameter, forwarded as-is from the callback URL.
    error?: string | string[] | null;
}

export interface DiscordLinkFlow {
    // Check before rendering an affordance and again before a route acts.
    configured(): boolean;
    begin(accountUsername: string): BeginOutcome;
    complete(parameters: CallbackParameters): Promise<CompleteOutcome>;
    // `complete` plus a write to the store. Requires a store.
    link(parameters: CallbackParameters): Promise<LinkFlowOutcome>;
    // Requires a store, but NOT a Discord application: an operator who removes
    // the application must not strand people who are already linked, so this is
    // deliberately outside the configuration gate.
    unlink(accountUsername: string): Promise<LinkOutcome<{unlinked: boolean}>>;
}

const first = (value: string | string[] | null | undefined): string | null => {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' && raw !== '' ? raw : null;
};

export const createDiscordLinkFlow = (options: DiscordLinkFlowOptions): DiscordLinkFlow => {
    const {config, signer, store} = options;
    const now = options.now ?? (() => Date.now());
    const exchangeOptions: ExchangeOptions = {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs
    };

    const configured = (): boolean => config !== null && signer !== null;

    const complete = async (parameters: CallbackParameters): Promise<CompleteOutcome> => {
        if (!config || !signer) {
            return {state: 'not-configured'};
        }

        // Checked before the state, because a cancelled consent screen has no
        // code to exchange and telling somebody their state was invalid when
        // they simply pressed Cancel is a lie.
        const denied = first(parameters.error);
        if (denied) {
            return {state: 'denied', detail: denied};
        }

        // STATE FIRST, BEFORE ANY CALL TO DISCORD. A callback bound to a
        // different session must never cause an authorization code to be
        // exchanged.
        const verdict = verifyState(
            parameters.state ?? undefined,
            parameters.accountUsername,
            signer,
            now()
        );
        if (!verdict.ok) {
            return {state: 'invalid-state', reason: verdict.reason};
        }

        const code = first(parameters.code);
        if (!code) {
            return {state: 'refused', detail: 'Discord did not return an authorisation code'};
        }

        const exchange = await exchangeCodeForIdentity(config, code, exchangeOptions);
        if (exchange.state === 'ok') {
            return {state: 'ok', identity: exchange.identity};
        }
        return exchange;
    };

    return {
        configured,

        begin(accountUsername: string): BeginOutcome {
            if (!config || !signer) {
                return {state: 'not-configured'};
            }
            // Checked here rather than left to the null below, so that the
            // caller can tell "this deployment cannot link" from "you are not
            // signed in". A state bound to an empty account binds to nothing:
            // every other signed-out browser shares that value.
            if (unbindable(accountUsername)) {
                return {state: 'unauthenticated'};
            }
            const state = issueState(accountUsername, signer, now());
            if (!state) {
                // Unreachable while `signer` is non-null and the username is
                // bindable, and kept anyway: the alternative to this branch is
                // an authorize URL with an unsigned state in it.
                return {state: 'not-configured'};
            }
            return {state: 'ok', url: authorizeUrl(config, state), oauthState: state};
        },

        complete,

        async link(parameters: CallbackParameters): Promise<LinkFlowOutcome> {
            if (!store) {
                return {state: 'unavailable', detail: 'no account link store was provided'};
            }
            const completed = await complete(parameters);
            if (completed.state === 'refused') {
                return {state: 'refused', detail: completed.detail, code: null, status: null};
            }
            if (completed.state !== 'ok') {
                return completed;
            }

            const saved = await store.saveDiscordLink({
                accountUsername: parameters.accountUsername,
                identity: completed.identity
            });
            switch (saved.state) {
                case 'ok':
                    return {state: 'ok', identity: completed.identity};
                case 'refused':
                    return {
                        state: 'refused',
                        detail: saved.message,
                        code: saved.code,
                        status: saved.status
                    };
                default:
                    return saved;
            }
        },

        async unlink(accountUsername: string): Promise<LinkOutcome<{unlinked: boolean}>> {
            if (!store) {
                return {state: 'unavailable', detail: 'no account link store was provided'};
            }
            return store.removeDiscordLink({accountUsername});
        }
    };
};
