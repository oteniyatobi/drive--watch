import { useQueryClient } from '@tanstack/react-query';
import { Bell, FileBarChart, LayoutDashboard, LogOut, Menu, Settings, Users, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { ALERT_LABELS } from '../lib/format';
import { LiveProvider, useLive } from '../lib/live';
import type { Me } from '../lib/types';

const NAV = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/drivers', label: 'Drivers', icon: Users },
    { to: '/alerts', label: 'Alerts', icon: Bell },
    { to: '/reports', label: 'Reports', icon: FileBarChart },
    { to: '/settings', label: 'Settings', icon: Settings },
];

export function Wordmark({ className = '' }: { className?: string }) {
    return <span className={`text-xl font-semibold tracking-tight ${className}`}>driverwatch</span>;
}

function LiveStatus() {
    const { connected } = useLive();
    return (
        <p role="status" className="flex items-center gap-2 px-3 py-2 text-[13px] text-white/70">
            <span className={`size-2 rounded-full ${connected ? 'bg-[#4cc38a]' : 'bg-[#e0a33e]'}`} aria-hidden />
            {connected ? 'Live updates on' : 'Reconnecting'}
        </p>
    );
}

function CriticalToast() {
    const { toast, dismissToast } = useLive();
    if (!toast) return null;
    return (
        <div role="alert" className="no-print fixed bottom-5 right-5 z-[1000] flex w-[min(360px,calc(100vw-2.5rem))] items-start gap-3 rounded-lg border border-critical/30 bg-white p-4 shadow-lg">
            <div className="min-w-0 flex-1">
                <p className="font-semibold text-critical">Critical alert</p>
                <p className="mt-0.5 text-ink">
                    {ALERT_LABELS[toast.type]} · <Link className="underline" to={`/drivers/${toast.driver_id}`}>{toast.driver_name}</Link> · {toast.vehicle_plate}
                </p>
            </div>
            <button type="button" aria-label="Dismiss" onClick={dismissToast} className="cursor-pointer text-muted hover:text-ink"><X size={16} /></button>
        </div>
    );
}

function Sidebar({ me, open }: { me: Me; open: boolean }) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    async function signOut() {
        await api('/auth/logout', { method: 'POST' });
        queryClient.clear();
        navigate('/login');
    }

    return (
        <aside className={`no-print fixed inset-y-0 left-0 z-[900] flex w-60 flex-col bg-navy text-white transition-transform lg:static lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
            <div className="px-5 pb-5 pt-6">
                <Wordmark />
                <p className="mt-1 truncate text-[13px] text-white/70">{me.companyName}</p>
            </div>
            <nav aria-label="Main" className="flex-1 space-y-0.5 px-3">
                {NAV.map(({ to, label, icon: Icon, end }) => (
                    <NavLink
                        key={to}
                        to={to}
                        end={end}
                        className={({ isActive }) => `flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors ${isActive ? 'bg-white/12 font-semibold text-white' : 'text-white/75 hover:bg-white/6 hover:text-white'}`}
                    >
                        <Icon size={18} aria-hidden />
                        {label}
                    </NavLink>
                ))}
            </nav>
            <div className="border-t border-white/10 p-3">
                <LiveStatus />
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                        <p className="truncate font-semibold">{me.name}</p>
                        <p className="truncate text-[13px] text-white/70">{me.email}</p>
                    </div>
                    <button type="button" aria-label="Sign out" title="Sign out" onClick={signOut} className="cursor-pointer rounded p-1.5 text-white/70 hover:bg-white/10 hover:text-white">
                        <LogOut size={16} />
                    </button>
                </div>
            </div>
        </aside>
    );
}

export default function Layout({ me, children }: { me: Me; children: ReactNode }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const { pathname } = useLocation();

    useEffect(() => {
        setMenuOpen(false);
    }, [pathname]);

    return (
        <LiveProvider>
            <div className="flex h-full">
                <Sidebar me={me} open={menuOpen} />
                {menuOpen && <button type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-[800] bg-navy/40 lg:hidden" />}
                <div className="flex min-w-0 flex-1 flex-col">
                    <header className="no-print flex h-14 shrink-0 items-center gap-3 bg-navy px-4 text-white lg:hidden">
                        <button type="button" aria-label="Open menu" onClick={() => setMenuOpen(true)} className="cursor-pointer"><Menu size={22} /></button>
                        <Wordmark className="text-lg" />
                    </header>
                    <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
                        <div className="mx-auto max-w-[1400px]">{children}</div>
                    </main>
                </div>
            </div>
            <CriticalToast />
        </LiveProvider>
    );
}
