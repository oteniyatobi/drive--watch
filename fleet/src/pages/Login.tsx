import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type InputHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wordmark } from '../components/Layout';
import { SIGN_IN_URL, supabase } from '../lib/supabase';

// This page matches login.html, which is styled by the driver app's style.css.
const POINTS = ['See every vehicle on a live map', "Track each driver's safety score", 'Get fatigue alerts as they happen'];

function AuthField({ label, hint, type, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
    const [visible, setVisible] = useState(false);
    const isPassword = type === 'password';
    return (
        <div>
            <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold text-navy">{label}</span>
                <span className="relative block">
                    <input
                        type={isPassword && visible ? 'text' : type}
                        className={`w-full rounded-lg border-[1.5px] border-[#d5dce3] bg-white py-[11px] pl-3.5 text-[15px] text-ink transition-shadow placeholder:text-muted focus:border-teal focus:outline-none focus:ring-3 focus:ring-teal/20 ${isPassword ? 'pr-16' : 'pr-3.5'}`}
                        {...props}
                    />
                    {isPassword && (
                        <button
                            type="button"
                            onClick={() => setVisible((current) => !current)}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded-md px-2.5 py-1.5 text-[13px] font-semibold text-muted hover:text-navy"
                        >
                            {visible ? 'Hide' : 'Show'}
                        </button>
                    )}
                </span>
            </label>
            {hint && <p className="mt-1.5 text-[13px] text-muted">{hint}</p>}
        </div>
    );
}

function Tab({ href, active, children }: { href: string; active: boolean; children: string }) {
    return (
        <a
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-[9px] text-center text-sm font-semibold transition-colors ${active ? 'bg-white text-navy shadow-sm' : 'text-muted hover:text-navy'}`}
        >
            {children}
        </a>
    );
}

export default function Login({ mode }: { mode: 'login' | 'register' }) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [form, setForm] = useState({ companyName: '', name: '', email: '', password: '' });
    const registering = mode === 'register';

    useEffect(() => {
        document.title = `${registering ? 'Register your fleet' : 'Sign in'} | driverwatch`;
        setError('');
    }, [registering]);

    const update = (key: keyof typeof form) => (event: { target: { value: string } }) =>
        setForm((current) => ({ ...current, [key]: event.target.value }));

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        setNotice('');
        const email = form.email.trim();
        const { data, error: failure } = registering
            ? await supabase.auth.signUp({
                email,
                password: form.password,
                options: {
                    // The API creates the company on the first signed-in request, after the email is confirmed.
                    data: { fleet_company: form.companyName.trim(), full_name: form.name.trim() },
                    emailRedirectTo: `${window.location.origin}/login.html`,
                },
            })
            : await supabase.auth.signInWithPassword({ email, password: form.password });
        setBusy(false);

        if (failure) {
            setError(failure.message);
        } else if (registering && data.user?.identities?.length === 0) {
            // Supabase hides whether an email is taken by returning a user with no identities.
            setError('An account with this email already exists. Sign in instead.');
        } else if (!data.session) {
            setNotice('Check your inbox and click the confirmation link to finish creating your account.');
        } else {
            queryClient.clear();
            navigate('/');
        }
    }

    return (
        <div className="grid min-h-full min-[960px]:grid-cols-2">
            <aside className="hidden flex-col justify-between bg-navy px-14 py-10 text-white min-[960px]:flex">
                <a href="/" aria-label="driverwatch home" className="self-start"><Wordmark /></a>
                <div className="max-w-[460px]">
                    <span className="mb-[18px] block text-xs font-semibold uppercase tracking-[.1em] text-teal">Fleet dashboard</span>
                    <h1 className="text-[clamp(2.5rem,4vw,3.5rem)] font-semibold leading-[1.06] tracking-[-.03em]">Every Driver.<br /><span className="text-teal">One View.</span></h1>
                    <p className="mt-5 text-[17px] leading-[1.7] text-white/70">Live locations, safety scores and fatigue alerts for your whole fleet.</p>
                    <ul className="mt-8 flex flex-col gap-3.5">
                        {POINTS.map((point) => (
                            <li key={point} className="flex items-center gap-3 text-[15px] text-white/90">
                                <span className="size-2 shrink-0 rounded-full bg-teal ring-4 ring-teal/25" aria-hidden />
                                {point}
                            </li>
                        ))}
                    </ul>
                </div>
                <p className="text-xs font-semibold uppercase tracking-[.12em] text-white/40">Safer roads. Protected lives.</p>
            </aside>

            <main className="flex flex-col items-center justify-center bg-canvas px-4 py-8">
                <a href="/" aria-label="driverwatch home" className="mb-7 text-navy min-[960px]:hidden"><Wordmark onLight className="text-[22px]" /></a>

                <div className="w-full max-w-[420px] rounded-2xl border border-[#e8ecf0] bg-white px-[18px] py-[22px] shadow-[0_4px_16px_rgba(10,37,64,.08),0_2px_6px_rgba(10,37,64,.04)] min-[421px]:p-7">
                    <nav aria-label="Account" className="mb-6 grid grid-cols-2 gap-1 rounded-lg bg-canvas p-1">
                        <Tab href={SIGN_IN_URL} active={!registering}>Sign in</Tab>
                        <Tab href="/fleet/register" active={registering}>Register fleet</Tab>
                    </nav>

                    <h2 className="text-2xl font-semibold leading-[1.15] tracking-[-.02em] text-navy">{registering ? 'Register your fleet' : 'Welcome back'}</h2>
                    <p className="mb-[22px] mt-1.5 text-[15px] text-muted">{registering ? "Your fleet starts empty. You'll add your drivers next." : 'Sign in to your fleet dashboard.'}</p>

                    <form onSubmit={submit} className="flex flex-col gap-4">
                        {registering && (
                            <>
                                <AuthField label="Company name" placeholder="e.g. Kigali Logistics" required autoComplete="organization" value={form.companyName} onChange={update('companyName')} />
                                <AuthField label="Your name" placeholder="e.g. Jane Uwase" required autoComplete="name" value={form.name} onChange={update('name')} />
                            </>
                        )}
                        <AuthField label="Company email" type="email" placeholder="you@company.com" required autoComplete="email" value={form.email} onChange={update('email')} />
                        <AuthField
                            label="Password"
                            type="password"
                            placeholder={registering ? 'At least 10 characters' : 'Your password'}
                            required
                            minLength={registering ? 10 : undefined}
                            autoComplete={registering ? 'new-password' : 'current-password'}
                            value={form.password}
                            onChange={update('password')}
                        />

                        {error && <p role="alert" className="rounded-lg bg-critical-bg px-3.5 py-2.5 text-sm leading-normal text-critical">{error}</p>}
                        {notice && <p role="status" className="rounded-lg border border-good/20 bg-good-bg px-3.5 py-2.5 text-sm leading-normal text-good">{notice}</p>}
                        <button
                            type="submit"
                            disabled={busy}
                            className="w-full cursor-pointer rounded-lg bg-teal px-7 py-3.5 text-base font-semibold leading-none text-white transition-colors hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {busy ? 'Please wait' : registering ? 'Register fleet' : 'Sign in'}
                        </button>
                    </form>
                </div>

                <p className="mt-6 text-[13px] text-muted">Driver Safety. Always Watching.</p>
            </main>
        </div>
    );
}
