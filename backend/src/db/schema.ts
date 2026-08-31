/**
 * Kysely type definitions mirroring backend/migrations/*.sql.
 *
 * The SQL migrations are the source of truth for the schema; this file is the
 * TypeScript projection of them. When a migration changes a table, change the
 * matching interface here in the same commit — `npm run verify:schema` compares
 * the two against the live database and fails if they have drifted.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

// --- Enumerations (FSD 18.1) -------------------------------------------------

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'JUDGE' | 'COORDINATOR';
export type RegistrationStatus = 'REGISTERED' | 'WITHDRAWN';
export type PerformanceStatus =
  | 'SCHEDULED'
  | 'ON_STAGE'
  | 'IN_PROGRESS'
  | 'COMPLETE'
  | 'ABSENT'
  | 'VOID'
  | 'WITHDRAWN';
export type SessionStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'FORCE_CLOSED';
export type ItemResultState = 'IN_PROGRESS' | 'READY' | 'PROVISIONAL' | 'PUBLISHED' | 'WITHHELD';
export type ItemStatus = 'ACTIVE' | 'CANCELLED';
export type AggregationMethod = 'AVERAGE' | 'SUM' | 'TRIMMED_MEAN' | 'WEIGHTED_AVERAGE';
export type ItemType = 'INDIVIDUAL' | 'GROUP';
export type Gender = 'MALE' | 'FEMALE';
export type GenderRestriction = 'ANY' | 'MALE' | 'FEMALE';
export type EventStatus = 'SETUP' | 'ACTIVE' | 'FROZEN' | 'ARCHIVED';
export type ImportBatchType = 'CHURCHES' | 'MEMBERS';
export type ImportBatchStatus = 'PENDING_REVIEW' | 'COMMITTED' | 'DISCARDED';
export type ImportRowStatus = 'VALID' | 'INVALID' | 'COMMITTED' | 'SKIPPED';
export type ScoreEntryMode = 'JUDGE_DEVICE' | 'JUDGE_OFFLINE_SYNC' | 'ADMIN_BACK_ENTRY';
/** FSD 4.5 tie-break sequence. Order is configurable (ADM-11-06). */
export type TiebreakCriterion =
  | 'JUDGE_TOP_MARK_COUNT'
  | 'HIGHEST_SINGLE_MARK'
  | 'LOWEST_SPREAD'
  | 'CHIEF_JUDGE_MARK';

// --- Column helpers ----------------------------------------------------------

/** timestamptz that the database defaults on insert and maintains on update. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
/** NUMERIC columns arrive as strings from node-postgres unless parsed; the pool
 *  in pool.ts registers a float parser for them, so they surface as numbers.
 *  Both a number and a numeric string are accepted on write. */
type Numeric = ColumnType<number, number | string, number | string>;
/** A NUMERIC column with a database DEFAULT, so it may be omitted on insert.
 *  Written out longhand rather than wrapping Numeric in Generated: Generated<T>
 *  expands
 *  to ColumnType<T, T | undefined, T>, and nesting it around a ColumnType
 *  produces an insert type that rejects a plain number. */
type NumericWithDefault = ColumnType<number, number | string | undefined, number | string>;
/** A DATE column. The pool registers a parser that leaves these as plain
 *  'YYYY-MM-DD' strings rather than Date objects, because applying a timezone to
 *  a date of birth can shift it across a category age band (FSD 4.2.3). */
type DateOnly = ColumnType<string, Date | string, Date | string>;

// --- Tables ------------------------------------------------------------------

export interface UsersTable {
  id: Generated<string>;
  username: string;
  email: string | null;
  password_hash: string;
  full_name: string;
  role: UserRole;
  mobile: string | null;
  notes: string | null;
  must_change_password: Generated<boolean>;
  failed_attempts: Generated<number>;
  locked_until: Date | null;
  last_login_at: Date | null;
  device_pin_enabled: Generated<boolean>;
  device_pin: string | null;
  affiliated_church_id: string | null;
  /** FSD 3.2 "Configurable" cell for Admin on score revocation (migration 0012). */
  can_revoke_scores: Generated<boolean>;
  is_active: Generated<boolean>;
  deactivated_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface UserSessionsTable {
  id: Generated<string>;
  user_id: string;
  refresh_token_hash: string;
  device_id: string | null;
  user_agent: string | null;
  ip_address: string | null;
  issued_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoked_reason: string | null;
}

export interface LoginAttemptsTable {
  id: Generated<number>;
  username: string;
  ip_address: string | null;
  user_agent: string | null;
  succeeded: boolean;
  failure_code: string | null;
  attempted_at: Generated<Date>;
}

export interface EventsTable {
  id: Generated<string>;
  name: string;
  edition: string | null;
  logo_path: string | null;
  start_date: DateOnly | null;
  end_date: DateOnly | null;
  age_cutoff_date: DateOnly;
  timezone: Generated<string>;
  freeze_mode: Generated<boolean>;
  freeze_reason: string | null;
  status: Generated<EventStatus>;
  archived_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface AuditLogsTable {
  id: Generated<number>;
  occurred_at: Generated<Date>;
  event_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: UserRole | null;
  ip_address: string | null;
  user_agent: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_value: unknown | null;
  new_value: unknown | null;
  reason: string | null;
  device_id: string | null;
  session_id: string | null;
  request_id: string | null;
}

export interface ChurchesTable {
  id: Generated<string>;
  name: string;
  short_code: string;
  zone: string | null;
  contact_person: string | null;
  contact_mobile: string | null;
  contact_email: string | null;
  logo_path: string | null;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface CategoriesTable {
  id: Generated<string>;
  event_id: string;
  name: string;
  min_age: number;
  max_age: number;
  gender_restriction: Generated<GenderRestriction>;
  display_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface ItemsTable {
  id: Generated<string>;
  event_id: string;
  name: string;
  code: string;
  category_id: string | null;
  open_to_all_categories: Generated<boolean>;
  type: Generated<ItemType>;
  gender_restriction: Generated<GenderRestriction>;
  max_mark: Numeric | null;
  stage: string | null;
  scheduled_at: Date | null;
  max_per_church: number | null;
  min_team_size: number | null;
  max_team_size: number | null;
  weight_multiplier: NumericWithDefault;
  display_order: Generated<number>;
  status: Generated<ItemStatus>;
  cancelled_reason: string | null;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface ItemCriteriaTable {
  id: Generated<string>;
  item_id: string;
  name: string;
  max_mark: Numeric;
  display_order: Generated<number>;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface MembersTable {
  id: Generated<string>;
  event_id: string;
  chest_number: string;
  chest_number_numeric: Generated<number | null>;
  full_name: string;
  date_of_birth: DateOnly | null;
  gender: Gender | null;
  church_id: string;
  category_id: string | null;
  derived_category_id: string | null;
  category_override_reason: string | null;
  photo_path: string | null;
  mobile: string | null;
  notes: string | null;
  is_active: Generated<boolean>;
  deactivated_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface RegistrationsTable {
  id: Generated<string>;
  event_id: string;
  item_id: string;
  member_id: string | null;
  team_name: string | null;
  church_id: string;
  status: Generated<RegistrationStatus>;
  withdrawn_at: Date | null;
  withdrawn_reason: string | null;
  is_late_entry: Generated<boolean>;
  eligibility_override_reason: string | null;
  call_order: number | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface RegistrationMembersTable {
  id: Generated<string>;
  registration_id: string;
  member_id: string;
  item_id: string;
  is_team_leader: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface PanelsTable {
  id: Generated<string>;
  event_id: string;
  name: string;
  chief_judge_id: string | null;
  notes: string | null;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface PanelJudgesTable {
  id: Generated<string>;
  panel_id: string;
  user_id: string;
  weight: NumericWithDefault;
  conflict_override_reason: string | null;
  added_at: Generated<Date>;
  removed_at: Date | null;
  removed_by: string | null;
  removed_reason: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface SessionsTable {
  id: Generated<string>;
  event_id: string;
  name: string;
  stage: string | null;
  panel_id: string;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  status: Generated<SessionStatus>;
  opened_at: Date | null;
  opened_by: string | null;
  closed_at: Date | null;
  closed_by: string | null;
  force_closed_reason: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface SessionItemsTable {
  id: Generated<string>;
  session_id: string;
  item_id: string;
  display_order: Generated<number>;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface PerformancesTable {
  id: Generated<string>;
  event_id: string;
  registration_id: string;
  item_id: string;
  session_id: string | null;
  attempt_no: Generated<number>;
  /** FSD 7.2: snapshot of the completion target, never read live from the panel. */
  panel_size: number;
  status: Generated<PerformanceStatus>;
  aggregate_score: Numeric | null;
  aggregate_method_used: AggregationMethod | null;
  is_current: Generated<boolean>;
  on_stage_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  absent_note: string | null;
  void_reason: string | null;
  voided_by: string | null;
  voided_at: Date | null;
  call_order: number | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface PerformanceJudgesTable {
  id: Generated<string>;
  performance_id: string;
  judge_id: string;
  weight: NumericWithDefault;
  is_chief: Generated<boolean>;
  created_at: CreatedAt;
}

export interface ScoresTable {
  id: Generated<string>;
  performance_id: string;
  judge_id: string;
  mark: Numeric;
  remarks: string | null;
  /** JDG-08-06: client submission time, authoritative for the audit trail. */
  submitted_at: Date | string;
  received_at: Generated<Date>;
  device_id: string | null;
  session_id: string | null;
  idempotency_key: string;
  judge_weight: NumericWithDefault;
  is_out_of_sequence: Generated<boolean>;
  entry_mode: Generated<ScoreEntryMode>;
  entered_by: string | null;
  back_entry_reason: string | null;
  revoked: Generated<boolean>;
  revoked_by: string | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  created_at: CreatedAt;
}

export interface ScoreCriteriaValuesTable {
  id: Generated<string>;
  score_id: string;
  item_criteria_id: string;
  mark: Numeric;
  created_at: CreatedAt;
}

export interface ScoringConfigTable {
  id: Generated<string>;
  event_id: string;
  max_mark: NumericWithDefault;
  decimal_places: Generated<number>;
  aggregation_method: Generated<AggregationMethod>;
  allow_shared_positions: Generated<boolean>;
  tiebreak_order: Generated<TiebreakCriterion[]>;
  grade_points_enabled: Generated<boolean>;
  min_items_for_champion: Generated<number>;
  compute_category_champions: Generated<boolean>;
  max_items_per_member: Generated<number | null>;
  walkover_min_aggregate: Numeric | null;
  show_out_of_session_items: Generated<boolean>;
  locked: Generated<boolean>;
  locked_at: Date | null;
  locked_by: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface PositionPointsTable {
  id: Generated<string>;
  event_id: string;
  item_id: string | null;
  position: number;
  points: Numeric;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface GradeBandsTable {
  id: Generated<string>;
  event_id: string;
  grade: string;
  min_percentage: Numeric;
  points: NumericWithDefault;
  display_order: Generated<number>;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface ItemPublicationsTable {
  id: Generated<string>;
  event_id: string;
  item_id: string;
  state: Generated<ItemResultState>;
  has_unresolved_tie: Generated<boolean>;
  published_by: string | null;
  published_at: Date | null;
  unpublished_by: string | null;
  unpublished_at: Date | null;
  unpublish_reason: string | null;
  withheld_reason: string | null;
  last_computed_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface ItemResultsTable {
  id: Generated<string>;
  event_id: string;
  item_id: string;
  performance_id: string;
  registration_id: string;
  church_id: string | null;
  position: number | null;
  aggregate_score: Numeric | null;
  grade: string | null;
  points: NumericWithDefault;
  is_shared_position: Generated<boolean>;
  tie_break_applied: TiebreakCriterion | null;
  tie_break_note: string | null;
  manually_resolved: Generated<boolean>;
  performance_status: PerformanceStatus;
  computed_at: Generated<Date>;
}

export interface ManualTieDecisionsTable {
  id: Generated<string>;
  event_id: string;
  item_id: string;
  performance_id: string;
  assigned_position: number;
  declared_shared: Generated<boolean>;
  reason: string;
  decided_by: string;
  decided_at: Generated<Date>;
  superseded_at: Date | null;
}

export interface RecomputeRunsTable {
  id: Generated<string>;
  event_id: string;
  scope: string;
  item_id: string | null;
  trigger: string;
  reason: string | null;
  started_at: Generated<Date>;
  finished_at: Date | null;
  duration_ms: number | null;
  changes: Generated<unknown>;
  changed_count: Generated<number>;
  triggered_by: string | null;
}

export interface ImportBatchesTable {
  id: Generated<string>;
  event_id: string;
  type: ImportBatchType;
  status: Generated<ImportBatchStatus>;
  filename: string | null;
  total_rows: Generated<number>;
  valid_rows: Generated<number>;
  invalid_rows: Generated<number>;
  committed_rows: Generated<number>;
  committed_at: Date | null;
  committed_by: string | null;
  discarded_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface ImportRowsTable {
  id: Generated<string>;
  batch_id: string;
  row_number: number;
  raw: unknown;
  normalised: unknown | null;
  errors: Generated<unknown>;
  warnings: Generated<unknown>;
  status: Generated<ImportRowStatus>;
  created_entity_id: string | null;
  created_at: CreatedAt;
}

export interface SnapshotsTable {
  id: Generated<string>;
  event_id: string | null;
  label: string | null;
  trigger: string;
  storage_path: string | null;
  size_bytes: number | null;
  checksum: string | null;
  table_counts: Generated<unknown>;
  status: Generated<string>;
  error_message: string | null;
  restored_at: Date | null;
  restored_by: string | null;
  created_at: CreatedAt;
  created_by: string | null;
  expires_at: Date | null;
}

// --- Views (read-only) -------------------------------------------------------

export interface VPerformanceProgress {
  performance_id: string;
  event_id: string;
  session_id: string | null;
  item_id: string;
  registration_id: string;
  status: PerformanceStatus;
  panel_size: number;
  is_current: boolean;
  attempt_no: number;
  call_order: number | null;
  aggregate_score: Numeric | null;
  completed_at: Date | null;
  submitted_count: number;
  outstanding_count: number;
  missing_judges: { judgeId: string; fullName: string }[];
  submitted_judge_ids: string[];
}

export interface VMemberPoints {
  event_id: string;
  member_id: string;
  placed_count: number;
  items_competed: number;
  total_points: Numeric;
  first_places: number;
  second_places: number;
  third_places: number;
  aggregate_total: Numeric;
}

export interface VChurchLeaderboard {
  event_id: string;
  church_id: string;
  church_name: string;
  short_code: string;
  total_points: Numeric;
  first_places: number;
  second_places: number;
  third_places: number;
  placed_count: number;
  items_entered: number;
  aggregate_total: Numeric;
}

export interface VItemReadiness {
  item_id: string;
  event_id: string;
  item_name: string;
  item_code: string;
  category_id: string | null;
  item_status: ItemStatus;
  publication_state: ItemResultState;
  has_unresolved_tie: boolean | null;
  published_at: Date | null;
  performance_count: number;
  complete_count: number;
  absent_count: number;
  void_count: number;
  withdrawn_count: number;
  pending_count: number;
  is_ready: boolean;
}

export interface VJudgeActivity {
  event_id: string;
  judge_id: string;
  judge_name: string;
  scores_submitted: number;
  scores_revoked: number;
  out_of_sequence_count: number;
  first_submission_at: Date | null;
  last_submission_at: Date | null;
  average_mark: Numeric | null;
  mean_deviation: Numeric | null;
}

// --- Database ----------------------------------------------------------------

export interface Database {
  users: UsersTable;
  user_sessions: UserSessionsTable;
  login_attempts: LoginAttemptsTable;
  events: EventsTable;
  audit_logs: AuditLogsTable;
  churches: ChurchesTable;
  categories: CategoriesTable;
  items: ItemsTable;
  item_criteria: ItemCriteriaTable;
  members: MembersTable;
  registrations: RegistrationsTable;
  registration_members: RegistrationMembersTable;
  panels: PanelsTable;
  panel_judges: PanelJudgesTable;
  sessions: SessionsTable;
  session_items: SessionItemsTable;
  performances: PerformancesTable;
  performance_judges: PerformanceJudgesTable;
  scores: ScoresTable;
  score_criteria_values: ScoreCriteriaValuesTable;
  scoring_config: ScoringConfigTable;
  position_points: PositionPointsTable;
  grade_bands: GradeBandsTable;
  item_publications: ItemPublicationsTable;
  item_results: ItemResultsTable;
  manual_tie_decisions: ManualTieDecisionsTable;
  recompute_runs: RecomputeRunsTable;
  import_batches: ImportBatchesTable;
  import_rows: ImportRowsTable;
  snapshots: SnapshotsTable;

  // Views
  v_performance_progress: VPerformanceProgress;
  v_member_points: VMemberPoints;
  v_church_leaderboard: VChurchLeaderboard;
  v_item_readiness: VItemReadiness;
  v_judge_activity: VJudgeActivity;
}

// --- Row aliases -------------------------------------------------------------

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type Event = Selectable<EventsTable>;
export type Church = Selectable<ChurchesTable>;
export type Category = Selectable<CategoriesTable>;
export type Item = Selectable<ItemsTable>;
export type ItemCriterion = Selectable<ItemCriteriaTable>;
export type Member = Selectable<MembersTable>;
export type Registration = Selectable<RegistrationsTable>;
export type Panel = Selectable<PanelsTable>;
export type PanelJudge = Selectable<PanelJudgesTable>;
export type JudgingSession = Selectable<SessionsTable>;
export type Performance = Selectable<PerformancesTable>;
export type Score = Selectable<ScoresTable>;
export type ScoringConfig = Selectable<ScoringConfigTable>;
export type ItemResult = Selectable<ItemResultsTable>;
export type ItemPublication = Selectable<ItemPublicationsTable>;
export type GradeBand = Selectable<GradeBandsTable>;
export type PositionPoint = Selectable<PositionPointsTable>;
