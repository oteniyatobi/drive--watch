import { createClient } from '@supabase/supabase-js';

// The same public values as supabase-config.js. On app.driverwatch.tech the session is shared with the login page.
export const supabase = createClient(
    'https://wtrzlatrpxzehdynymij.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0cnpsYXRycHh6ZWhkeW55bWlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyNzUxNzEsImV4cCI6MjEwNzg1MTE3MX0.q1G9HwRtHcmOkeZ_8E512TV5yelWC5wx_oQpN5-2sVo',
);

// Drivers and managers share one sign-in page. The Vite dev server doesn't serve it, so development uses the fleet's own.
export const SIGN_IN_URL = import.meta.env.DEV ? '/fleet/login' : '/login.html';
