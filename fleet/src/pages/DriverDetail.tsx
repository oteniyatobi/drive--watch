import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ScoreLine } from '../components/Charts';
import { RouteMap } from '../components/Maps';
import { AlertTypeLabel, Card, Empty, ErrorNote, Loading, PageHeader, Segmented, SeverityBadge, Stat, StatusLabel, tdClass, thClass } from '../components/ui';
import { api } from '../lib/api';
import { ALERT_LABELS, formatDateTime, formatDuration, scoreBand, timeAgo } from '../lib/format';
import type { AlertType, DriverDetail as Detail } from '../lib/types';

type AlertFilter = AlertType | 'all';

const FILTERS: { value: AlertFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    ...(Object.keys(ALERT_LABELS) as AlertType[]).map((value) => ({ value, label: ALERT_LABELS[value] })),
];

export default function DriverDetail() {
    const { id } = useParams();
    const detail = useQuery({ queryKey: ['driver', id], queryFn: () => api<Detail>(`/drivers/${id}`) });
    const [range, setRange] = useState<'30' | '90'>('30');
    const [filter, setFilter] = useState<AlertFilter>('all');

    const scores = useMemo(() => detail.data?.scores.slice(-Number(range)) ?? [], [detail.data, range]);
    const recentTrips = useMemo(() => detail.data?.trips.slice(0, 5) ?? [], [detail.data]);

    const back = (
        <Link to="/drivers" className="no-print mb-4 inline-flex items-center gap-1.5 text-muted hover:text-navy">
            <ArrowLeft size={16} aria-hidden />
            All drivers
        </Link>
    );

    if (detail.isPending) return <Loading />;
    if (detail.isError) return <>{back}<ErrorNote message={detail.error.message} /></>;

    const { driver, trips, alerts } = detail.data;
    const shownAlerts = filter === 'all' ? alerts : alerts.filter((alert) => alert.type === filter);
    const km = trips.reduce((sum, trip) => sum + trip.distance_km, 0);
    const current: [number, number] | null = driver.status === 'active' && driver.lat !== null && driver.lng !== null ? [driver.lat, driver.lng] : null;

    return (
        <>
            {back}
            <PageHeader
                title={driver.name}
                subtitle={[driver.vehicle_plate, driver.vehicle_model, driver.phone, driver.license_no && `Licence ${driver.license_no}`].filter(Boolean).join(' · ')}
                actions={<StatusLabel status={driver.status} />}
            />

            <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                <Stat label="Safety score" value={driver.safety_score ?? '–'} note={scoreBand(driver.safety_score).label} />
                <Stat label="Alerts, last 30 days" value={driver.alerts_count} />
                <Stat label="Recent trips" value={trips.length} note={`${Math.round(km)} km driven`} />
                <Stat label="Last seen" value={<span className="text-xl">{timeAgo(driver.last_seen)}</span>} />
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <Card
                    title="Safety score over time"
                    action={<Segmented label="Score range" value={range} onChange={setRange} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />}
                >
                    {scores.length ? <div className="p-4"><ScoreLine data={scores} dataKey="score" name="Safety score" /></div> : <Empty title="No score history yet" />}
                </Card>
                <Card title="Recent routes" action={<span className="text-[13px] text-muted">Last {recentTrips.length} trips, latest in navy</span>}>
                    <div className="h-[300px] overflow-hidden rounded-b-lg">
                        <RouteMap trips={recentTrips} current={current} />
                    </div>
                </Card>
            </div>

            <div className="mt-4 grid items-start gap-4 xl:grid-cols-2">
                <Card title="Trip history">
                    {trips.length === 0 ? <Empty title="No trips yet" /> : (
                        <div className="max-h-[440px] overflow-auto">
                            <table className="w-full min-w-[520px] border-collapse">
                                <thead className="sticky top-0">
                                    <tr>{['Started', 'Route', 'Distance', 'Duration', 'Alerts'].map((label) => <th key={label} scope="col" className={thClass}>{label}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {trips.map((trip) => (
                                        <tr key={trip.id}>
                                            <td className={`${tdClass} whitespace-nowrap`}>{formatDateTime(trip.started_at)}</td>
                                            <td className={tdClass}>{trip.start_label} to {trip.end_label}</td>
                                            <td className={`${tdClass} whitespace-nowrap tabular-nums`}>{trip.distance_km.toFixed(1)} km</td>
                                            <td className={`${tdClass} whitespace-nowrap tabular-nums`}>{formatDuration(trip.started_at, trip.ended_at)}</td>
                                            <td className={`${tdClass} tabular-nums`}>{trip.alerts}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>

                <Card title="Alert log">
                    <div className="border-b border-line p-3">
                        <Segmented label="Alert type" value={filter} onChange={setFilter} options={FILTERS} />
                    </div>
                    {shownAlerts.length === 0 ? <Empty title="No alerts here" /> : (
                        <ul className="max-h-[390px] overflow-auto">
                            {shownAlerts.map((alert) => (
                                <li key={alert.id} className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 last:border-0">
                                    <AlertTypeLabel type={alert.type} />
                                    <span className="flex items-center gap-3">
                                        <span className="whitespace-nowrap text-[13px] text-muted">{formatDateTime(alert.occurred_at)}</span>
                                        <SeverityBadge severity={alert.severity} />
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            </div>
        </>
    );
}
