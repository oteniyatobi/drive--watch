import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertBars, AlertLegend, ScoreLine } from '../components/Charts';
import { Button, Card, Empty, ErrorNote, Loading, PageHeader, ScoreCell, Segmented, Stat, buttonClass, selectClass, tdClass, thClass } from '../components/ui';
import { api } from '../lib/api';
import { formatDay } from '../lib/format';
import type { Driver, Report } from '../lib/types';

function versusPrevious(current: number, previous: number, period: string) {
    if (!previous) return `No alerts in the previous ${period}`;
    const change = Math.round(((current - previous) / previous) * 100);
    if (change === 0) return `Same as the previous ${period}`;
    return `${Math.abs(change)}% ${change > 0 ? 'more' : 'fewer'} than the previous ${period}`;
}

export default function Reports() {
    const [period, setPeriod] = useState<'week' | 'month'>('week');
    const [driverId, setDriverId] = useState('');

    const params = new URLSearchParams({ period });
    if (driverId) params.set('driverId', driverId);
    const search = params.toString();

    const drivers = useQuery({ queryKey: ['drivers'], queryFn: () => api<Driver[]>('/drivers') });
    const report = useQuery({
        queryKey: ['report', search],
        queryFn: () => api<Report>(`/reports?${search}`),
        placeholderData: (previous) => previous,
    });

    const data = report.data;
    const scope = data?.driver ?? 'Full fleet';

    return (
        <>
            <PageHeader
                title="Reports"
                subtitle={data ? `${data.company} · ${scope} · last ${data.days} days` : undefined}
                actions={(
                    <>
                        <a href={`/api/reports/export.csv?${search}`} className={buttonClass('secondary')}><Download size={16} aria-hidden />Export CSV</a>
                        <Button variant="secondary" onClick={() => window.print()}><Printer size={16} aria-hidden />Print or save PDF</Button>
                    </>
                )}
            />

            <div className="no-print mb-4 flex flex-wrap items-center gap-3">
                <Segmented label="Report period" value={period} onChange={setPeriod} options={[{ value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]} />
                <select aria-label="Report scope" value={driverId} onChange={(event) => setDriverId(event.target.value)} className={`${selectClass} min-w-52`}>
                    <option value="">Full fleet</option>
                    {drivers.data?.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
                </select>
            </div>

            {report.isPending ? <Loading /> : report.isError ? <ErrorNote message={report.error.message} onRetry={report.refetch} /> : data && (
                <>
                    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                        <Stat label="Alerts" value={data.summary.alerts} note={versusPrevious(data.summary.alerts, data.summary.previous_alerts, data.period)} />
                        <Stat label="Critical alerts" value={data.summary.critical} />
                        <Stat label="Average safety score" value={data.summary.avg_score ?? '–'} />
                        <Stat label="Trips" value={data.summary.trips} note={`${data.summary.km.toLocaleString()} km driven`} />
                    </div>

                    <div className="mt-4 grid gap-4 xl:grid-cols-2">
                        <Card title="Alerts per day, by type">
                            <div className="p-4">
                                <div className="mb-3"><AlertLegend /></div>
                                <AlertBars data={data.trend} />
                            </div>
                        </Card>
                        <Card title="Average safety score per day">
                            <div className="p-4"><ScoreLine data={data.trend} dataKey="avg_score" name="Average score" height={288} /></div>
                        </Card>
                    </div>

                    <details className="no-print mt-3 text-muted">
                        <summary className="cursor-pointer">View chart data as a table</summary>
                        <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-white">
                            <table className="w-full min-w-[560px] border-collapse">
                                <thead>
                                    <tr>{['Day', 'Drowsiness', 'Distraction', 'Phone use', 'Average score'].map((label) => <th key={label} scope="col" className={thClass}>{label}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {data.trend.map((day) => (
                                        <tr key={day.day}>
                                            <td className={tdClass}>{formatDay(day.day)}</td>
                                            <td className={`${tdClass} tabular-nums`}>{day.drowsiness}</td>
                                            <td className={`${tdClass} tabular-nums`}>{day.distraction}</td>
                                            <td className={`${tdClass} tabular-nums`}>{day.phone_use}</td>
                                            <td className={`${tdClass} tabular-nums`}>{day.avg_score ?? '–'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </details>

                    <Card title="Driver breakdown" className="mt-4">
                        {data.drivers.length === 0 ? <Empty title="No drivers yet" /> : (
                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[720px] border-collapse">
                                    <thead>
                                        <tr>{['Driver', 'Vehicle', 'Safety score', 'Trips', 'Distance', 'Alerts', 'Critical'].map((label) => <th key={label} scope="col" className={thClass}>{label}</th>)}</tr>
                                    </thead>
                                    <tbody>
                                        {data.drivers.map((driver) => (
                                            <tr key={driver.id}>
                                                <td className={tdClass}><Link to={`/drivers/${driver.id}`} className="font-semibold text-navy hover:underline">{driver.name}</Link></td>
                                                <td className={`${tdClass} whitespace-nowrap`}>{driver.vehicle_plate}</td>
                                                <td className={tdClass}><ScoreCell score={driver.safety_score} /></td>
                                                <td className={`${tdClass} tabular-nums`}>{driver.trips}</td>
                                                <td className={`${tdClass} whitespace-nowrap tabular-nums`}>{Math.round(driver.km)} km</td>
                                                <td className={`${tdClass} tabular-nums`}>{driver.alerts}</td>
                                                <td className={`${tdClass} tabular-nums`}>{driver.critical}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Card>
                </>
            )}
        </>
    );
}
