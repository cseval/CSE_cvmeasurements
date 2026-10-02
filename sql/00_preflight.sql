-- ============================================================================
--  new_lab_pipeline — PREFLIGHT INVENTORY
-- ============================================================================
--  Read-only. Creates nothing, changes nothing, drops nothing.
--
--  Run this BEFORE 01_create_new_lab_pipeline_hybrid.sql. The database already
--  exists in Azure, so what matters is what is already inside it — and there
--  are three possible histories, which need three different next steps:
--
--    A. Empty                    -> run 01 as-is.
--    B. The PDR's DDL was run    -> anonymous_capture_subject will have an
--                                   nfc_tag_id column and there will be no
--                                   subject_tag_binding. The hybrid needs a
--                                   migration, not a fresh create.
--    C. migrations/02_station_extras.sql from the other NFC branch was run
--                                -> movement_screen_result and/or a
--                                   station_tap_log with scan_event's columns
--                                   already exist.
--
--  01 uses bare CREATE TABLE, so it will stop on the first collision rather
--  than silently half-applying. That is deliberate. Find out which case you
--  are in first.
--
--      mysql -h <host> -u <user> -p new_lab_pipeline < sql/00_preflight.sql
-- ============================================================================

SELECT DATABASE() AS connected_to, VERSION() AS server_version, NOW() AS run_at;

-- ---------------------------------------------------------------- 1. tables
SELECT
    `TABLE_NAME`   AS table_name,
    `TABLE_ROWS`   AS approx_rows,
    `CREATE_TIME`  AS created,
    `TABLE_COMMENT` AS comment
  FROM `information_schema`.`TABLES`
 WHERE `TABLE_SCHEMA` = DATABASE()
 ORDER BY `TABLE_NAME`;

-- --------------------------------------------- 2. which history is this?
SELECT
    CASE
      WHEN (SELECT COUNT(*) FROM `information_schema`.`TABLES`
             WHERE `TABLE_SCHEMA` = DATABASE()) = 0
        THEN 'A: EMPTY — run 01 as-is'
      WHEN EXISTS (SELECT 1 FROM `information_schema`.`COLUMNS`
                    WHERE `TABLE_SCHEMA` = DATABASE()
                      AND `TABLE_NAME` = 'subject_tag_binding')
        THEN 'ALREADY HYBRID — 01 has been run here; skip it and run 02 only'
      WHEN EXISTS (SELECT 1 FROM `information_schema`.`COLUMNS`
                    WHERE `TABLE_SCHEMA` = DATABASE()
                      AND `TABLE_NAME` = 'anonymous_capture_subject'
                      AND `COLUMN_NAME` = 'nfc_tag_id')
        THEN 'B: PDR DDL APPLIED — needs the migration path, NOT a fresh 01'
      WHEN EXISTS (SELECT 1 FROM `information_schema`.`TABLES`
                    WHERE `TABLE_SCHEMA` = DATABASE()
                      AND `TABLE_NAME` IN ('movement_screen_result', 'station_tap_log'))
        THEN 'C: OTHER BRANCH MIGRATION APPLIED — reconcile before running 01'
      ELSE 'PARTIAL/UNKNOWN — inspect the table list above before running 01'
    END AS verdict;

-- --------------------------------------- 3. collisions 01 would hit
-- Every table 01 creates. Anything listed here already exists and will stop
-- the script.
SELECT `TABLE_NAME` AS would_collide, `TABLE_ROWS` AS approx_rows
  FROM `information_schema`.`TABLES`
 WHERE `TABLE_SCHEMA` = DATABASE()
   AND `TABLE_NAME` IN (
     'athlete', 'entity_crosswalk', 'guardian', 'guardian_athlete_relationship',
     'event', 'event_session', 'event_roster_entry',
     'station_source', 'nfc_tag', 'nfc_tag_assignment',
     'anonymous_capture_subject', 'subject_tag_binding', 'source_import_batch',
     'capture_session', 'capture_trial', 'scan_event', 'station_tap_log',
     'file_artifact', 'lab_movement_screen',
     'land_qtm_capture_meta', 'land_qtm_marker_raw', 'land_theia_segment_frame',
     'land_theia_inertia', 'land_theia_metadata', 'land_force_platform_geometry',
     'land_qrf_raw', 'raw_rapsodo_pitch', 'raw_rapsodo_swing'
   )
 ORDER BY `TABLE_NAME`;

-- ------------------------------- 4. is there real capture data in here?
-- Decides whether a drop-and-recreate is even on the table. Any non-zero
-- count means it is not.
SELECT 'capture_trial' AS tbl,
       (SELECT COUNT(*) FROM `information_schema`.`TABLES`
         WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'capture_trial') AS exists_flag;

-- ------------------------------ 5. the two shapes that differ most
-- If anonymous_capture_subject exists, its columns say which design is in
-- place: an nfc_tag_id column is the PDR shape, and its absence plus a
-- subject_tag_binding table is the hybrid.
SELECT `TABLE_NAME` AS tbl, `COLUMN_NAME` AS col, `COLUMN_TYPE` AS type,
       `IS_NULLABLE` AS nullable, `COLUMN_KEY` AS keys
  FROM `information_schema`.`COLUMNS`
 WHERE `TABLE_SCHEMA` = DATABASE()
   AND `TABLE_NAME` IN ('anonymous_capture_subject', 'subject_tag_binding',
                        'capture_trial', 'lab_movement_screen',
                        'movement_screen_result', 'station_tap_log', 'scan_event')
 ORDER BY `TABLE_NAME`, `ORDINAL_POSITION`;

-- ------------------------- 6. can this account do what 01 needs?
-- 01 creates tables with generated columns and foreign keys. A grant that
-- covers SELECT/INSERT but not CREATE fails halfway through, which is a
-- worse place to find out.
SHOW GRANTS FOR CURRENT_USER();
