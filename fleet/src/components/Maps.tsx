import L from 'leaflet';
import { useEffect, useMemo } from 'react';
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import { Link } from 'react-router-dom';
import type { Trip, Vehicle } from '../lib/types';

const KIGALI: [number, number] = [-1.9441, 30.0819];
// OpenStreetMap's public tiles suit development. Set VITE_MAP_TILES to a paid provider for production traffic.
const TILES = import.meta.env.VITE_MAP_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

function vehicleIcon(heading: number) {
    return L.divIcon({
        className: 'vehicle-marker',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -12],
        html: `<svg width="28" height="28" viewBox="0 0 28 28" style="transform:rotate(${heading}deg)" aria-hidden="true">
            <circle cx="14" cy="14" r="12" fill="#0A2540" stroke="#fff" stroke-width="2"/>
            <path d="M14 7l5 12-5-3-5 3z" fill="#fff"/></svg>`,
    });
}

function FitOnce({ points }: { points: [number, number][] }) {
    const map = useMap();
    const key = points.length;
    useEffect(() => {
        if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 14 });
        // Only when the set of points changes size, so live movement never fights the user's panning.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, map]);
    return null;
}

function VehicleMarker({ vehicle }: { vehicle: Vehicle }) {
    const heading = Math.round((vehicle.heading ?? 0) / 15) * 15;
    const icon = useMemo(() => vehicleIcon(heading), [heading]);
    return (
        <Marker position={[vehicle.lat, vehicle.lng]} icon={icon} title={`${vehicle.name}, ${vehicle.vehicle_plate}`}>
            <Popup>
                <Link to={`/drivers/${vehicle.id}`} className="font-semibold text-navy underline">{vehicle.name}</Link>
                <br />
                {vehicle.vehicle_plate} · {Math.round(vehicle.speed_kmh ?? 0)} km/h
            </Popup>
        </Marker>
    );
}

export function FleetMap({ vehicles }: { vehicles: Vehicle[] }) {
    const points = useMemo(() => vehicles.map((v) => [v.lat, v.lng] as [number, number]), [vehicles]);
    return (
        <MapContainer center={KIGALI} zoom={12} className="size-full min-h-[320px]">
            <TileLayer url={TILES} attribution={CREDIT} />
            <FitOnce points={points} />
            {vehicles.map((vehicle) => <VehicleMarker key={vehicle.id} vehicle={vehicle} />)}
        </MapContainer>
    );
}

export function RouteMap({ trips, current }: { trips: Trip[]; current: [number, number] | null }) {
    const points = useMemo(() => trips.flatMap((t) => t.route), [trips]);
    return (
        <MapContainer center={KIGALI} zoom={12} className="size-full min-h-[280px]">
            <TileLayer url={TILES} attribution={CREDIT} />
            <FitOnce points={points} />
            {trips.map((trip, index) => (
                <Polyline key={trip.id} positions={trip.route} pathOptions={{ color: index === 0 ? '#0A2540' : '#5B8A9A', weight: index === 0 ? 3 : 2, opacity: index === 0 ? 1 : 0.7 }} />
            ))}
            {current && <CircleMarker center={current} radius={6} pathOptions={{ color: '#fff', weight: 2, fillColor: '#0A2540', fillOpacity: 1 }} />}
        </MapContainer>
    );
}
