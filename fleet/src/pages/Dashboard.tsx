import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FleetMap } from '../components/Maps';
import { AlertTypeLabel, Card, Empty, ErrorNote, Loading, PageHeader, SeverityBadge, Stat } from '../components/ui';
import { api } from '../lib/api';
import { scoreBand, timeAgo } from '../lib/format';
import type { Overview } from '../lib/types';

function versusYesterday(today: number, yesterday: number) {
    const change = today - yesterday;
    if (change === 0) return 'Same as yesterday';
    return `${Math.abs(change)} ${change > 0 ? 'more' : 'fewer'} than yesterday`;
}

export default function Dashboard() {
    const overview = useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/overview') });

    if (overview.isPending) return <Loading />;
    if (overview.isError) return <ErrorNote message={overview.error.message} onRetry={overview.refetch} />;
    const data = overview.data;

    return (
        <>
            <PageHeader title="Dashboard" subtitle="Your fleet right now." />
            {data.total_drivers === 0 && (
                <p className="mb-4 rounded-lg border border-line bg-white px-5 py-3.5">
                    Your fleet is empty. <Link to="/settings" className="font-semibold text-teal-dark hover:underline">Add your first driver</Link> to get started.
                </p>
            )}

            <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                <Stat label="Total drivers" value={data.total_drivers} />
                <Stat
                    label="Active drivers"
                    value={data.active_drivers}
                    note={data.total_drivers ? `${Math.round((data.active_drivers / data.total_drivers) * 100)}% of fleet on the road` : undefined}
                />
                <Stat
                    label="Alerts today"
                    value={data.alerts_today}
                    note={`${data.critical_today} critical · ${versusYesterday(data.alerts_today, data.alerts_yesterday)}`}
                />
                <Stat label="Average safety score" value={data.avg_score ?? '–'} note={scoreBand(data.avg_score).label} />
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
                <Card title="Live vehicles" action={<span className="text-[13px] text-muted">{data.vehicles.length} on the road</span>}>
                    <div className="h-[460px] overflow-hidden rounded-b-lg">
                        <FleetMap vehicles={data.vehicles} />
                    </div>
                </Card>

                <Card title="Latest alerts" action={<Link to="/alerts" className="text-[13px] font-semibold text-teal-dark hover:underline">View all</Link>}>
                    {data.recent.length === 0 ? (
                        <Empty title="No alerts yet" />
                    ) : (
                        <ul>
                            {data.recent.map((alert) => (
                                <li key={alert.id} className="border-b border-line px-5 py-3 last:border-0">
                                    <div className="flex items-center justify-between gap-2">
                                        <AlertTypeLabel type={alert.type} />
                                        <SeverityBadge severity={alert.severity} />
                                    </div>
                                    <p className="mt-1 text-[13px] text-muted">
                                        <Link to={`/drivers/${alert.driver_id}`} className="text-ink hover:underline">{alert.driver_name}</Link>
                                        {` · ${alert.vehicle_plate} · ${timeAgo(alert.occurred_at)}`}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            </div>
        </>
    );
}
