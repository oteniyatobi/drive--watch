import { SIGN_IN_URL, supabase } from './supabase';

export class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

async function request(path: string, options: { method?: string; body?: unknown } = {}) {
    const { data } = await supabase.auth.getSession();
    const headers: Record<string, string> = {};
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`/api/fleet${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.ok) return response;

    // An expired session goes back to sign-in, and a driver account goes back to the driver app.
    if (response.status === 401) window.location.assign(SIGN_IN_URL);
    if (response.status === 403) window.location.assign('/');
    const failure = await response.json().catch(() => null);
    throw new ApiError(response.status, failure?.error ?? 'Something went wrong. Please try again.');
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await request(path, options);
    return response.json() as Promise<T>;
}

/** Saves a file from the API. A plain link can't send the sign-in token. */
export async function download(path: string, filename: string) {
    const response = await request(path);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}
