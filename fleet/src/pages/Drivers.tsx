import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Empty, ErrorNote, Loading, PageHeader, ScoreCell, StatusLabel, inputClass, tdClass, thClass } from '../components/ui';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { Driver } from '../lib/types';

type SortKey = 'name' | 'vehicle_plate' | 'safety_score' | 'status' | 'last_trip' | 'alerts_count';

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
    { key: 'name', label: 'Name' },
    { key: 'vehicle_plate', label: 'Vehicle' },
    { key: 'safety_score', label: 'Safety score', numeric: true },
    { key: 'status', label: 'Status' },
    { key: 'last_trip', label: 'Last trip' },
    { key: 'alerts_count', label: 'Alerts (30 days)', numeric: true },
];

function compare(a: Driver, b: Driver, key: SortKey) {
    const left = a[key];
    const right = b[key];
    // Drivers with no data stay at the bottom in both directions; see the sort below.
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
}

export default function Drivers() {
    const drivers = useQuery({ queryKey: ['drivers'], queryFn: () => api<Driver[]>('/drivers') });
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: 'name', ascending: true });

    const rows = useMemo(() => {
        const term = search.trim().toLowerCase();
        const matching = (drivers.data ?? []).filter((driver) =>
            !term || `${driver.name} ${driver.vehicle_plate} ${driver.vehicle_model}`.toLowerCase().includes(term));
        return [...matching].sort((a, b) => {
            const aEmpty = a[sort.key] === null;
            const bEmpty = b[sort.key] === null;
            if (aEmpty || bEmpty) return Number(aEmpty) - Number(bEmpty);
            return sort.ascending ? compare(a, b, sort.key) : compare(b, a, sort.key);
        });
    }, [drivers.data, search, sort]);

    function sortBy(key: SortKey, numeric?: boolean) {
        setSort((current) => current.key === key
            ? { key, ascending: !current.ascending }
            : { key, ascending: !numeric && key !== 'last_trip' });
    }

    if (drivers.isPending) return <Loading />;
    if (drivers.isError) return <ErrorNote message={drivers.error.message} onRetry={drivers.refetch} />;

    return (
        <>
            <PageHeader title="Drivers" subtitle={`${drivers.data.length} ${drivers.data.length === 1 ? 'driver' : 'drivers'} in your fleet.`} />
            <Card>
                <div className="border-b border-line p-4">
                    <div className="relative max-w-sm">
                        <Search size={16} className="absolute left-3 top-2.5 text-muted" aria-hidden />
                        <input
                            type="search"
                            aria-label="Search drivers"
                            placeholder="Search by name or vehicle"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            className={`${inputClass} pl-9`}
                        />
                    </div>
                </div>

                {rows.length === 0 ? (
                    drivers.data.length === 0
                        ? <Empty title="No drivers yet"><Link to="/settings" className="font-semibold text-teal-dark hover:underline">Add your first driver</Link></Empty>
                        : <Empty title="No drivers match your search" />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[820px] border-collapse">
                            <thead>
                                <tr>
                                    {COLUMNS.map(({ key, label, numeric }) => (
                                        <th key={key} scope="col" className={thClass} aria-sort={sort.key === key ? (sort.ascending ? 'ascending' : 'descending') : 'none'}>
                                            <button type="button" onClick={() => sortBy(key, numeric)} className="inline-flex cursor-pointer items-center gap-1 font-semibold hover:text-navy">
                                                {label}
                                                {sort.key === key && (sort.ascending ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
                                            </button>
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((driver) => (
                                    <tr key={driver.id} className="hover:bg-[#fafbfc]">
                                        <td className={tdClass}>
                                            <Link to={`/drivers/${driver.id}`} className="font-semibold text-navy hover:underline">{driver.name}</Link>
                                        </td>
                                        <td className={tdClass}>
                                            {driver.vehicle_plate}
                                            {driver.vehicle_model && <span className="block text-[13px] text-muted">{driver.vehicle_model}</span>}
                                        </td>
                                        <td className={tdClass}><ScoreCell score={driver.safety_score} /></td>
                                        <td className={tdClass}><StatusLabel status={driver.status} /></td>
                                        <td className={`${tdClass} whitespace-nowrap text-muted`}>{timeAgo(driver.last_trip)}</td>
                                        <td className={`${tdClass} tabular-nums`}>{driver.alerts_count}</td>
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
