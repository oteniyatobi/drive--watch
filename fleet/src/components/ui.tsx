import { AlertOctagon, AlertTriangle, Eye, Info, Loader2, Moon, Smartphone } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { ALERT_LABELS, SEVERITY_LABELS, scoreBand } from '../lib/format';
import type { AlertType, Severity } from '../lib/types';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
    useEffect(() => {
        document.title = `${title} · driverwatch fleet`;
    }, [title]);
    return (
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
                <h1 className="text-xl font-semibold text-navy">{title}</h1>
                {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
            </div>
            {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
}

export function Card({ title, action, children, className = '' }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
    return (
        <section className={`print-avoid-break rounded-lg border border-line bg-white ${className}`}>
            {title && (
                <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
                    <h2 className="font-semibold text-navy">{title}</h2>
                    {action}
                </div>
            )}
            {children}
        </section>
    );
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
    return (
        <div className="print-avoid-break rounded-lg border border-line bg-white px-5 py-4">
            <p className="text-muted">{label}</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums text-navy">{value}</p>
            {note && <p className="mt-1 text-[13px] text-muted">{note}</p>}
        </div>
    );
}

const TONES = {
    good: 'bg-good-bg text-good',
    warn: 'bg-warn-bg text-warn',
    critical: 'bg-critical-bg text-critical',
    neutral: 'bg-canvas text-muted',
};

export function Badge({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
    return (
        <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}>
            {children}
        </span>
    );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
    const Icon = severity === 'critical' ? AlertOctagon : severity === 'medium' ? AlertTriangle : Info;
    const tone = severity === 'critical' ? 'critical' : severity === 'medium' ? 'warn' : 'neutral';
    return <Badge tone={tone}><Icon size={12} aria-hidden />{SEVERITY_LABELS[severity]}</Badge>;
}

export function AlertTypeLabel({ type }: { type: AlertType }) {
    const Icon = type === 'drowsiness' ? Moon : type === 'distraction' ? Eye : Smartphone;
    return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Icon size={14} className="text-muted" aria-hidden />
            {ALERT_LABELS[type]}
        </span>
    );
}

export function ScoreCell({ score }: { score: number | null }) {
    const band = scoreBand(score);
    return (
        <span className="inline-flex items-center gap-2">
            <span className="w-7 text-right font-semibold tabular-nums text-navy">{score ?? '–'}</span>
            <Badge tone={band.tone}>{band.label}</Badge>
        </span>
    );
}

export function StatusLabel({ status }: { status: 'active' | 'offline' }) {
    return (
        <span className="inline-flex items-center gap-2">
            <span className={`size-2 rounded-full ${status === 'active' ? 'bg-good' : 'bg-[#a9b4bf]'}`} aria-hidden />
            {status === 'active' ? 'Active' : 'Offline'}
        </span>
    );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' };

const BUTTONS = {
    primary: 'bg-navy text-white hover:bg-navy-soft',
    secondary: 'border border-line bg-white text-navy hover:bg-canvas',
    danger: 'bg-critical text-white hover:opacity-90',
};

export const buttonClass = (variant: keyof typeof BUTTONS = 'primary') =>
    `inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md px-3.5 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BUTTONS[variant]}`;

export function Button({ variant = 'primary', className = '', type = 'button', ...props }: ButtonProps) {
    return <button type={type} className={`${buttonClass(variant)} ${className}`} {...props} />;
}

export const inputClass = 'h-9 w-full rounded-md border border-[#cdd5de] bg-white px-3 text-ink placeholder:text-[#7a8794] focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/25';

export const selectClass = inputClass.replace('w-full ', '');

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
    return (
        <label className="block">
            <span className="mb-1.5 block font-semibold text-navy">{label}</span>
            <input className={inputClass} {...props} />
            {hint && <span className="mt-1 block text-[13px] text-muted">{hint}</span>}
        </label>
    );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
    return (
        <div role="group" aria-label={label} className="inline-flex rounded-md border border-line bg-white p-0.5">
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    aria-pressed={value === option.value}
                    onClick={() => onChange(option.value)}
                    className={`h-8 cursor-pointer rounded px-3 font-semibold transition-colors ${value === option.value ? 'bg-navy text-white' : 'text-muted hover:text-navy'}`}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}

export function Loading({ full = false }: { full?: boolean }) {
    return (
        <div role="status" className={`flex items-center justify-center gap-2 text-muted ${full ? 'h-full' : 'py-16'}`}>
            <Loader2 size={16} className="animate-spin" aria-hidden />
            Loading
        </div>
    );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div role="alert" className="rounded-lg border border-line bg-white px-5 py-10 text-center">
            <p className="text-ink">{message}</p>
            {onRetry && <Button variant="secondary" className="mt-3" onClick={onRetry}>Try again</Button>}
        </div>
    );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
    return (
        <div className="px-5 py-12 text-center">
            <p className="font-semibold text-navy">{title}</p>
            {children && <div className="mt-1 text-muted">{children}</div>}
        </div>
    );
}

export const thClass = 'whitespace-nowrap border-b border-line bg-[#fafbfc] px-5 py-2.5 text-left text-xs font-semibold text-muted';
export const tdClass = 'border-b border-line px-5 py-3 last:pr-5';
