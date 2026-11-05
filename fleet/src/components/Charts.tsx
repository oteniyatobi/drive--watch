import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ALERT_COLORS, ALERT_LABELS, formatDay } from '../lib/format';
import type { AlertType, TrendDay } from '../lib/types';

const AXIS = { fontSize: 12, fill: '#5c6b7a' };
const TYPES: AlertType[] = ['drowsiness', 'distraction', 'phone_use'];

interface TipItem {
    dataKey?: string | number | ((row: never) => unknown);
    name?: string | number;
    value?: unknown;
    color?: string;
}

function TooltipBox({ active, label, payload, unit = '' }: { active?: boolean; label?: string | number; payload?: readonly TipItem[]; unit?: string }) {
    if (!active || !payload?.length) return null;
    return (
        <div className="rounded-md border border-line bg-white px-3 py-2 text-[13px] shadow-sm">
            <p className="mb-1 font-semibold text-navy">{formatDay(String(label))}</p>
            {payload.map((item) => (
                <p key={String(item.dataKey)} className="flex items-center justify-between gap-4 text-ink">
                    <span className="flex items-center gap-1.5">
                        {payload.length > 1 && <span className="size-2 rounded-sm" style={{ background: item.color }} aria-hidden />}
                        {item.name}
                    </span>
                    <span className="font-semibold tabular-nums">{String(item.value)}{unit}</span>
                </p>
            ))}
        </div>
    );
}

/** Score over time. One series, so the card title names it and no legend is needed. */
export function ScoreLine({ data, dataKey, name, height = 260 }: { data: object[]; dataKey: string; name: string; height?: number }) {
    return (
        <ResponsiveContainer width="100%" height={height}>
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
                <CartesianGrid vertical={false} stroke="#edf0f3" />
                <XAxis dataKey="day" tickFormatter={formatDay} tick={AXIS} tickLine={false} axisLine={{ stroke: '#d5dce3' }} minTickGap={48} />
                <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={AXIS} tickLine={false} axisLine={false} />
                <Tooltip content={<TooltipBox />} cursor={{ stroke: '#a9b4bf' }} />
                <Line type="monotone" dataKey={dataKey} name={name} stroke="#0A2540" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} connectNulls isAnimationActive={false} />
            </LineChart>
        </ResponsiveContainer>
    );
}

export function AlertLegend() {
    return (
        <ul className="flex flex-wrap gap-4 text-[13px] text-ink">
            {TYPES.map((type) => (
                <li key={type} className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm" style={{ background: ALERT_COLORS[type] }} aria-hidden />
                    {ALERT_LABELS[type]}
                </li>
            ))}
        </ul>
    );
}

export function AlertBars({ data, height = 260 }: { data: TrendDay[]; height?: number }) {
    return (
        <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -20 }} barCategoryGap="28%">
                <CartesianGrid vertical={false} stroke="#edf0f3" />
                <XAxis dataKey="day" tickFormatter={formatDay} tick={AXIS} tickLine={false} axisLine={{ stroke: '#d5dce3' }} minTickGap={32} />
                <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                <Tooltip content={<TooltipBox />} cursor={{ fill: '#f2f4f7' }} />
                {TYPES.map((type) => (
                    <Bar key={type} dataKey={type} name={ALERT_LABELS[type]} stackId="alerts" fill={ALERT_COLORS[type]} stroke="#fff" strokeWidth={1} isAnimationActive={false} />
                ))}
            </BarChart>
        </ResponsiveContainer>
    );
}
