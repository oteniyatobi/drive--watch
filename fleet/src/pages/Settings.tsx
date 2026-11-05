import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Empty, ErrorNote, Field, Loading, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import type { Driver, SettingsData } from '../lib/types';

function SaveRow({ pending, saved, error }: { pending: boolean; saved: boolean; error?: string }) {
    return (
        <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={pending}>{pending ? 'Saving' : 'Save changes'}</Button>
            {saved && <span role="status" className="text-good">Saved</span>}
            {error && <span role="alert" className="text-critical">{error}</span>}
        </div>
    );
}

function CompanyForm({ initial }: { initial: SettingsData['company'] }) {
    const queryClient = useQueryClient();
    const [form, setForm] = useState({ name: initial.name, address: initial.address, phone: initial.phone });
    const save = useMutation({
        mutationFn: () => api('/settings/company', { method: 'PATCH', body: form }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['me'] });
            queryClient.invalidateQueries({ queryKey: ['settings'] });
        },
    });

    function submit(event: FormEvent) {
        event.preventDefault();
        save.mutate();
    }

    return (
        <Card title="Company profile">
            <form onSubmit={submit} className="max-w-xl space-y-4 p-5">
                <Field label="Company name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                <Field label="Address" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} />
                <Field label="Phone" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
                <SaveRow pending={save.isPending} saved={save.isSuccess} error={save.error?.message} />
            </form>
        </Card>
    );
}

const EMPTY_DRIVER = { name: '', vehiclePlate: '', vehicleModel: '', phone: '', email: '', licenseNo: '' };

function DriversManager() {
    const queryClient = useQueryClient();
    const drivers = useQuery({ queryKey: ['drivers'], queryFn: () => api<Driver[]>('/drivers') });
    const [form, setForm] = useState(EMPTY_DRIVER);
    const [confirming, setConfirming] = useState<string | null>(null);

    const refresh = () => {
        for (const key of ['drivers', 'overview', 'alerts', 'report']) queryClient.invalidateQueries({ queryKey: [key] });
    };

    const add = useMutation({
        mutationFn: () => api('/drivers', { method: 'POST', body: form }),
        onSuccess: () => {
            setForm(EMPTY_DRIVER);
            refresh();
        },
    });
    const remove = useMutation({
        mutationFn: (id: string) => api(`/drivers/${id}`, { method: 'DELETE' }),
        onSuccess: () => {
            setConfirming(null);
            refresh();
        },
    });

    const field = (key: keyof typeof EMPTY_DRIVER) => ({
        value: form[key],
        onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }),
    });

    function submit(event: FormEvent) {
        event.preventDefault();
        add.mutate();
    }

    return (
        <Card title="Drivers">
            <form onSubmit={submit} className="border-b border-line p-5">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    <Field label="Full name" required {...field('name')} />
                    <Field label="Vehicle plate" required {...field('vehiclePlate')} />
                    <Field label="Vehicle model" {...field('vehicleModel')} />
                    <Field label="Phone" {...field('phone')} />
                    <Field label="Email" type="email" {...field('email')} />
                    <Field label="Licence number" {...field('licenseNo')} />
                </div>
                <div className="mt-4 flex items-center gap-3">
                    <Button type="submit" disabled={add.isPending}>{add.isPending ? 'Adding' : 'Add driver'}</Button>
                    {add.isError && <span role="alert" className="text-critical">{add.error.message}</span>}
                </div>
            </form>

            {remove.isError && <p role="alert" className="border-b border-line px-5 py-2 text-critical">{remove.error.message}</p>}

            {drivers.isPending ? <Loading /> : drivers.isError ? (
                <div className="p-4"><ErrorNote message={drivers.error.message} onRetry={drivers.refetch} /></div>
            ) : drivers.data.length === 0 ? (
                <Empty title="No drivers yet">Add your first driver above.</Empty>
            ) : (
                <ul className="max-h-[420px] overflow-auto">
                    {drivers.data.map((driver) => (
                        <li key={driver.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-2.5 last:border-0">
                            <span>
                                <span className="font-semibold text-navy">{driver.name}</span>
                                <span className="text-muted"> · {driver.vehicle_plate}</span>
                            </span>
                            {confirming === driver.id ? (
                                <span className="flex items-center gap-2">
                                    <span className="text-[13px] text-muted">Trips and alerts are deleted too.</span>
                                    <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(driver.id)}>Remove</Button>
                                    <Button variant="secondary" onClick={() => setConfirming(null)}>Cancel</Button>
                                </span>
                            ) : (
                                <Button variant="secondary" aria-label={`Remove ${driver.name}`} onClick={() => setConfirming(driver.id)}>Remove</Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
    return (
        <label className="flex cursor-pointer items-center gap-3">
            <input type="checkbox" className="size-4 accent-navy" checked={checked} onChange={(event) => onChange(event.target.checked)} />
            <span className="font-semibold text-navy">{label}</span>
        </label>
    );
}

function NotificationsForm({ initial }: { initial: SettingsData['notifications'] }) {
    const queryClient = useQueryClient();
    const [form, setForm] = useState({
        emailEnabled: initial.email_enabled,
        smsEnabled: initial.sms_enabled,
        emailTo: initial.email_to,
        smsTo: initial.sms_to,
    });
    const save = useMutation({
        mutationFn: () => api('/settings/notifications', { method: 'PATCH', body: form }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
    });

    function submit(event: FormEvent) {
        event.preventDefault();
        save.mutate();
    }

    return (
        <Card title="Critical alert notifications">
            <form onSubmit={submit} className="max-w-xl space-y-4 p-5">
                <p className="text-muted">Choose who hears about a critical alert. Delivery starts once email and SMS are connected; for now these choices are only saved.</p>
                <Toggle label="Send an email" checked={form.emailEnabled} onChange={(emailEnabled) => setForm({ ...form, emailEnabled })} />
                {form.emailEnabled && <Field label="Email address" type="email" required value={form.emailTo} onChange={(event) => setForm({ ...form, emailTo: event.target.value })} />}
                <Toggle label="Send an SMS" checked={form.smsEnabled} onChange={(smsEnabled) => setForm({ ...form, smsEnabled })} />
                {form.smsEnabled && <Field label="Phone number" type="tel" required value={form.smsTo} onChange={(event) => setForm({ ...form, smsTo: event.target.value })} />}
                <SaveRow pending={save.isPending} saved={save.isSuccess} error={save.error?.message} />
            </form>
        </Card>
    );
}

export default function Settings() {
    const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsData>('/settings') });

    useEffect(() => {
        window.scrollTo(0, 0);
    }, []);

    return (
        <>
            <PageHeader title="Settings" subtitle="Your company, drivers and notifications." />
            {settings.isPending ? <Loading /> : settings.isError ? <ErrorNote message={settings.error.message} onRetry={settings.refetch} /> : (
                <div className="space-y-4">
                    <CompanyForm initial={settings.data.company} />
                    <DriversManager />
                    <NotificationsForm initial={settings.data.notifications} />
                </div>
            )}
        </>
    );
}
