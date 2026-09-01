// The signing port, and the default implementation of it.
//
// The OAuth `state` is the ONLY thing standing between the Discord callback and
// somebody attaching their Discord id to another person's account, so this
// package will not run the flow without a signer. It does not, however, insist
// on ITS signer: a site that already issues signed values to browsers almost
// certainly has an HMAC helper of its own, and asking it to keep a second
// secret for one query parameter is a needless operational hazard. So signing
// is an injected dependency with a two-method surface, and the HMAC
// implementation below is what you get when you do not bring your own.

import {createHmac, timingSafeEqual} from 'node:crypto';

// The result of checking a token that claims to have been signed by us.
export type StateSignatureCheck =
    // Structurally not one of ours: no separator, an empty half, undecodable.
    | {ok: false; reason: 'malformed'}
    // Well-formed and NOT ours. Somebody is probing.
    | {ok: false; reason: 'bad-signature'}
    | {ok: true; payload: string};

export interface StateSigner {
    // Wrap an opaque payload in a token this signer will later recognise.
    sign(payload: string): string;
    // Recover the payload, or say why it is not recoverable. MUST NOT throw on
    // arbitrary attacker-supplied input.
    verify(token: string): StateSignatureCheck;
}

// base64url, by hand rather than by dependency: two replaces and a strip.
const encode = (value: string): string =>
    Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const decode = (value: string): string =>
    Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

const hmac = (payload: string, secret: string): string =>
    createHmac('sha256', secret).update(payload).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Constant time, and length-safe: `timingSafeEqual` THROWS on differing
// lengths, which would turn a forged state into a 500 and leak the expected
// length through the difference between an error page and a redirect.
const equals = (a: string, b: string): boolean => {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
};

// An HMAC-SHA256 signer, or null when the secret is unset.
//
// NULL IS THE POINT. It is what makes "not configured" a value the rest of the
// package can carry around and check, rather than an exception thrown from
// somewhere deep in a redirect handler. An unsigned `state` is the one thing
// this flow must never accept, so the absence of a secret has to disable the
// flow rather than degrade it.
export const createHmacStateSigner = (secret: string | undefined | null): StateSigner | null => {
    if (typeof secret !== 'string' || secret.trim() === '') {
        return null;
    }
    return {
        sign(payload: string): string {
            const encoded = encode(payload);
            return `${encoded}.${hmac(encoded, secret)}`;
        },
        verify(token: string): StateSignatureCheck {
            if (typeof token !== 'string') {
                return {ok: false, reason: 'malformed'};
            }
            const separator = token.lastIndexOf('.');
            if (separator <= 0 || separator === token.length - 1) {
                return {ok: false, reason: 'malformed'};
            }
            const encoded = token.slice(0, separator);
            const signature = token.slice(separator + 1);
            // SIGNATURE FIRST, ALWAYS. Decoding attacker-controlled input before
            // checking that we wrote it is how a malformed payload becomes a
            // crash instead of a refusal.
            if (!equals(signature, hmac(encoded, secret))) {
                return {ok: false, reason: 'bad-signature'};
            }
            return {ok: true, payload: decode(encoded)};
        }
    };
};
