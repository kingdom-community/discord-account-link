// The link/unlink lifecycle, expressed as a port.
//
// Where the link is RECORDED is your business: a table, an internal API, a
// key-value store. This package only insists on the vocabulary, because the
// vocabulary is the part that gets it wrong when it is ad hoc.
//
// THE OUTCOMES ARE KEPT DISTINCT ALL THE WAY UP TO THE ROUTE, because they
// render differently. A conflict in particular is not an error to apologise
// for: it is the system telling somebody that the identity they are claiming is
// already somebody else's, or that their account already has a link, and the
// message should say which.
//
// WHAT IS DELIBERATELY NOT HERE: anything that redeems a code issued elsewhere,
// and anything that turns a Discord identity into a session. Discord linking is
// a LINK, not a login. There is no function in this package that mints a
// session, and adding one would put a second door on the most sensitive write
// in the system.

import type {DiscordIdentity} from './discordOAuth.js';

export type LinkOutcome<T> =
    | {state: 'ok'; value: T}
    // Nobody is signed in, or the session expired mid-flow.
    | {state: 'unauthenticated'}
    // Refused for a reason the person can act on: the identity is taken, this
    // account already has a link. `code` is a machine code and `message` is a
    // sentence written by whatever refused, forwarded rather than rewritten so
    // the two do not drift apart.
    | {state: 'refused'; status: number; code: string; message: string}
    | {state: 'unavailable'; detail: string};

export interface AccountLinkStore {
    // Record a Discord identity against an account. The identity has ALREADY
    // been verified against Discord by the time this is called; the store is
    // trusted to persist it, not to re-check it.
    //
    // Implementations should treat a conflict as `refused`, not as a throw: two
    // people trying to claim one Discord account is an ordinary Tuesday.
    saveDiscordLink(input: {
        accountUsername: string;
        identity: DiscordIdentity;
    }): Promise<LinkOutcome<null>>;

    // Remove the link. Idempotent: unlinking something already unlinked is an
    // `ok` with `unlinked: false`, not a 404. The caller asked for a state and
    // got it, and treating a double-click as an error makes a working thing look
    // broken.
    removeDiscordLink(input: {
        accountUsername: string;
    }): Promise<LinkOutcome<{unlinked: boolean}>>;
}

const asRecord = (body: unknown): Record<string, unknown> | null =>
    body && typeof body === 'object' ? (body as Record<string, unknown>) : null;

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

export const refusalFrom = (status: number, body: unknown): LinkOutcome<never> => {
    const record = asRecord(body);
    return {
        state: 'refused',
        status,
        code: text(record?.error, 'refused'),
        message: text(record?.message, 'That could not be done.')
    };
};

export interface LinkHttpResponse {
    status: number;
    body: unknown;
}

export interface LinkResponseMapping<T> {
    // Reads the success body. Return null when the shape is not recognised —
    // that is an `unavailable`, not a crash, because a back end that changed its
    // response shape is an outage from the visitor's point of view.
    read: (body: unknown) => T | null;
    okStatuses?: number[];
    // Statuses that mean "no, and here is why, and it is actionable".
    refusalStatuses?: number[];
    // Named in `unavailable` details. Keep it something an operator recognises
    // and a visitor is not harmed by seeing; never an internal hostname.
    upstreamName?: string;
}

// The status-to-outcome decision, written once.
//
// Most stores are an HTTP call to your own account service, and every one of
// them makes the same handful of decisions. Anything unmapped is `unavailable`
// rather than `refused`, because a status nobody planned for is not something to
// tell a visitor they can fix.
export const linkOutcomeFrom = <T>(
    response: LinkHttpResponse,
    mapping: LinkResponseMapping<T>
): LinkOutcome<T> => {
    const upstream = mapping.upstreamName ?? 'the account service';
    const okStatuses = mapping.okStatuses ?? [200, 201];
    const refusalStatuses = mapping.refusalStatuses ?? [400, 403, 409];

    if (okStatuses.includes(response.status)) {
        const value = mapping.read(response.body);
        if (value === null) {
            return {state: 'unavailable', detail: `${upstream} answered with an unrecognised shape`};
        }
        return {state: 'ok', value};
    }
    if (response.status === 401) {
        return {state: 'unauthenticated'};
    }
    if (refusalStatuses.includes(response.status)) {
        return refusalFrom(response.status, response.body);
    }
    return {state: 'unavailable', detail: `${upstream} answered HTTP ${response.status}`};
};
