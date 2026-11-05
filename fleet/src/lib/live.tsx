import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Alert } from './types';

const POLL_MS = 10000;

interface LiveState {
    connected: boolean;
    toast: Alert | null;
    dismissToast: () => void;
}

const LiveContext = createContext<LiveState>({ connected: false, toast: null, dismissToast: () => {} });

export const useLive = () => useContext(LiveContext);

/** Vercel functions can't hold a stream open, so the dashboard asks for changes every few seconds. */
export function LiveProvider({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient();
    const [connected, setConnected] = useState(false);
    const [toast, setToast] = useState<Alert | null>(null);
    const toastTimer = useRef<number | undefined>(undefined);

    useEffect(() => {
        let seen: Set<string> | null = null;

        async function poll() {
            if (document.hidden) return;
            try {
                const critical = await api<Alert[]>('/alerts?severity=critical&open=true');
                setConnected(true);
                const fresh = seen ? critical.filter((alert) => !seen!.has(alert.id)) : [];
                seen = new Set(critical.map((alert) => alert.id));

                queryClient.invalidateQueries({ queryKey: ['overview'] });
                if (fresh.length) {
                    for (const key of ['alerts', 'drivers', 'driver']) {
                        queryClient.invalidateQueries({ queryKey: [key] });
                    }
                    setToast(fresh[0]);
                    window.clearTimeout(toastTimer.current);
                    toastTimer.current = window.setTimeout(() => setToast(null), 8000);
                }
            } catch {
                setConnected(false);
            }
        }

        void poll();
        const timer = window.setInterval(poll, POLL_MS);
        return () => {
            window.clearInterval(timer);
            window.clearTimeout(toastTimer.current);
        };
    }, [queryClient]);

    return (
        <LiveContext.Provider value={{ connected, toast, dismissToast: () => setToast(null) }}>
            {children}
        </LiveContext.Provider>
    );
}
