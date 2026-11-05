CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'Africa/Kigali',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_prefs (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  email_enabled boolean NOT NULL DEFAULT true,
  sms_enabled boolean NOT NULL DEFAULT false,
  email_to text NOT NULL DEFAULT '',
  sms_to text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  license_no text NOT NULL DEFAULT '',
  vehicle_plate text NOT NULL,
  vehicle_model text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('active', 'offline')),
  safety_score integer CHECK (safety_score BETWEEN 0 AND 100),
  lat double precision,
  lng double precision,
  heading double precision,
  speed_kmh double precision,
  last_seen timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drivers_company_idx ON drivers (company_id);

CREATE TABLE IF NOT EXISTS driver_scores (
  driver_id uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  day date NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  PRIMARY KEY (driver_id, day)
);

CREATE TABLE IF NOT EXISTS trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  distance_km double precision NOT NULL,
  start_label text NOT NULL,
  end_label text NOT NULL,
  route jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS trips_driver_idx ON trips (driver_id, started_at DESC);
CREATE INDEX IF NOT EXISTS trips_company_idx ON trips (company_id, started_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('drowsiness', 'distraction', 'phone_use')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'critical')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  lat double precision,
  lng double precision,
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS alerts_company_idx ON alerts (company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS alerts_driver_idx ON alerts (driver_id, occurred_at DESC);
