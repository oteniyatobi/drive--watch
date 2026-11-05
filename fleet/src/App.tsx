import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { Loading } from './components/ui';
import { api } from './lib/api';
import type { Me } from './lib/types';
import Alerts from './pages/Alerts';
import Dashboard from './pages/Dashboard';
import DriverDetail from './pages/DriverDetail';
import Drivers from './pages/Drivers';
import Login from './pages/Login';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

function RequireAuth() {
    const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me') });
    if (me.isPending) return <Loading full />;
    if (me.isError) return <Navigate to="/login" replace />;
    return <Layout me={me.data}><Outlet /></Layout>;
}

export default function App() {
    return (
        <Routes>
            <Route path="/login" element={<Login mode="login" />} />
            <Route path="/register" element={<Login mode="register" />} />
            <Route element={<RequireAuth />}>
                <Route index element={<Dashboard />} />
                <Route path="drivers" element={<Drivers />} />
                <Route path="drivers/:id" element={<DriverDetail />} />
                <Route path="alerts" element={<Alerts />} />
                <Route path="reports" element={<Reports />} />
                <Route path="settings" element={<Settings />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}
