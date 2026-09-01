// Resolving the session for the linking routes, in one place.
//
// Every linking route needs the same two things: who is signed in, and the
// bearer token to act on their behalf. The second is the reason this exists at
// all rather than being "read the cookie": an access token can be silently
// rotated while a request is being served, and forwarding the OLD token after a
// rotation would fail against the back end for a session that is in fact
// perfectly valid.
//
// Pure of the network — the caller passes the resolved session in — so it stays
// testable without stubbing fetch.

export interface ActiveSession {
    // The canonical account identifier. This is what the OAuth `state` is bound
    // to, so it must be stable across a token rotation.
    username: string;
    // The token to forward: the rotated one if the session was just renewed,
    // otherwise the one the cookie carried.
    token: string;
}

// Whatever your session layer produced for this request, narrowed to the two
// facts this package needs.
export interface ResolvedSessionLike {
    // Null when nobody is signed in, or when the session could not be checked.
    username: string | null | undefined;
    // Set only when the session was renewed while serving this request.
    rotatedToken?: string | null;
}

export const activeSessionFrom = (
    resolved: ResolvedSessionLike,
    cookieToken: string | null | undefined
): ActiveSession | null => {
    if (!resolved.username) {
        return null;
    }
    const token = resolved.rotatedToken ?? cookieToken;
    if (!token) {
        return null;
    }
    return {username: resolved.username, token};
};
