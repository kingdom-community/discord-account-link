// Framework-agnostic decision tables for the two routes this flow needs.
//
// These return a status and a body rather than writing to a response, because
// the plumbing around them — cookies, cross-origin checks, session resolution,
// method allow-lists — belongs to your framework and differs between all of
// them. What does NOT differ is which outcome deserves which status, and that
// is the part worth writing once.
//
// Two rules are baked in and are worth stating:
//
//   * An unlink is a state change, so whatever calls this should apply the same
//     cross-origin check as every other state change. A cross-site page silently
//     detaching somebody's verified identity is a small attack, but it is still
//     an attack.
//   * A "not configured" answer is 503, not 404 and not 500. Nothing is broken
//     and nothing is missing; the feature is switched off.

import type {LinkFlowOutcome} from './flow.js';
import type {LinkOutcome} from './linkStore.js';

export interface RouteResponse {
    status: number;
    body: Record<string, unknown>;
    // Always. None of these answers is cacheable, and one of them is a redirect
    // carrying a one-time state.
    headers: {'Cache-Control': 'no-store'};
}

const answer = (status: number, body: Record<string, unknown>): RouteResponse =>
    ({status, body, headers: {'Cache-Control': 'no-store'}});

// What to answer at the end of the callback route.
//
// The visitor-facing sentences are deliberately identical for every state
// failure — missing, forged, expired, wrong session — because they mean the
// same thing to the person and different things only to an operator reading
// logs. `reason` is carried in the body for that operator, not for the page.
export const callbackResponse = (outcome: LinkFlowOutcome): RouteResponse => {
    switch (outcome.state) {
        case 'ok':
            return answer(200, {linked: true, discord: {id: outcome.identity.id, username: outcome.identity.username}});
        case 'not-configured':
            return answer(503, {
                error: 'discord_linking_unavailable',
                message: 'Discord linking is not available on this site.'
            });
        case 'denied':
            return answer(400, {
                error: 'consent_denied',
                message: 'Discord linking was cancelled. Nothing has changed on your account.'
            });
        case 'invalid-state':
            return answer(400, {
                error: 'invalid_state',
                reason: outcome.reason,
                message: 'That link could not be completed. Please start again from your account page.'
            });
        case 'unauthenticated':
            return answer(401, {error: 'unauthenticated', message: 'You are not signed in.'});
        case 'refused':
            return answer(outcome.status ?? 400, {
                error: outcome.code ?? 'refused',
                message: outcome.detail
            });
        default:
            return answer(503, {
                error: 'discord_unavailable',
                message: 'Discord could not be reached right now. Please try again shortly.'
            });
    }
};

// What to answer at the end of an unlink route. `unlinked: false` is a 200:
// the caller asked for a state and got it, and a 404 here would make a
// double-click look broken.
export const unlinkResponse = (outcome: LinkOutcome<{unlinked: boolean}>): RouteResponse => {
    switch (outcome.state) {
        case 'ok':
            return answer(200, {provider: 'discord', unlinked: outcome.value.unlinked});
        case 'unauthenticated':
            return answer(401, {error: 'unauthenticated', message: 'You are not signed in.'});
        case 'refused':
            return answer(outcome.status, {error: outcome.code, message: outcome.message});
        default:
            return answer(503, {
                error: 'link_unavailable',
                message: 'Account linking is not available right now. Please try again shortly.'
            });
    }
};
