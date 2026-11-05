import type { AlertType, Severity } from './types';

export const ALERT_LABELS: Record<AlertType, string> = {
    drowsiness: 'Drowsiness',
    distraction: 'Distraction',
    phone_use: 'Phone use',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
    low: 'Low',
    medium: 'Medium',
    critical: 'Critical',
};

// Checked for colour-blind separation and contrast on white. Order is fixed.
export const ALERT_COLORS: Record<AlertType, string> = {
    drowsiness: '#2B6CB0',
    distraction: '#C2853D',
    phone_use: '#1F9AA8',
};

const dateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayOnly = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export const formatDateTime = (value: string) => dateTime.format(new Date(value));

/** Takes a plain YYYY-MM-DD and keeps it on that calendar day in any timezone. */
export const formatDay = (day: string) => dayOnly.format(new Date(`${day}T00:00:00`));

export function timeAgo(value: string | null) {
    if (!value) return 'Never';
    const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
    if (seconds > -45) return 'Just now';
    if (seconds > -3600) return relative.format(Math.round(seconds / 60), 'minute');
    if (seconds > -86400) return relative.format(Math.round(seconds / 3600), 'hour');
    return relative.format(Math.round(seconds / 86400), 'day');
}

export function formatDuration(start: string, end: string) {
    const minutes = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function scoreBand(score: number | null) {
    if (score === null) return { label: 'No data', tone: 'neutral' as const };
    if (score >= 85) return { label: 'Good', tone: 'good' as const };
    if (score >= 70) return { label: 'Fair', tone: 'warn' as const };
    return { label: 'At risk', tone: 'critical' as const };
}
