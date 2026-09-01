// The OAuth `state` this site issues to a browser and later checks.
//
// Pure — the signer is passed in, nothing here reads the environment or the
// network — so the rules below can be unit-tested including the cases that only
// happen when somebody is attacking them.
//
// WHY THE STATE IS BOUND TO THE SESSION RATHER THAN MERELY RANDOM.
//
// A random, unbound state stops a replayed callback. It does not stop the
// interesting attack, which is an attacker completing Discord's consent screen
// with THEIR account against YOUR session, landing their Discord id on your
// profile. Binding the state to the account the flow started as lets the
// callback check that the browser finishing the flow is the one that started it.
//
// Binding to a STABLE ACCOUNT IDENTIFIER rather than to a session token is
// deliberate. Session tokens rotate — an expired one may be silently renewed
// mid-request — so a state bound to the token would break for anybody whose
// session happened to refresh during the twenty seconds they spent on Discord's
// consent screen, and it would break in a way indistinguishable from an attack.
// A canonical username is stable, and is exactly the fact the check needs: this
// callback belongs to this account.
//
// The signature means no server-side state table is needed for a flow that is
// over in seconds, and no cleanup job for the rows it would leave behind.

import {randomBytes} from 'node:crypto';

import type {StateSigner} from './stateSigner.js';

// How long a `state` stays valid. A person clicking through Discord's consent
// screen takes seconds; ten minutes is generous for somebody who got distracted,
// and short enough that a state captured from a browser history or a proxy log
// is worthless by the time anybody reads it.
export const STATE_TTL_MS = 10 * 60 * 1000;

export type StateVerdict =
    | {ok: true; username: string}
    | {ok: false; reason: 'not-configured' | 'malformed' | 'bad-signature' | 'expired' | 'wrong-session'};

interface StatePayload {
    n?: unknown;
    u?: unknown;
    e?: unknown;
}

// A `state` for a flow started by `username`. Null when there is no signer,
// which is the caller's cue to answer 503 rather than to start a flow it cannot
// finish.
export const issueState = (
    username: string,
    signer: StateSigner | null | undefined,
    now: number = Date.now()
): string | null => {
    if (!signer) {
        return null;
    }
    // The nonce makes two states issued in the same millisecond for the same
    // account differ. It is not itself checked against anything — there is no
    // server-side table to check it against, by design — so its job is to keep
    // the signed payload from being a value somebody could accumulate copies of.
    return signer.sign(JSON.stringify({
        n: randomBytes(16).toString('hex'),
        u: username,
        e: now + STATE_TTL_MS
    }));
};

// Check a `state` coming back from Discord against the session finishing the
// flow.
//
// Every failure is a distinct reason, because they mean different things to an
// operator reading logs — a `bad-signature` is somebody probing, an `expired` is
// a person who left the tab open — and identical things to the visitor, who is
// told the flow could not be completed either way.
export const verifyState = (
    state: string | string[] | undefined | null,
    sessionUsername: string,
    signer: StateSigner | null | undefined,
    now: number = Date.now()
): StateVerdict => {
    if (!signer) {
        return {ok: false, reason: 'not-configured'};
    }
    const raw = Array.isArray(state) ? state[0] : state;
    if (!raw || typeof raw !== 'string') {
        // A callback with NO state at all is the case a naive implementation
        // waves through, because there is nothing to compare and nothing to
        // mismatch. It is rejected.
        return {ok: false, reason: 'malformed'};
    }

    const checked = signer.verify(raw);
    if (!checked.ok) {
        return {ok: false, reason: checked.reason};
    }

    let payload: StatePayload;
    try {
        payload = JSON.parse(checked.payload) as StatePayload;
    } catch {
        return {ok: false, reason: 'malformed'};
    }
    if (typeof payload.u !== 'string' || typeof payload.e !== 'number') {
        return {ok: false, reason: 'malformed'};
    }
    if (payload.e <= now) {
        return {ok: false, reason: 'expired'};
    }
    // THE BINDING. Without this line the state is merely unforgeable, and an
    // attacker who obtains one — by starting a flow themselves — can finish it
    // against somebody else's session and land their Discord id on that profile.
    if (payload.u !== sessionUsername) {
        return {ok: false, reason: 'wrong-session'};
    }
    return {ok: true, username: payload.u};
};
