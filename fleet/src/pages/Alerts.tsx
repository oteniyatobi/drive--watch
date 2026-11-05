import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTypeLabel, Button, Card, Empty, ErrorNote, Loading, PageHeader, Segmented, SeverityBadge, selectClass, tdClass, thClass } from '../components/ui';
import { api } from '../lib/api';
import { ALERT_LABELS, SEVERITY_LABELS, formatDateTime, timeAgo } from '../lib/format';
import { useLive } from '../lib/live';
import type { Alert, AlertType, Severity } from '../lib/types';

export default function Alerts() {
    const queryClient = useQueryClient();
    const { connected } = useLive();
    const [type, setType] = useState<AlertType | ''>('');
    const [severity, setSeverity] = useState<Severity | ''>('');
    const [show, setShow] = useState<'all' | 'open'>('all');

    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (severity) params.set('severity', severity);
    if (show === 'open') params.set('open', 'true');
    const search = params.toString();

    const alerts = useQuery({
        queryKey: ['alerts', search],
        queryFn: () => api<Alert[]>(`/alerts?${search}`),
        placeholderData: (previous) => previous,
    });

    const acknowledge = useMutation({
        mutationFn: (id: string) => api(`/alerts/${id}/acknowledge`, { method: 'POST' }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
    });

    return (
        <>
            <PageHeader title="Alerts" subtitle={connected ? 'New alerts appear here as they happen.' : 'Reconnecting.'} />
            <Card>
                <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
                    <select aria-label="Alert type" value={type} onChange={(event) => setType(event.target.value as AlertType | '')} className={selectClass}>
                        <option value="">All types</option>
                        {Object.entries(ALERT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <select aria-label="Severity" value={severity} onChange={(event) => setSeverity(event.target.value as Severity | '')} className={selectClass}>
                        <option value="">All severities</option>
                        {Object.entries(SEVERITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <Segmented label="Show" value={show} onChange={setShow} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Needs review' }]} />
                </div>

                {acknowledge.isError && <p role="alert" className="border-b border-line px-5 py-2 text-critical">{acknowledge.error.message}</p>}

                {alerts.isPending ? <Loading /> : alerts.isError ? (
                    <div className="p-4"><ErrorNote message={alerts.error.message} onRetry={alerts.refetch} /></div>
                ) : alerts.data.length === 0 ? (
                    <Empty title="No alerts to show">Alerts from your drivers will appear here.</Empty>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[760px] border-collapse">
                            <thead>
                                <tr>{['Severity', 'Alert', 'Driver', 'Vehicle', 'Time', ''].map((label, index) => <th key={index} scope="col" className={thClass}>{label}</th>)}</tr>
                            </thead>
                            <tbody>
                                {alerts.data.map((alert) => (
                                    <tr key={alert.id} className="hover:bg-[#fafbfc]">
                                        <td className={tdClass}><SeverityBadge severity={alert.severity} /></td>
                                        <td className={tdClass}><AlertTypeLabel type={alert.type} /></td>
                                        <td className={tdClass}><Link to={`/drivers/${alert.driver_id}`} className="font-semibold text-navy hover:underline">{alert.driver_name}</Link></td>
                                        <td className={`${tdClass} whitespace-nowrap`}>{alert.vehicle_plate}</td>
                                        <td className={`${tdClass} whitespace-nowrap`} title={formatDateTime(alert.occurred_at)}>
                                            {timeAgo(alert.occurred_at)}
                                            <span className="block text-[13px] text-muted">{formatDateTime(alert.occurred_at)}</span>
                                        </td>
                                        <td className={`${tdClass} text-right`}>
                                            {alert.acknowledged_at ? (
                                                <span className="inline-flex items-center gap-1 whitespace-nowrap text-[13px] text-muted"><Check size={14} aria-hidden />Reviewed</span>
                                            ) : (
                                                <Button variant="secondary" disabled={acknowledge.isPending} onClick={() => acknowledge.mutate(alert.id)}>Mark reviewed</Button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>
        </>
    );
}
