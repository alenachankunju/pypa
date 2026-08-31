-- =============================================================================
-- 0003_master_data.sql
-- Churches, categories, items, item criteria, members.
--
-- FSD references:
--   4.2  Identity and eligibility rules
--   5.2  Church management   (ADM-02-01 .. ADM-02-05)
--   5.3  Category management (ADM-03-01 .. ADM-03-04)
--   5.4  Item management     (ADM-04-01 .. ADM-04-06)
--   5.5  Member management   (ADM-05-01 .. ADM-05-09)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- churches -- participating congregations. FSD 8.1, 5.2.
--
-- GLOBAL, not event-scoped: ADM-15-06 requires churches to survive an event
-- archive and reset as reusable master data.
--
-- ADM-02-03: a church cannot be deleted if it has members. It can be
-- deactivated, which hides it from new-member dropdowns but preserves data.
-- There is no DELETE route; deactivation is the only removal path.
-- -----------------------------------------------------------------------------
CREATE TABLE churches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  -- ADM-02-02: short code 3-6 characters, used on result sheets and badges.
  short_code      citext NOT NULL,
  zone            text,
  contact_person  text,
  contact_mobile  text,
  contact_email   citext,
  logo_path       text,
  is_active       boolean NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  updated_by      uuid REFERENCES users(id),

  CONSTRAINT churches_short_code_length CHECK (length(short_code) BETWEEN 3 AND 6),
  CONSTRAINT churches_name_not_blank    CHECK (length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX churches_name_key       ON churches (lower(name));
CREATE UNIQUE INDEX churches_short_code_key ON churches (short_code);
CREATE INDEX churches_active_idx            ON churches (is_active);

CREATE TRIGGER churches_set_updated_at
  BEFORE UPDATE ON churches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Deferred from 0002: the conflict-of-interest link on users (ADM-07-03).
ALTER TABLE users
  ADD CONSTRAINT users_affiliated_church_fk
  FOREIGN KEY (affiliated_church_id) REFERENCES churches(id) ON DELETE SET NULL;


-- -----------------------------------------------------------------------------
-- categories -- age / eligibility bands. FSD 5.3.
--
-- Event-scoped: age bands are a per-event committee decision (Q1).
-- ADM-03-04: the system warns if configured age bands overlap or leave gaps.
-- That is a warning, not a constraint, so it is computed in the service layer
-- rather than enforced here -- the committee is permitted to define overlapping
-- bands deliberately (for example an "open" band).
-- -----------------------------------------------------------------------------
CREATE TABLE categories (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name               text NOT NULL,
  min_age            integer NOT NULL,
  max_age            integer NOT NULL,
  gender_restriction gender_restriction NOT NULL DEFAULT 'ANY',
  display_order      integer NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  updated_by         uuid REFERENCES users(id),

  CONSTRAINT categories_age_band_valid CHECK (max_age >= min_age AND min_age >= 0),
  CONSTRAINT categories_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX categories_event_name_key ON categories (event_id, lower(name));
CREATE INDEX categories_event_order_idx       ON categories (event_id, display_order);

CREATE TRIGGER categories_set_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- items -- competition events (called "Program" in the original brief). FSD 5.4.
-- -----------------------------------------------------------------------------
CREATE TABLE items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name               text NOT NULL,
  -- ADM-04-02: item code, unique, used by judges as a short reference.
  code               citext NOT NULL,
  category_id        uuid REFERENCES categories(id) ON DELETE RESTRICT,

  -- 4.2.6: a member may only register for items whose category matches, unless
  -- the item is marked open to all categories.
  open_to_all_categories boolean NOT NULL DEFAULT false,

  type               item_type NOT NULL DEFAULT 'INDIVIDUAL',
  gender_restriction gender_restriction NOT NULL DEFAULT 'ANY',

  -- ADM-04-02: maximum mark override, defaults to the system maximum. NULL means
  -- "inherit from scoring_config.max_mark".
  max_mark           numeric(6,2),

  stage              text,
  scheduled_at       timestamptz,

  -- 4.2.8 / ADM-06-03: NULL means unlimited.
  max_per_church     integer,

  -- ADM-04-02: team size range for group items.
  min_team_size      integer,
  max_team_size      integer,

  -- 4.7.2: items may carry a weight multiplier (default 1.0).
  weight_multiplier  numeric(6,3) NOT NULL DEFAULT 1.0,

  display_order      integer NOT NULL DEFAULT 0,
  status             item_status NOT NULL DEFAULT 'ACTIVE',
  cancelled_reason   text,
  is_active          boolean NOT NULL DEFAULT true,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  updated_by         uuid REFERENCES users(id),

  CONSTRAINT items_max_mark_positive  CHECK (max_mark IS NULL OR max_mark > 0),
  CONSTRAINT items_weight_positive    CHECK (weight_multiplier > 0),
  CONSTRAINT items_max_per_church_pos CHECK (max_per_church IS NULL OR max_per_church > 0),
  CONSTRAINT items_team_size_valid CHECK (
    (type = 'INDIVIDUAL')
    OR (min_team_size IS NULL AND max_team_size IS NULL)
    OR (min_team_size >= 1 AND max_team_size >= min_team_size)
  ),
  CONSTRAINT items_cancelled_has_reason CHECK (
    status <> 'CANCELLED' OR cancelled_reason IS NOT NULL
  )
);

CREATE UNIQUE INDEX items_event_code_key ON items (event_id, code);
CREATE INDEX items_event_category_idx    ON items (event_id, category_id);
CREATE INDEX items_event_stage_idx       ON items (event_id, stage);
CREATE INDEX items_event_order_idx       ON items (event_id, display_order);
CREATE INDEX items_name_trgm_idx         ON items USING gin (name gin_trgm_ops);

CREATE TRIGGER items_set_updated_at
  BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN items.max_mark IS
  'ADM-04-02: per-item override of the maximum mark. NULL inherits scoring_config.max_mark.';


-- -----------------------------------------------------------------------------
-- item_criteria -- optional sub-criteria per item. FSD ADM-04-06, 4.3.9.
--
-- When criteria exist for an item, judges score each criterion rather than
-- entering a single figure, and the judge's mark is the sum. The sum of
-- criterion maxima must equal the item maximum -- validated by trigger in 0009.
-- -----------------------------------------------------------------------------
CREATE TABLE item_criteria (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name          text NOT NULL,
  max_mark      numeric(6,2) NOT NULL,
  display_order integer NOT NULL DEFAULT 0,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  updated_by    uuid REFERENCES users(id),

  CONSTRAINT item_criteria_max_positive CHECK (max_mark > 0)
);

CREATE UNIQUE INDEX item_criteria_item_name_key ON item_criteria (item_id, lower(name));
CREATE INDEX item_criteria_item_order_idx       ON item_criteria (item_id, display_order);

CREATE TRIGGER item_criteria_set_updated_at
  BEFORE UPDATE ON item_criteria
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- members -- participants. FSD 5.5.
--
-- 4.2.2: a chest number is unique across the whole event and cannot be reused,
-- even after a member is deleted. Deletion is SOFT (is_active = false), so the
-- row -- and therefore the unique index entry -- persists. The number stays
-- reserved as a direct consequence of the constraint, with no separate
-- reservation table needed.
--
-- ADM-05-09: a member cannot be deleted once they have any submitted score.
-- There is no DELETE route for this table.
-- -----------------------------------------------------------------------------
CREATE TABLE members (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                 uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- ADM-05-02: unique, mandatory; may be auto-generated from church code plus
  -- sequence. Stored as text so codes such as "BTH-014" are supported, with a
  -- numeric shadow column for correct ordering and numeric-first search.
  chest_number             citext NOT NULL,
  chest_number_numeric     integer,

  full_name                text NOT NULL,
  date_of_birth            date,
  gender                   gender,

  -- 4.2.1: church is selected from a dropdown of registered churches; free text
  -- is not permitted. Enforced by this foreign key.
  church_id                uuid NOT NULL REFERENCES churches(id) ON DELETE RESTRICT,

  -- 4.2.3: category is derived automatically from date of birth against the
  -- category age bands, using the event age cut-off date. An administrator may
  -- override, but the override is recorded with a reason.
  category_id              uuid REFERENCES categories(id) ON DELETE RESTRICT,
  derived_category_id      uuid REFERENCES categories(id) ON DELETE SET NULL,
  category_override_reason text,

  photo_path               text,
  mobile                   text,
  notes                    text,
  is_active                boolean NOT NULL DEFAULT true,
  deactivated_at           timestamptz,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES users(id),
  updated_by               uuid REFERENCES users(id),

  CONSTRAINT members_chest_not_blank CHECK (length(btrim(chest_number)) > 0),
  CONSTRAINT members_name_not_blank  CHECK (length(btrim(full_name)) > 0),
  -- An override must always carry its justification (4.2.3).
  CONSTRAINT members_override_has_reason CHECK (
    category_id IS NOT DISTINCT FROM derived_category_id
    OR category_override_reason IS NOT NULL
  )
);

-- FSD 8.2 critical constraint: UNIQUE (chest_number) on members.
-- Scoped to the event, because chest numbers are unique "across the whole
-- event" (4.2.2) and the system supports multiple events (11.6).
CREATE UNIQUE INDEX members_event_chest_key ON members (event_id, chest_number);

CREATE INDEX members_event_church_idx    ON members (event_id, church_id);
CREATE INDEX members_event_category_idx  ON members (event_id, category_id);
CREATE INDEX members_chest_numeric_idx   ON members (event_id, chest_number_numeric);
CREATE INDEX members_name_trgm_idx       ON members USING gin (full_name gin_trgm_ops);
CREATE INDEX members_chest_trgm_idx      ON members USING gin ((chest_number::text) gin_trgm_ops);

CREATE TRIGGER members_set_updated_at
  BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN members.chest_number IS
  'FSD 4.2.2: unique across the event, never reused. Soft deletion keeps the row so the number stays reserved.';
COMMENT ON COLUMN members.chest_number_numeric IS
  'Numeric projection of chest_number, maintained by trigger, for correct sort order and fast numeric-first lookup (JDG-03-01).';
