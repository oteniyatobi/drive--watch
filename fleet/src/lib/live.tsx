import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Alert, Overview, Position } from './types';

interface LiveState {
    connected: boolean;
    toast: Alert | null;
    dismissToast: () => void;
}

const LiveContext = createContext<LiveState>({ connected: false, toast: null, dismissToast: () => {} });

export const useLive = () => useContext(LiveContext);

/** One stream per signed-in session. Positions patch the map; alerts refresh whatever is showing them. */
export function LiveProvider({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient();
    const [connected, setConnected] = useState(false);
    const [toast, setToast] = useState<Alert | null>(null);
    const toastTimer = useRef<number | undefined>(undefined);

    useEffect(() => {
        const stream = new EventSource('/api/stream');
        stream.onopen = () => setConnected(true);
        stream.onerror = () => setConnected(false);

        stream.addEventListener('positions', (event) => {
            const positions: Position[] = JSON.parse(event.data);
            const byId = new Map(positions.map((p) => [p.id, p]));
            queryClient.setQueryData<Overview>(['overview'], (current) => current && {
                ...current,
                vehicles: current.vehicles.map((v) => ({ ...v, ...byId.get(v.id) })),
            });
        });

        stream.addEventListener('alert', (event) => {
            const alert: Alert = JSON.parse(event.data);
            for (const key of ['overview', 'alerts', 'drivers', 'driver']) {
                queryClient.invalidateQueries({ queryKey: [key] });
            }
            if (alert.severity === 'critical') {
                setToast(alert);
                window.clearTimeout(toastTimer.current);
                toastTimer.current = window.setTimeout(() => setToast(null), 8000);
            }
        });

        return () => {
            stream.close();
            window.clearTimeout(toastTimer.current);
        };
    }, [queryClient]);

    return (
        <LiveContext.Provider value={{ connected, toast, dismissToast: () => setToast(null) }}>
            {children}
        </LiveContext.Provider>
    );
}
