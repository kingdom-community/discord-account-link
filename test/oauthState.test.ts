import {describe, expect, it} from 'vitest';

import {createHmacStateSigner} from '../src/stateSigner.js';
import {STATE_TTL_MS, issueState, verifyState} from '../src/oauthState.js';

// The signed OAuth `state`, which is the ONLY thing standing between the Discord
// callback and somebody attaching their Discord id to another person's account.
// Every test here is a specific attack or a specific misconfiguration.

const SECRET = 'a-secret-nobody-else-has-0123456789';
const signer = createHmacStateSigner(SECRET)!;

describe('issuing a state', () => {
    it('produces a signed, opaque value', () => {
        const state = issueState('alice', signer);

        expect(state).toBeTruthy();
        expect(state).toContain('.');
        // The username is inside the signed payload rather than in the clear.
        expect(state).not.toContain('alice');
    });

    it('never repeats, so two flows started in the same moment are distinct', () => {
        const first = issueState('alice', signer, 1_000_000);
        const second = issueState('alice', signer, 1_000_000);

        expect(first).not.toEqual(second);
    });

    it('returns null when there is no signer', () => {
        // The caller's cue to answer 503. An unsigned state is the one thing
        // this flow must never send to Discord.
        expect(issueState('alice', null)).toBeNull();
        expect(issueState('alice', undefined)).toBeNull();
    });

    it('REFUSES an empty or whitespace-only account, which binds to nothing', () => {
        // `session?.username ?? ''` is ordinary defensive code in a calling
        // route, and it is how an unbound state gets minted: every signed-out
        // browser shares the empty value, so each holds a state that verifies
        // against the others. The value must never come into existence.
        expect(issueState('', signer)).toBeNull();
        expect(issueState('   ', signer)).toBeNull();
        expect(issueState('\t\n', signer)).toBeNull();
        // Not an over-broad rule: a real account still gets one.
        expect(issueState('alice', signer)).toBeTruthy();
        expect(issueState(' alice ', signer)).toBeTruthy();
    });
});

describe('building the default signer', () => {
    it('is null when the secret is unset, blank or whitespace', () => {
        expect(createHmacStateSigner(undefined)).toBeNull();
        expect(createHmacStateSigner(null)).toBeNull();
        expect(createHmacStateSigner('')).toBeNull();
        expect(createHmacStateSigner('   ')).toBeNull();
    });
});

describe('verifying a state', () => {
    it('accepts one this site issued for this session', () => {
        const state = issueState('alice', signer) as string;

        expect(verifyState(state, 'alice', signer)).toEqual({ok: true, username: 'alice'});
    });

    it('REJECTS a callback with no state at all', () => {
        // The case a naive implementation waves through, because there is
        // nothing to compare and therefore nothing to mismatch.
        expect(verifyState(undefined, 'alice', signer)).toEqual({ok: false, reason: 'malformed'});
        expect(verifyState('', 'alice', signer)).toEqual({ok: false, reason: 'malformed'});
        expect(verifyState(null, 'alice', signer)).toEqual({ok: false, reason: 'malformed'});
    });

    it('REJECTS an unsigned state', () => {
        const unsigned = Buffer.from(JSON.stringify({n: 'x', u: 'alice', e: Date.now() + 60_000}))
            .toString('base64')
            .replace(/=+$/, '');

        expect(verifyState(unsigned, 'alice', signer)).toEqual({ok: false, reason: 'malformed'});
        expect(verifyState(`${unsigned}.`, 'alice', signer)).toEqual({ok: false, reason: 'malformed'});
        expect(verifyState(`${unsigned}.not-a-signature`, 'alice', signer))
            .toEqual({ok: false, reason: 'bad-signature'});
    });

    it('REJECTS a state signed with a different secret', () => {
        const state = issueState('alice', createHmacStateSigner('some-other-secret')!) as string;

        expect(verifyState(state, 'alice', signer)).toEqual({ok: false, reason: 'bad-signature'});
    });

    it('REJECTS a state whose payload was edited', () => {
        // Signature is checked BEFORE the payload is parsed, so a tampered
        // payload never reaches JSON.parse.
        const state = issueState('alice', signer) as string;
        const [payload, signature] = state.split('.');
        const forged = Buffer.from(JSON.stringify({n: 'x', u: 'mallory', e: Date.now() + 60_000}))
            .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        expect(payload).not.toEqual(forged);
        expect(verifyState(`${forged}.${signature}`, 'mallory', signer))
            .toEqual({ok: false, reason: 'bad-signature'});
    });

    it('REJECTS A STATE BOUND TO A DIFFERENT SESSION', () => {
        // THE attack this exists for. An attacker starts the flow themselves,
        // gets a perfectly valid signed state, and tries to finish it against
        // somebody else's session so that THEIR Discord id lands on the victim's
        // profile. The signature does not stop that; the binding does.
        const attackersState = issueState('mallory', signer) as string;

        expect(verifyState(attackersState, 'alice', signer)).toEqual({ok: false, reason: 'wrong-session'});
    });

    it('rejects an expired state', () => {
        const state = issueState('alice', signer, 1_000_000) as string;

        expect(verifyState(state, 'alice', signer, 1_000_000 + STATE_TTL_MS - 1)).toEqual({
            ok: true,
            username: 'alice'
        });
        expect(verifyState(state, 'alice', signer, 1_000_000 + STATE_TTL_MS + 1))
            .toEqual({ok: false, reason: 'expired'});
    });

    it('rejects everything when there is no signer, rather than accepting anything', () => {
        const state = issueState('alice', signer) as string;

        expect(verifyState(state, 'alice', null)).toEqual({ok: false, reason: 'not-configured'});
        expect(verifyState(state, 'alice', undefined)).toEqual({ok: false, reason: 'not-configured'});
    });

    it('does not throw on a state of a different length from the expected signature', () => {
        // node's timingSafeEqual THROWS on differing lengths, which would turn a
        // forged state into a 500 and leak the expected length through the
        // difference between an error page and a redirect.
        expect(() => verifyState('a.b', 'alice', signer)).not.toThrow();
        expect(() => verifyState('....', 'alice', signer)).not.toThrow();
        expect(() => verifyState('x'.repeat(5000), 'alice', signer)).not.toThrow();
    });

    it('rejects a validly signed token whose payload is not a state', () => {
        // A signer shared with the rest of the site will happily sign other
        // things. Being signed by us is necessary, not sufficient.
        expect(verifyState(signer.sign('not json at all'), 'alice', signer))
            .toEqual({ok: false, reason: 'malformed'});
        expect(verifyState(signer.sign(JSON.stringify({u: 'alice'})), 'alice', signer))
            .toEqual({ok: false, reason: 'malformed'});
        expect(verifyState(signer.sign(JSON.stringify({u: 42, e: Date.now() + 1000})), 'alice', signer))
            .toEqual({ok: false, reason: 'malformed'});
    });

    it('takes the first value when a query string repeats the parameter', () => {
        const state = issueState('alice', signer) as string;

        expect(verifyState([state, 'junk'], 'alice', signer)).toEqual({ok: true, username: 'alice'});
        expect(verifyState(['junk', state], 'alice', signer)).toEqual({ok: false, reason: 'malformed'});
    });

    it('REFUSES a state bound to an empty account, against an empty session', () => {
        // The attack this whole module exists to stop, reached without forging
        // anything. The state is hand-signed rather than issued, because
        // `issueState` no longer mints one — and `verifyState` is a published
        // entry point that also takes states from an injected signer, so it
        // refuses the value rather than trusting that nobody produced it.
        const unbound = signer.sign(JSON.stringify({n: 'nonce', u: '', e: Date.now() + STATE_TTL_MS}));

        // Emphatically NOT {ok: true, username: ''}.
        expect(verifyState(unbound, '', signer)).toEqual({ok: false, reason: 'unbound'});
        expect(verifyState(unbound, 'alice', signer)).toEqual({ok: false, reason: 'unbound'});
    });

    it('REFUSES an empty or whitespace-only session, whatever the state says', () => {
        // The other end of the same hole: a real state, and a callback route
        // that resolved nobody. There is nothing to bind to, so nothing is
        // accepted.
        const state = issueState('alice', signer) as string;

        expect(verifyState(state, '', signer)).toEqual({ok: false, reason: 'unbound'});
        expect(verifyState(state, '   ', signer)).toEqual({ok: false, reason: 'unbound'});
    });

    it('calls a whitespace-only binding unbound rather than merely mismatched', () => {
        // Two blank values are not two accounts that disagree, and an operator
        // reading `wrong-session` in a log would go looking for an attacker
        // instead of for the route that passed nothing.
        const blank = signer.sign(JSON.stringify({n: 'nonce', u: '  ', e: Date.now() + STATE_TTL_MS}));

        expect(verifyState(blank, '  ', signer)).toEqual({ok: false, reason: 'unbound'});
    });

    it('still reports two real accounts that disagree as the wrong session', () => {
        // The refusal above must not have swallowed the ordinary mismatch.
        const state = issueState('alice', signer) as string;

        expect(verifyState(state, 'mallory', signer)).toEqual({ok: false, reason: 'wrong-session'});
    });

    it('accepts an injected signer that is not the HMAC one', () => {
        // The point of the port: a site with its own signing helper keeps one
        // secret instead of two.
        const prefixSigner = {
            sign: (payload: string) => `signed:${payload}`,
            verify: (token: string) => token.startsWith('signed:')
                ? {ok: true as const, payload: token.slice('signed:'.length)}
                : {ok: false as const, reason: 'bad-signature' as const}
        };
        const state = issueState('alice', prefixSigner) as string;

        expect(verifyState(state, 'alice', prefixSigner)).toEqual({ok: true, username: 'alice'});
        expect(verifyState('nope', 'alice', prefixSigner)).toEqual({ok: false, reason: 'bad-signature'});
    });
});
