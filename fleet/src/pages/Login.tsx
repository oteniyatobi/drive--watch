import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wordmark } from '../components/Layout';
import { Button, Field } from '../components/ui';
import { SIGN_IN_URL, supabase } from '../lib/supabase';

export default function Login({ mode }: { mode: 'login' | 'register' }) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [form, setForm] = useState({ companyName: '', name: '', email: '', password: '' });
    const registering = mode === 'register';

    useEffect(() => {
        document.title = `${registering ? 'Create account' : 'Sign in'} · driverwatch fleet`;
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
        <div className="grid min-h-full lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div className="hidden flex-col justify-between bg-navy p-12 text-white lg:flex">
                <Wordmark />
                <div>
                    <p className="text-3xl font-semibold leading-tight">Every driver.<br />Every trip.<br />One view.</p>
                    <p className="mt-4 max-w-sm text-white/70">Live locations, safety scores and fatigue alerts for your whole fleet.</p>
                </div>
                <p className="text-[13px] text-white/60">Driver Safety. Always Watching.</p>
            </div>

            <div className="flex items-center justify-center bg-white p-6">
                <form onSubmit={submit} className="w-full max-w-sm space-y-4">
                    <Wordmark className="text-navy lg:hidden" />
                    <div>
                        <h1 className="text-xl font-semibold text-navy">{registering ? 'Create your company account' : 'Sign in to your fleet'}</h1>
                        <p className="mt-1 text-muted">{registering ? 'Your fleet starts empty. Add drivers in Settings.' : 'Use your company email and password.'}</p>
                    </div>

                    {registering && (
                        <>
                            <Field label="Company name" required autoComplete="organization" value={form.companyName} onChange={update('companyName')} />
                            <Field label="Your name" required autoComplete="name" value={form.name} onChange={update('name')} />
                        </>
                    )}
                    <Field label="Company email" type="email" required autoComplete="email" value={form.email} onChange={update('email')} />
                    <Field
                        label="Password"
                        type="password"
                        required
                        minLength={registering ? 10 : undefined}
                        hint={registering ? 'At least 10 characters.' : undefined}
                        autoComplete={registering ? 'new-password' : 'current-password'}
                        value={form.password}
                        onChange={update('password')}
                    />

                    {error && <p role="alert" className="text-critical">{error}</p>}
                    {notice && <p role="status" className="text-teal-dark">{notice}</p>}
                    <Button type="submit" disabled={busy} className="w-full">
                        {busy ? 'Please wait' : registering ? 'Create account' : 'Sign in'}
                    </Button>

                    <p className="text-center text-muted">
                        {registering ? 'Already have an account? ' : 'New to driverwatch? '}
                        <a href={registering ? SIGN_IN_URL : '/fleet/register'} className="font-semibold text-teal-dark hover:underline">
                            {registering ? 'Sign in' : 'Create an account'}
                        </a>
                    </p>
                </form>
            </div>
        </div>
    );
}
