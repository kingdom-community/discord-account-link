// A recording `fetch` stub. Every call is captured as plain data so a test can
// assert over the WHOLE recorded request — which is how you catch somebody
// adding a bearer token to a call "for debugging" — rather than over one field
// somebody remembered to check.

export interface StubResponse {
    status: number;
    body?: unknown;
    // Throws instead of answering, the way a DNS failure or a timeout does.
    networkError?: boolean;
    // Answers with something that is not JSON.
    invalidJson?: boolean;
}

export interface RecordedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
}

export const stubFetch = (responses: StubResponse[]) => {
    const calls: RecordedCall[] = [];
    let index = 0;

    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
        calls.push({
            url,
            method: (init.method ?? 'GET').toUpperCase(),
            headers: {...(init.headers as Record<string, string> | undefined)},
            body: typeof init.body === 'string' ? init.body : null
        });
        const next = responses[index];
        index += 1;
        if (!next) {
            throw new Error(`unexpected fetch call to ${url}`);
        }
        if (next.networkError) {
            throw new Error('network is down');
        }
        return {
            status: next.status,
            ok: next.status >= 200 && next.status < 300,
            json: async () => {
                if (next.invalidJson) {
                    throw new Error('not json');
                }
                return next.body ?? null;
            }
        } as unknown as Response;
    };

    return {calls, fetchImpl};
};
