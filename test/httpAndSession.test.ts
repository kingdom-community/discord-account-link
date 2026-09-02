import {describe, expect, it} from 'vitest';

import {
    activeSessionFrom,
    callbackResponse,
    linkOutcomeFrom,
    refusalFrom,
    unlinkResponse
} from '../src/index.js';

describe('the callback response table', () => {
    it('answers 503 rather than 404 or 500 when linking is switched off', () => {
        // Nothing is broken and nothing is missing; the feature is off.
        const response = callbackResponse({state: 'not-configured'});

        expect(response.status).toBe(503);
        expect(response.headers['Cache-Control']).toBe('no-store');
    });

    it('gives every state failure the same visitor-facing sentence', () => {
        const reasons = ['malformed', 'bad-signature', 'expired', 'wrong-session', 'not-configured'] as const;
        const messages = new Set(reasons.map((reason) =>
            callbackResponse({state: 'invalid-state', reason}).body.message));

        expect(messages.size).toBe(1);
        // The reason is carried for an operator reading logs, not for the page.
        expect(callbackResponse({state: 'invalid-state', reason: 'wrong-session'}).body.reason)
            .toBe('wrong-session');
    });

    it('does not treat a cancelled consent screen as a server problem', () => {
        expect(callbackResponse({state: 'denied', detail: 'access_denied'}).status).toBe(400);
    });

    it('forwards a store refusal with its own status and code', () => {
        const response = callbackResponse({
            state: 'refused',
            status: 409,
            code: 'identity_already_linked',
            detail: 'That Discord account is already linked to another member.'
        });

        expect(response.status).toBe(409);
        expect(response.body.error).toBe('identity_already_linked');
    });

    it('carries the identity and nothing else on success', () => {
        // Asserted over the WHOLE body: this is where a caller's response is
        // assembled, so a field nobody intended must not be able to appear here
        // unnoticed.
        const response = callbackResponse({state: 'ok', identity: {id: '9876', username: 'alice'}});

        expect(response.status).toBe(200);
        expect(response.body).toEqual({linked: true, discord: {id: '9876', username: 'alice'}});
    });

    it('is 401 when the session went away mid-flow', () => {
        const response = callbackResponse({state: 'unauthenticated'});

        expect(response.status).toBe(401);
        expect(response.body).toEqual({error: 'unauthenticated', message: 'You are not signed in.'});
    });

    it('falls back to 400 when Discord refused and there is no machine code', () => {
        // `flow.link` produces exactly this shape when DISCORD refused rather
        // than the store: Discord's error bodies are not forwarded, so there is
        // no status or code of its own to pass on.
        const response = callbackResponse({
            state: 'refused',
            detail: 'Discord did not accept that authorisation',
            code: null,
            status: null
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'refused',
            message: 'Discord did not accept that authorisation'
        });
    });

    it('answers 503 for an outage without repeating the operator detail', () => {
        const response = callbackResponse({state: 'unavailable', detail: 'https://discord.internal timed out'});

        expect(response.status).toBe(503);
        expect(response.body.error).toBe('discord_unavailable');
        expect(JSON.stringify(response.body)).not.toContain('discord.internal');
    });

    it('is never cacheable', () => {
        expect(callbackResponse({state: 'ok', identity: {id: '1', username: 'a'}}).headers)
            .toEqual({'Cache-Control': 'no-store'});
    });
});

describe('the unlink response table', () => {
    it('is a 200 when there was nothing linked', () => {
        // A 404 here would make a double-click look broken.
        const response = unlinkResponse({state: 'ok', value: {unlinked: false}});

        expect(response.status).toBe(200);
        expect(response.body).toEqual({provider: 'discord', unlinked: false});
    });

    it('is 401 when nobody is signed in', () => {
        expect(unlinkResponse({state: 'unauthenticated'}).status).toBe(401);
    });

    it('forwards a refusal with the sentence whatever refused wrote', () => {
        // The message is forwarded rather than rewritten so the machine code and
        // the sentence cannot drift apart.
        const response = unlinkResponse({
            state: 'refused',
            status: 403,
            code: 'link_locked',
            message: 'That link was locked by a moderator.'
        });

        expect(response.status).toBe(403);
        expect(response.body).toEqual({
            error: 'link_locked',
            message: 'That link was locked by a moderator.'
        });
    });

    it('never leaks an upstream detail into the body', () => {
        const response = unlinkResponse({state: 'unavailable', detail: 'http://accounts.internal:8080 refused'});

        expect(JSON.stringify(response.body)).not.toContain('accounts.internal');
    });
});

describe('mapping a store HTTP response to an outcome', () => {
    it('reads the success body', () => {
        expect(linkOutcomeFrom({status: 201, body: {ok: true}}, {read: () => null as never})).toEqual({
            state: 'unavailable',
            detail: 'the account service answered with an unrecognised shape'
        });
        expect(linkOutcomeFrom({status: 200, body: {unlinked: true}}, {
            read: (body) => ({unlinked: (body as {unlinked: boolean}).unlinked})
        })).toEqual({state: 'ok', value: {unlinked: true}});
    });

    it('distinguishes an actionable refusal from an outage', () => {
        expect(linkOutcomeFrom({status: 409, body: {error: 'taken', message: 'Already linked.'}}, {
            read: () => null
        })).toEqual({state: 'refused', status: 409, code: 'taken', message: 'Already linked.'});
        expect(linkOutcomeFrom({status: 502, body: null}, {read: () => null, upstreamName: 'the accounts API'}))
            .toEqual({state: 'unavailable', detail: 'the accounts API answered HTTP 502'});
        expect(linkOutcomeFrom({status: 401, body: null}, {read: () => null}))
            .toEqual({state: 'unauthenticated'});
    });

    it('honours a store that answers on statuses of its own', () => {
        // A delete that answers 204, and a validation failure the store wants
        // treated as actionable rather than as an outage.
        expect(linkOutcomeFrom({status: 204, body: null}, {
            read: () => ({unlinked: true}),
            okStatuses: [204]
        })).toEqual({state: 'ok', value: {unlinked: true}});
        expect(linkOutcomeFrom({status: 422, body: {error: 'not_a_handle', message: 'That is not a handle.'}}, {
            read: () => null,
            refusalStatuses: [422]
        })).toEqual({state: 'refused', status: 422, code: 'not_a_handle', message: 'That is not a handle.'});
        // A status the mapping did not name stays an outage, not something a
        // visitor is told they can fix.
        expect(linkOutcomeFrom({status: 409, body: null}, {read: () => null, refusalStatuses: [422]}))
            .toEqual({state: 'unavailable', detail: 'the account service answered HTTP 409'});
    });

    it('supplies a sentence when the refusal body carried none', () => {
        expect(refusalFrom(403, null))
            .toEqual({state: 'refused', status: 403, code: 'refused', message: 'That could not be done.'});
    });
});

describe('resolving the active session', () => {
    it('forwards the rotated token when the session was renewed mid-request', () => {
        // Forwarding the OLD token after a rotation fails against the back end
        // for a session that is in fact perfectly valid.
        expect(activeSessionFrom({username: 'alice', rotatedToken: 'new-token'}, 'old-token'))
            .toEqual({username: 'alice', token: 'new-token'});
    });

    it('falls back to the cookie token when nothing rotated', () => {
        expect(activeSessionFrom({username: 'alice'}, 'cookie-token'))
            .toEqual({username: 'alice', token: 'cookie-token'});
    });

    it('is null when nobody is signed in or there is no token to forward', () => {
        expect(activeSessionFrom({username: null}, 'cookie-token')).toBeNull();
        expect(activeSessionFrom({username: 'alice'}, null)).toBeNull();
        expect(activeSessionFrom({username: 'alice', rotatedToken: null}, undefined)).toBeNull();
    });
});
