-- =============================================================================
-- 0002_identity_and_audit.sql
-- Users, revocable sessions, events, and the append-only audit trail.
--
-- FSD references:
--   3.1  Actors and roles
--   5.1  Authentication and account management (ADM-01-01 .. ADM-01-14)
--   5.14 Audit log (ADM-14-01 .. ADM-14-05)
--   5.15 System settings (ADM-15-01, ADM-15-06, ADM-15-07)
--   11.6 Multi-event support with reusable master data
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users -- every system login. FSD 8.1.
--
-- Users are GLOBAL, not event-scoped: FSD 11.6 requires judges to be reusable
-- as master data across events.
--
-- ADM-01-12: users are deactivated, never hard-deleted, so historical scores
-- remain attributable. There is no DELETE path for this table in the API.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username              citext NOT NULL,
  email                 citext,
  password_hash         text NOT NULL,
  full_name             text NOT NULL,
  role                  user_role NOT NULL,
  mobile                text,
  notes                 text,

  -- ADM-01-05: on first login a user must change the password issued to them.
  must_change_password  boolean NOT NULL DEFAULT true,

  -- ADM-01-04: five consecutive failed attempts lock the account for 15 minutes.
  failed_attempts       integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,

  -- ADM-01-08: optional device pinning. When device_pin_enabled is true, the
  -- first device to log in claims device_pin; a second device is refused until
  -- an administrator clears it.
  device_pin_enabled    boolean NOT NULL DEFAULT false,
  device_pin            text,

  -- ADM-07-03: conflict-of-interest link. A judge linked to a church triggers a
  -- warning when assigned to a panel scoring that church's members.
  affiliated_church_id  uuid,

  is_active             boolean NOT NULL DEFAULT true,
  deactivated_at        timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id),
  updated_by            uuid REFERENCES users(id),

  CONSTRAINT users_username_length
    CHECK (length(username) BETWEEN 3 AND 64),
  CONSTRAINT users_failed_attempts_sane
    CHECK (failed_attempts >= 0)
);

CREATE UNIQUE INDEX users_username_key ON users (username);
CREATE UNIQUE INDEX users_email_key    ON users (email) WHERE email IS NOT NULL;
CREATE INDEX users_role_active_idx     ON users (role, is_active);
CREATE INDEX users_full_name_trgm_idx  ON users USING gin (full_name gin_trgm_ops);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  users IS 'All system logins. Global master data, reusable across events (FSD 11.6).';
COMMENT ON COLUMN users.device_pin IS 'ADM-01-08: device identifier this judge account is pinned to.';


-- -----------------------------------------------------------------------------
-- user_sessions -- refresh-token records, so JWT sessions are revocable.
--
-- FSD 3.4: JWT access token (short-lived) plus refresh token, stateless API
-- with revocable sessions.
-- ADM-07-05: force logout -- an administrator can terminate a judge's session.
--
-- Only the SHA-256 hash of the refresh token is stored. A database disclosure
-- therefore does not yield usable session credentials.
-- -----------------------------------------------------------------------------
CREATE TABLE user_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  text NOT NULL,
  device_id           text,
  user_agent          text,
  ip_address          inet,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_by          uuid REFERENCES users(id),
  revoked_reason      text
);

CREATE UNIQUE INDEX user_sessions_token_key ON user_sessions (refresh_token_hash);
CREATE INDEX user_sessions_user_active_idx
  ON user_sessions (user_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE user_sessions IS
  'Revocable refresh-token sessions. Enables ADM-07-05 force logout and idle expiry (ADM-01-07).';


-- -----------------------------------------------------------------------------
-- login_attempts -- rate limiting and forensic record of authentication.
-- 11.2: rate limiting on login (10 attempts per minute per IP).
-- ADM-01-04: the lock and its expiry are recorded in the audit log.
-- -----------------------------------------------------------------------------
CREATE TABLE login_attempts (
  id           bigserial PRIMARY KEY,
  username     citext NOT NULL,
  ip_address   inet,
  user_agent   text,
  succeeded    boolean NOT NULL,
  failure_code text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_ip_time_idx       ON login_attempts (ip_address, attempted_at DESC);
CREATE INDEX login_attempts_username_time_idx ON login_attempts (username, attempted_at DESC);


-- -----------------------------------------------------------------------------
-- events -- the competition edition. FSD 5.15 (ADM-15-01) and 11.6.
--
-- Everything competition-specific (categories, items, members, registrations,
-- panels, sessions, performances, scores, results) is scoped to an event.
-- Churches and users are NOT: they are reusable master data (ADM-15-06).
-- -----------------------------------------------------------------------------
CREATE TABLE events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  edition           text,
  logo_path         text,
  start_date        date,
  end_date          date,

  -- ADM-03-03: a single event-wide age cut-off date. Age is computed as at this
  -- date, not as at today, so a participant's category cannot change mid-event.
  age_cutoff_date   date NOT NULL,

  timezone          text NOT NULL DEFAULT 'Asia/Kolkata',

  -- ADM-15-07: read-only freeze mode blocks all data changes once results are
  -- final. Enforced by middleware on every state-changing route.
  freeze_mode       boolean NOT NULL DEFAULT false,
  freeze_reason     text,

  status            event_status NOT NULL DEFAULT 'SETUP',
  archived_at       timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_by        uuid REFERENCES users(id),

  CONSTRAINT events_date_order
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

-- At most one event may be ACTIVE at a time. Judging always targets the active
-- event; this constraint removes an entire class of "wrong event" defects.
CREATE UNIQUE INDEX events_single_active_idx ON events ((status)) WHERE status = 'ACTIVE';

CREATE TRIGGER events_set_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN events.age_cutoff_date IS
  'ADM-03-03: member age is derived as at this date so categories are stable for the event duration.';


-- -----------------------------------------------------------------------------
-- audit_logs -- append-only trail. FSD 5.14.
--
-- ADM-14-01: timestamp, acting user, role, IP, action, entity type, entity id,
--            previous value, new value, and reason where one was required.
-- ADM-14-02: score submissions additionally carry device and session id.
-- ADM-14-03: append-only. Enforced by trigger in 0009 -- no UI and no code path
--            can update or delete a row here.
--
-- Deliberately carries NO foreign key to users: the trail must survive even if
-- a user row is ever removed by a DBA, and must never be blocked by a FK error
-- while writing. actor_id is recorded as a bare uuid.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),

  event_id      uuid,
  actor_id      uuid,
  actor_name    text,
  actor_role    user_role,
  ip_address    inet,
  user_agent    text,

  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,

  old_value     jsonb,
  new_value     jsonb,

  -- Mandatory wherever the specification requires a typed justification
  -- (ADM-09-07 void, ADM-10-01 revoke, ADM-08-05 force close, category override).
  reason        text,

  -- ADM-14-02
  device_id     text,
  session_id    uuid,

  -- Correlation id from the request, per 11.6 structured logging.
  request_id    text
);

CREATE INDEX audit_logs_occurred_idx ON audit_logs (occurred_at DESC);
CREATE INDEX audit_logs_actor_idx    ON audit_logs (actor_id, occurred_at DESC);
CREATE INDEX audit_logs_entity_idx   ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_action_idx   ON audit_logs (action, occurred_at DESC);
CREATE INDEX audit_logs_event_idx    ON audit_logs (event_id, occurred_at DESC);

COMMENT ON TABLE audit_logs IS
  'ADM-14-03: append-only. UPDATE and DELETE are rejected by trigger (migration 0009).';
