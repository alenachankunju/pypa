-- =============================================================================
-- 0017_import_batch_types.sql
-- Extends import_batch_type (0001_extensions_and_enums.sql) for the new
-- category and item bulk-import screens, alongside the existing CHURCHES and
-- MEMBERS staging flows.
-- =============================================================================

ALTER TYPE import_batch_type ADD VALUE 'CATEGORIES';
ALTER TYPE import_batch_type ADD VALUE 'ITEMS';
