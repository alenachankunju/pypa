/**
 * The application error taxonomy.
 *
 * FSD 9.4 defines a table of machine-readable error codes with fixed HTTP
 * statuses. Those codes are contractual: the judge app branches on them (for
 * example JDG-06-07 treats ALREADY_SCORED as success, not failure), so they are
 * declared here once and never inlined as string literals at a call site.
 *
 * FSD 11.3 also requires that "error messages state what went wrong and what to
 * do next, in plain language". Every message below is written to be shown to a
 * user, not to a developer.
 */

/** FSD 9.4 standard error codes, plus the general-purpose codes the API needs. */
export const ErrorCode = {
  // --- FSD 9.4, verbatim ---------------------------------------------------
  /** This judge has already scored this performance. */
  ALREADY_SCORED: 'ALREADY_SCORED',
  /** Scoring attempted outside an open session. */
  SESSION_NOT_OPEN: 'SESSION_NOT_OPEN',
  /** Judge is not assigned to this performance's panel. */
  NOT_ON_PANEL: 'NOT_ON_PANEL',
  /** Performance is COMPLETE, VOID or ABSENT. */
  PERFORMANCE_LOCKED: 'PERFORMANCE_LOCKED',
  /** Mark below zero or above the item maximum. */
  MARK_OUT_OF_RANGE: 'MARK_OUT_OF_RANGE',
  /** Chest number already in use. */
  DUPLICATE_CHEST_NUMBER: 'DUPLICATE_CHEST_NUMBER',
  /** Member category or gender does not match the item. */
  INELIGIBLE_ITEM: 'INELIGIBLE_ITEM',
  /** Per-church or per-member entry cap breached. */
  ENTRY_LIMIT_EXCEEDED: 'ENTRY_LIMIT_EXCEEDED',
  /** Change attempted against a published result. */
  RESULT_PUBLISHED: 'RESULT_PUBLISHED',
  /** Scoring configuration locked after first publication. */
  CONFIG_LOCKED: 'CONFIG_LOCKED',
  /** Item cannot be published until the tie is decided. */
  TIE_UNRESOLVED: 'TIE_UNRESOLVED',

  // --- Authentication and authorisation (FSD 5.1, 3.2) ---------------------
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** ADM-01-04: five consecutive failed attempts lock the account. */
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  /** ADM-01-05: the issued password must be changed before anything else. */
  MUST_CHANGE_PASSWORD: 'MUST_CHANGE_PASSWORD',
  /** ADM-01-08: this account is pinned to a different device. */
  DEVICE_PIN_MISMATCH: 'DEVICE_PIN_MISMATCH',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  SESSION_REVOKED: 'SESSION_REVOKED',
  FORBIDDEN: 'FORBIDDEN',

  // --- Data and lifecycle --------------------------------------------------
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
  DUPLICATE_REGISTRATION: 'DUPLICATE_REGISTRATION',
  /** ADM-15-07: the event is in read-only freeze mode. */
  EVENT_FROZEN: 'EVENT_FROZEN',
  /** ADM-08-05: session close blocked by incomplete performances. */
  SESSION_INCOMPLETE: 'SESSION_INCOMPLETE',
  /** 7.4: ranking requested for an item that still has pending performances. */
  ITEM_NOT_READY: 'ITEM_NOT_READY',
  /** ADM-02-03 / ADM-04-05 / ADM-05-09: deletion blocked by dependent records. */
  IN_USE: 'IN_USE',
  /** ADM-06-04: team size outside the configured range. */
  TEAM_SIZE_INVALID: 'TEAM_SIZE_INVALID',
  IMMUTABLE: 'IMMUTABLE',

  // --- Infrastructure ------------------------------------------------------
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** HTTP status for each code. FSD 9.4 fixes the first eleven. */
const STATUS_BY_CODE: Record<ErrorCodeValue, number> = {
  [ErrorCode.ALREADY_SCORED]: 409,
  [ErrorCode.SESSION_NOT_OPEN]: 403,
  [ErrorCode.NOT_ON_PANEL]: 403,
  [ErrorCode.PERFORMANCE_LOCKED]: 409,
  [ErrorCode.MARK_OUT_OF_RANGE]: 422,
  [ErrorCode.DUPLICATE_CHEST_NUMBER]: 422,
  [ErrorCode.INELIGIBLE_ITEM]: 422,
  [ErrorCode.ENTRY_LIMIT_EXCEEDED]: 422,
  [ErrorCode.RESULT_PUBLISHED]: 409,
  [ErrorCode.CONFIG_LOCKED]: 409,
  [ErrorCode.TIE_UNRESOLVED]: 409,

  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.ACCOUNT_LOCKED]: 423,
  [ErrorCode.ACCOUNT_INACTIVE]: 403,
  [ErrorCode.MUST_CHANGE_PASSWORD]: 403,
  [ErrorCode.DEVICE_PIN_MISMATCH]: 403,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.TOKEN_INVALID]: 401,
  [ErrorCode.SESSION_REVOKED]: 401,
  [ErrorCode.FORBIDDEN]: 403,

  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.VALIDATION_ERROR]: 422,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.DUPLICATE_REGISTRATION]: 409,
  [ErrorCode.EVENT_FROZEN]: 403,
  [ErrorCode.SESSION_INCOMPLETE]: 409,
  [ErrorCode.ITEM_NOT_READY]: 409,
  [ErrorCode.IN_USE]: 409,
  [ErrorCode.TEAM_SIZE_INVALID]: 422,
  [ErrorCode.IMMUTABLE]: 409,

  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: 415,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.INTERNAL_ERROR]: 500,
};

export interface AppErrorOptions {
  /** Structured context for the client — field errors, conflicting ids, limits. */
  details?: unknown;
  /** Original error, logged but never returned to the client. */
  cause?: unknown;
  /** Override the default status for this code. Rarely needed. */
  status?: number;
}

/**
 * An error with a contractual code. Anything thrown that is not an AppError is
 * treated as an unexpected fault and reported as INTERNAL_ERROR with its detail
 * withheld from the response (FSD 11.2 — internals must not leak to clients).
 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details: unknown;
  override readonly cause: unknown;
  /** True for the codes the FSD names, which the client is expected to handle. */
  readonly expected = true;

  constructor(code: ErrorCodeValue, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code] ?? 500;
    this.details = options.details;
    this.cause = options.cause;
    Error.captureStackTrace?.(this, AppError);
  }
}

export function statusForCode(code: ErrorCodeValue): number {
  return STATUS_BY_CODE[code] ?? 500;
}

// ---------------------------------------------------------------------------
// Constructors for the errors raised most often, so call sites stay readable
// and the user-facing wording stays consistent across modules.
// ---------------------------------------------------------------------------

export const errors = {
  notFound: (entity: string, identifier?: string | number) =>
    new AppError(
      ErrorCode.NOT_FOUND,
      identifier === undefined
        ? `${entity} not found.`
        : `${entity} "${identifier}" was not found.`,
    ),

  validation: (message: string, details?: unknown) =>
    new AppError(ErrorCode.VALIDATION_ERROR, message, { details }),

  forbidden: (message = 'You do not have permission to perform this action.') =>
    new AppError(ErrorCode.FORBIDDEN, message),

  unauthenticated: (message = 'Please sign in to continue.') =>
    new AppError(ErrorCode.UNAUTHENTICATED, message),

  /** JDG-03-06: "Silent empty results are not acceptable." */
  chestNotFoundInSession: (chestNumber: string) =>
    new AppError(
      ErrorCode.NOT_FOUND,
      `No participant found with chest number ${chestNumber} in this session.`,
      { details: { chestNumber } },
    ),

  alreadyScored: (details?: unknown) =>
    new AppError(
      ErrorCode.ALREADY_SCORED,
      'You have already submitted a mark for this performance. Marks cannot be changed once submitted.',
      { details },
    ),

  sessionNotOpen: (sessionName?: string) =>
    new AppError(
      ErrorCode.SESSION_NOT_OPEN,
      sessionName
        ? `Session "${sessionName}" is not open for scoring. Ask the administrator to open it.`
        : 'This session is not open for scoring. Ask the administrator to open it.',
    ),

  notOnPanel: () =>
    new AppError(
      ErrorCode.NOT_ON_PANEL,
      'You are not assigned to the panel judging this performance.',
    ),

  performanceLocked: (status: string) =>
    new AppError(
      ErrorCode.PERFORMANCE_LOCKED,
      `This performance is ${status} and can no longer be scored.`,
      { details: { status } },
    ),

  markOutOfRange: (mark: number, max: number) =>
    new AppError(
      ErrorCode.MARK_OUT_OF_RANGE,
      `The mark must be between 0 and ${max}. You entered ${mark}.`,
      { details: { mark, min: 0, max } },
    ),

  duplicateChestNumber: (chestNumber: string, existingHolder?: string) =>
    new AppError(
      ErrorCode.DUPLICATE_CHEST_NUMBER,
      existingHolder
        ? `Chest number ${chestNumber} is already assigned to ${existingHolder}.`
        : `Chest number ${chestNumber} is already in use.`,
      { details: { chestNumber, existingHolder } },
    ),

  ineligibleItem: (message: string, details?: unknown) =>
    new AppError(ErrorCode.INELIGIBLE_ITEM, message, { details }),

  entryLimitExceeded: (message: string, details?: unknown) =>
    new AppError(ErrorCode.ENTRY_LIMIT_EXCEEDED, message, { details }),

  resultPublished: (itemName?: string) =>
    new AppError(
      ErrorCode.RESULT_PUBLISHED,
      itemName
        ? `The result for "${itemName}" is published and cannot be changed. Unpublish it first.`
        : 'This result is published and cannot be changed. Unpublish it first.',
    ),

  /** ADM-11-09 */
  configLocked: () =>
    new AppError(
      ErrorCode.CONFIG_LOCKED,
      'Scoring configuration is locked because results have been published. ' +
        'A Super Admin must unpublish all results before it can be changed.',
    ),

  /** 4.5: "Silent tie-breaking is prohibited." */
  tieUnresolved: (details?: unknown) =>
    new AppError(
      ErrorCode.TIE_UNRESOLVED,
      'This item has a tie that the configured tie-break sequence could not resolve. ' +
        'An administrator must decide it before the result can be published.',
      { details },
    ),

  /** ADM-15-07 */
  eventFrozen: (reason?: string | null) =>
    new AppError(
      ErrorCode.EVENT_FROZEN,
      reason
        ? `The event is in read-only freeze mode: ${reason}`
        : 'The event is in read-only freeze mode. No data changes are permitted.',
    ),

  inUse: (message: string, details?: unknown) =>
    new AppError(ErrorCode.IN_USE, message, { details }),

  conflict: (message: string, details?: unknown) =>
    new AppError(ErrorCode.CONFLICT, message, { details }),

  internal: (message = 'Something went wrong. Please try again.', cause?: unknown) =>
    new AppError(ErrorCode.INTERNAL_ERROR, message, { cause }),
};

// ---------------------------------------------------------------------------
// PostgreSQL error translation.
//
// The database is a real participant in enforcement here (FSD 8.2), so its
// errors are part of the contract. A unique-violation on scores is not a bug to
// be logged as a 500 — it is the system correctly refusing a double submission,
// and the client needs the FSD 9.4 code for it.
// ---------------------------------------------------------------------------

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
  message?: string;
  table?: string;
}

function isPgError(error: unknown): error is PgError {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/** Maps a unique-index name to the FSD error it represents. */
const UNIQUE_VIOLATIONS: Record<string, () => AppError> = {
  scores_performance_judge_key: () => errors.alreadyScored(),
  scores_idempotency_key: () => errors.alreadyScored({ reason: 'DUPLICATE_IDEMPOTENCY_KEY' }),
  registrations_item_member_key: () =>
    new AppError(
      ErrorCode.DUPLICATE_REGISTRATION,
      'This member is already registered for this item.',
    ),
  registration_members_item_member_key: () =>
    new AppError(
      ErrorCode.DUPLICATE_REGISTRATION,
      'This member is already entered in this item, either individually or in another team.',
    ),
  registrations_item_team_key: () =>
    new AppError(
      ErrorCode.DUPLICATE_REGISTRATION,
      'A team with that name is already registered for this item.',
    ),
  members_event_chest_key: () =>
    new AppError(ErrorCode.DUPLICATE_CHEST_NUMBER, 'That chest number is already in use.'),
  users_username_key: () =>
    new AppError(ErrorCode.CONFLICT, 'That username is already taken.'),
  churches_name_key: () =>
    new AppError(ErrorCode.CONFLICT, 'A church with that name already exists.'),
  churches_short_code_key: () =>
    new AppError(ErrorCode.CONFLICT, 'A church with that short code already exists.'),
  items_event_code_key: () =>
    new AppError(ErrorCode.CONFLICT, 'An item with that code already exists.'),
  performances_one_current_per_session: () =>
    new AppError(
      ErrorCode.CONFLICT,
      'Another performance is already on stage for this session. Refresh and try again.',
    ),
};

/**
 * Convert a driver-level error into an AppError where it maps to a specified
 * behaviour, or return null to let it be treated as an unexpected fault.
 */
export function translateDatabaseError(error: unknown): AppError | null {
  if (!isPgError(error)) return null;

  switch (error.code) {
    case '23505': {
      // unique_violation
      const mapped = error.constraint ? UNIQUE_VIOLATIONS[error.constraint] : undefined;
      if (mapped) return mapped();
      return new AppError(ErrorCode.CONFLICT, 'That record already exists.', {
        details: { constraint: error.constraint },
        cause: error,
      });
    }
    case '23503':
      // foreign_key_violation — usually an ON DELETE RESTRICT guard.
      return new AppError(
        ErrorCode.IN_USE,
        'This record is referenced by other data and cannot be removed. Deactivate it instead.',
        { details: { constraint: error.constraint }, cause: error },
      );
    case '23514':
      // check_violation — including the performance state-machine trigger.
      return new AppError(ErrorCode.VALIDATION_ERROR, error.message ?? 'That change is not valid.', {
        details: { constraint: error.constraint },
        cause: error,
      });
    case '42501':
      // insufficient_privilege — raised by the immutability triggers (0009).
      return new AppError(
        ErrorCode.IMMUTABLE,
        error.message ?? 'This record is immutable and cannot be changed.',
        { cause: error },
      );
    case '57014':
      // query_canceled — statement_timeout exceeded.
      return new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        'The request took too long and was cancelled. Please try again.',
        { cause: error },
      );
    case '53300':
      return new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        'The system is busy. Please try again in a moment.',
        { cause: error },
      );
    default:
      return null;
  }
}
