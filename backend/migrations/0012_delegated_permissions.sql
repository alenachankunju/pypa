-- =============================================================================
-- 0012_delegated_permissions.sql
-- The one delegated capability in the FSD 3.2 permission matrix.
--
-- FSD 3.1 describes the Admin role as: "Cannot publish results or revoke a
-- submitted score UNLESS EXPLICITLY GRANTED", and the 3.2 matrix records
-- "Revoke a submitted score (with reason)" as "Configurable" for Admin while
-- every other Admin cell is a plain Yes or a dash.
--
-- Because the grant is per-administrator rather than event-wide ("explicitly
-- granted" to a named person), it lives on the user row. Only a Super Admin may
-- set it, and doing so is audited.
--
-- Every other capability in the matrix is fixed in code (src/middleware/authorize.ts),
-- since FSD 3.1 states that "Roles are fixed in code; the users holding them are
-- managed by the administrator."
-- =============================================================================

ALTER TABLE users
  ADD COLUMN can_revoke_scores boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.can_revoke_scores IS
  'FSD 3.2: the "Configurable" cell for Admin on "Revoke a submitted score". Ignored for other roles — SUPER_ADMIN always may, JUDGE and COORDINATOR never may.';

-- A Super Admin always holds this capability; the column is only consulted for
-- the ADMIN role, but seeding it true keeps the data self-describing.
UPDATE users SET can_revoke_scores = true WHERE role = 'SUPER_ADMIN';
