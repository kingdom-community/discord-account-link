import {describe, expect, it} from 'vitest';

import {createHmacStateSigner} from '../src/index.js';

// The default signer, on its own. `oauthState.test.ts` reaches it only through
// `verifyState`, which rejects most bad input before the signer sees it and
// parses whatever comes out afterwards — so the signer's own promises (a token
// that survives a query string, a refusal rather than a throw on any input, a
// signature over exactly the bytes it was given) are pinned here directly.

const SECRET = 'a-secret-nobody-else-has-0123456789';
const signer = createHmacStateSigner(SECRET)!;

// Every character from U+0000 to U+00FF. Its UTF-8 bytes are varied enough that
// plain base64 of it contains both `+` and `/`, which are the characters a
// query string would mangle.
const EVERY_LATIN1_CHARACTER = Array.from({length: 256}, (_, code) => String.fromCharCode(code)).join('');

const PAYLOADS = [
    'x',
    // Base64 of these two bytes ends in padding.
    'ab',
    JSON.stringify({n: 'nonce', u: 'alice', e: 1_000_000}),
    // Dots inside the payload must not be mistaken for the separator.
    'a.b.c',
    'ünïcödé — and an emoji 🔗',
    EVERY_LATIN1_CHARACTER
];

describe('signing with the default signer', () => {
    it('round-trips every payload it signs', () => {
        for (const payload of PAYLOADS) {
            expect(signer.verify(signer.sign(payload))).toEqual({ok: true, payload});
        }
    });

    it('produces a token that needs no escaping in a query string', () => {
        // base64url on both halves, no padding, one separator.
        expect(Buffer.from(EVERY_LATIN1_CHARACTER, 'utf8').toString('base64')).toMatch(/\+/);
        expect(Buffer.from(EVERY_LATIN1_CHARACTER, 'utf8').toString('base64')).toMatch(/\//);
        for (const payload of PAYLOADS) {
            expect(signer.sign(payload)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        }
    });

    it('does not carry the payload in the clear', () => {
        expect(signer.sign('alice')).not.toContain('alice');
    });

    it('is deterministic for one secret and one payload', () => {
        // Uniqueness is the caller's job — `issueState` adds a nonce — so the
        // signer itself adds nothing that would make a token unverifiable later.
        expect(signer.sign('alice')).toEqual(signer.sign('alice'));
    });

    it('signs with the secret exactly as given, surrounding whitespace included', () => {
        // Only a blank secret is treated as absent; a non-blank one is used
        // verbatim rather than trimmed, so a stray space in the environment is a
        // different key and every outstanding state stops verifying.
        const padded = createHmacStateSigner(` ${SECRET} `)!;

        expect(padded.sign('alice')).not.toEqual(signer.sign('alice'));
        expect(signer.verify(padded.sign('alice'))).toEqual({ok: false, reason: 'bad-signature'});
    });
});

describe('verifying with the default signer', () => {
    it('calls a token with no usable separator malformed', () => {
        expect(signer.verify('')).toEqual({ok: false, reason: 'malformed'});
        expect(signer.verify('no-separator-here')).toEqual({ok: false, reason: 'malformed'});
        expect(signer.verify('.')).toEqual({ok: false, reason: 'malformed'});
        expect(signer.verify('.signature-without-a-payload')).toEqual({ok: false, reason: 'malformed'});
        expect(signer.verify('payload-without-a-signature.')).toEqual({ok: false, reason: 'malformed'});
    });

    it('calls a value that is not a string malformed instead of throwing', () => {
        // The interface says MUST NOT throw on attacker-supplied input, and a
        // JavaScript caller is not held to the type.
        expect(signer.verify(42 as unknown as string)).toEqual({ok: false, reason: 'malformed'});
        expect(signer.verify(undefined as unknown as string)).toEqual({ok: false, reason: 'malformed'});
        expect(signer.verify({} as unknown as string)).toEqual({ok: false, reason: 'malformed'});
    });

    it('rejects a token whose signature was altered, truncated or extended', () => {
        const token = signer.sign('alice');
        const separator = token.lastIndexOf('.');
        const encoded = token.slice(0, separator);
        const signature = token.slice(separator + 1);
        const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;

        expect(signer.verify(`${encoded}.${flipped}`)).toEqual({ok: false, reason: 'bad-signature'});
        // A different length reaches the length-safe comparison, not a throw.
        expect(signer.verify(`${encoded}.${signature.slice(0, -1)}`)).toEqual({ok: false, reason: 'bad-signature'});
        expect(signer.verify(`${encoded}.${signature}A`)).toEqual({ok: false, reason: 'bad-signature'});
    });

    it('rejects a signature moved onto a different payload', () => {
        const signature = signer.sign('alice').split('.')[1];
        const mallory = signer.sign('mallory').split('.')[0];

        expect(signer.verify(`${mallory}.${signature}`)).toEqual({ok: false, reason: 'bad-signature'});
    });

    it('rejects a token signed under another secret', () => {
        const other = createHmacStateSigner('some-other-secret')!;

        expect(signer.verify(other.sign('alice'))).toEqual({ok: false, reason: 'bad-signature'});
        expect(other.verify(signer.sign('alice'))).toEqual({ok: false, reason: 'bad-signature'});
    });

    it('checks the signature before decoding, so garbage that is not ours is not decoded', () => {
        // Characters outside base64url in the payload half are a signature
        // mismatch rather than a decode error, because decoding never runs.
        expect(signer.verify('%%%not base64%%%.AAAA')).toEqual({ok: false, reason: 'bad-signature'});
        expect(() => signer.verify('x'.repeat(10_000))).not.toThrow();
    });
});
