export class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`/api${path}`, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        // An expired session on any page goes back to sign-in. /auth calls handle their own errors.
        if (response.status === 401 && !path.startsWith('/auth/')) window.location.assign('/login');
        throw new ApiError(response.status, data?.error ?? 'Something went wrong. Please try again.');
    }
    return data as T;
}
