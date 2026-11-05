export type AlertType = 'drowsiness' | 'distraction' | 'phone_use';
export type Severity = 'low' | 'medium' | 'critical';

export interface Me {
    id: string;
    name: string;
    email: string;
    companyName: string;
}

export interface Driver {
    id: string;
    name: string;
    email: string;
    phone: string;
    license_no: string;
    vehicle_plate: string;
    vehicle_model: string;
    status: 'active' | 'offline';
    safety_score: number | null;
    lat: number | null;
    lng: number | null;
    speed_kmh: number | null;
    last_seen: string | null;
    last_trip: string | null;
    alerts_count: number;
}

export interface Alert {
    id: string;
    driver_id: string;
    driver_name: string;
    vehicle_plate: string;
    type: AlertType;
    severity: Severity;
    occurred_at: string;
    acknowledged_at: string | null;
}

export interface Vehicle {
    id: string;
    name: string;
    vehicle_plate: string;
    lat: number;
    lng: number;
    heading: number | null;
    speed_kmh: number | null;
    safety_score: number | null;
}

export interface Position {
    id: string;
    lat: number;
    lng: number;
    heading: number;
    speed_kmh: number;
}

export interface Overview {
    total_drivers: number;
    active_drivers: number;
    avg_score: number | null;
    alerts_today: number;
    critical_today: number;
    alerts_yesterday: number;
    vehicles: Vehicle[];
    recent: Alert[];
}

export interface Trip {
    id: string;
    started_at: string;
    ended_at: string;
    distance_km: number;
    start_label: string;
    end_label: string;
    route: [number, number][];
    alerts: number;
}

export interface DriverDetail {
    driver: Driver;
    scores: { day: string; score: number }[];
    trips: Trip[];
    alerts: Alert[];
}

export interface TrendDay {
    day: string;
    drowsiness: number;
    distraction: number;
    phone_use: number;
    avg_score: number | null;
}

export interface ReportDriver {
    id: string;
    name: string;
    vehicle_plate: string;
    safety_score: number | null;
    trips: number;
    km: number;
    alerts: number;
    critical: number;
}

export interface Report {
    company: string;
    period: 'week' | 'month';
    days: number;
    driver: string | null;
    summary: {
        alerts: number;
        previous_alerts: number;
        critical: number;
        trips: number;
        km: number;
        avg_score: number | null;
    };
    trend: TrendDay[];
    drivers: ReportDriver[];
}

export interface SettingsData {
    company: { name: string; address: string; phone: string; timezone: string };
    notifications: { email_enabled: boolean; sms_enabled: boolean; email_to: string; sms_to: string };
}
