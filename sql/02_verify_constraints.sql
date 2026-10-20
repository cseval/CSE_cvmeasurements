-- ============================================================================
--  new_lab_pipeline — constraint verification
-- ============================================================================
--  CURRENT STATUS WARNING: this verifies the historical hybrid capture
--  baseline only. It does not cover the current app-contract additions in the
--  live new_lab_pipeline database: subject_identity_binding,
--  checkin_pairing_event, binder_pairing_event, player/entity_crosswalk, or the
--  CV-read-only bracelet setup rule. See cse-lab-pipeline/docs/prd/ for the
--  current contracts and verification expectations.
-- ============================================================================
--  PDR §9 acceptance checklist: "nfc_tag_assignment's uniqueness constraints
--  actually reject a second simultaneously-active row per tag and per athlete
--  — test this explicitly, don't just trust the DDL comment."
--
--  This does that, for both the assignment table and the hybrid's
--  subject_tag_binding, plus the session/trial uniqueness the CV app relies on
--  and the no-identity-column rule.
--
--  Run against a scratch copy, not a database with real capture in it — it
--  inserts and then rolls back / deletes its own fixtures.
--
--    mysql ... new_lab_pipeline < sql/02_verify_constraints.sql
--
--  Every check prints PASS or FAIL. Any FAIL means the schema is not enforcing
--  something the application assumes, and the app will happily write data that
--  cannot be resolved later.
-- ============================================================================

USE `new_lab_pipeline`;

-- ------------------------------------------------------ preflight cleanup
-- Runs first so an earlier aborted run cannot block this one. The 9000-block
-- ids are reserved for these fixtures and are not used by the application,
-- which assigns ids with AUTO_INCREMENT.
DELETE FROM `lab_movement_screen` WHERE `capture_trial_id` IN (9001, 9002, 9003, 9004);
DELETE FROM `capture_trial`       WHERE `id` IN (9001, 9002, 9003, 9004);
DELETE FROM `capture_session`     WHERE `id` IN (9001, 9002, 9003, 9004, 9005);
UPDATE `subject_tag_binding` SET `previous_binding_id`    = NULL WHERE `id` IN (9001, 9002, 9003, 9004);
UPDATE `nfc_tag_assignment`  SET `previous_assignment_id` = NULL WHERE `id` IN (9001, 9002, 9003, 9004);
DELETE FROM `subject_tag_binding` WHERE `id` IN (9001, 9002, 9003, 9004);
DELETE FROM `nfc_tag_assignment`  WHERE `id` IN (9001, 9002, 9003, 9004);
DELETE FROM `anonymous_capture_subject` WHERE `id` IN (9001, 9002);
DELETE FROM `nfc_tag`             WHERE `id` IN (9001, 9002);
DELETE FROM `athlete`             WHERE `id` IN (9001, 9002);

-- ---------------------------------------------------------------- fixtures
INSERT INTO `athlete` (`id`, `display_label`) VALUES (9001, 'TEST-A'), (9002, 'TEST-B');
INSERT INTO `nfc_tag` (`id`, `tag_uid`, `chip_type`) VALUES
  (9001, 'TESTUID0000001', 'NTAG215'),
  (9002, 'TESTUID0000002', 'NTAG215');
INSERT INTO `anonymous_capture_subject` (`id`, `subject_token`) VALUES
  (9001, 'TC-TEST-0001'), (9002, 'TC-TEST-0002');

-- ============================================================
-- 1. nfc_tag_assignment: one ACTIVE assignment per tag
-- ============================================================
INSERT INTO `nfc_tag_assignment` (`id`, `tag_id`, `athlete_id`) VALUES (9001, 9001, 9001);

SET @err := 0;
-- Same tag, different athlete, both active -> must be rejected.
INSERT IGNORE INTO `nfc_tag_assignment` (`id`, `tag_id`, `athlete_id`) VALUES (9002, 9001, 9002);
SELECT IF(ROW_COUNT() = 0, 'PASS', 'FAIL')            AS result,
       'one active assignment per tag is enforced'    AS check_name;

-- ============================================================
-- 2. nfc_tag_assignment: one ACTIVE assignment per athlete
-- ============================================================
-- Same athlete, different tag, both active -> must be rejected.
INSERT IGNORE INTO `nfc_tag_assignment` (`id`, `tag_id`, `athlete_id`) VALUES (9003, 9002, 9001);
SELECT IF(ROW_COUNT() = 0, 'PASS', 'FAIL')             AS result,
       'one active assignment per athlete is enforced' AS check_name;

-- ============================================================
-- 3. Reissue path: unbind, then rebind the same athlete to a new tag
-- ============================================================
-- This is the lost-bracelet story. It must succeed AFTER the first is closed.
UPDATE `nfc_tag_assignment`
   SET `active_to` = NOW(), `assignment_status` = 'ended', `reissue_reason` = 'lost'
 WHERE `id` = 9001;

INSERT IGNORE INTO `nfc_tag_assignment`
  (`id`, `tag_id`, `athlete_id`, `previous_assignment_id`)
  VALUES (9004, 9002, 9001, 9001);
SELECT IF(ROW_COUNT() = 1, 'PASS', 'FAIL')                    AS result,
       'reissue to a new tag succeeds once prior is closed'   AS check_name;

-- And the retired row must still be there — history is not overwritten.
SELECT IF(COUNT(*) = 2, 'PASS', 'FAIL')                       AS result,
       'retired assignment row is retained, not replaced'     AS check_name
  FROM `nfc_tag_assignment` WHERE `athlete_id` = 9001;

-- ============================================================
-- 4. subject_tag_binding: same two rules (the hybrid addition)
-- ============================================================
INSERT INTO `subject_tag_binding`
  (`id`, `anonymous_capture_subject_id`, `nfc_tag_id`) VALUES (9001, 9001, 9001);

INSERT IGNORE INTO `subject_tag_binding`
  (`id`, `anonymous_capture_subject_id`, `nfc_tag_id`) VALUES (9002, 9002, 9001);
SELECT IF(ROW_COUNT() = 0, 'PASS', 'FAIL')         AS result,
       'one active binding per tag is enforced'    AS check_name;

INSERT IGNORE INTO `subject_tag_binding`
  (`id`, `anonymous_capture_subject_id`, `nfc_tag_id`) VALUES (9003, 9001, 9002);
SELECT IF(ROW_COUNT() = 0, 'PASS', 'FAIL')          AS result,
       'one active binding per subject is enforced' AS check_name;

-- Rebind a replacement bracelet to the SAME subject. This is what preserves
-- capture history across a lost bracelet — the whole reason subject_token is
-- opaque rather than the raw UID.
UPDATE `subject_tag_binding`
   SET `active_to` = NOW(), `unbind_reason` = 'lost' WHERE `id` = 9001;
INSERT IGNORE INTO `subject_tag_binding`
  (`id`, `anonymous_capture_subject_id`, `nfc_tag_id`, `previous_binding_id`)
  VALUES (9004, 9001, 9002, 9001);
SELECT IF(ROW_COUNT() = 1, 'PASS', 'FAIL')                        AS result,
       'replacement bracelet rebinds to the same subject'         AS check_name;

-- ============================================================
-- 5. capture_session: one per subject / station / day / sport / movement
-- ============================================================
INSERT INTO `capture_session`
  (`id`, `anonymous_capture_subject_id`, `station_source_id`, `capture_date`)
  SELECT 9001, 9001, `id`, '2026-09-10' FROM `station_source` WHERE `code` = 'cv_app';

INSERT IGNORE INTO `capture_session`
  (`id`, `anonymous_capture_subject_id`, `station_source_id`, `capture_date`)
  SELECT 9002, 9001, `id`, '2026-09-10' FROM `station_source` WHERE `code` = 'cv_app';
SELECT IF(ROW_COUNT() = 0, 'PASS', 'FAIL')                              AS result,
       'second session for same subject/station/day is rejected'        AS check_name;

-- A different day IS a new session.
INSERT IGNORE INTO `capture_session`
  (`id`, `anonymous_capture_subject_id`, `station_source_id`, `capture_date`)
  SELECT 9003, 9001, `id`, '2026-09-17' FROM `station_source` WHERE `code` = 'cv_app';
SELECT IF(ROW_COUNT() = 1, 'PASS', 'FAIL')                     AS result,
       'a later visit creates a new session'                    AS check_name;

-- Same subject, same station, same day, DIFFERENT movement IS a new session.
-- This is the whole reason sport and movement joined the key on 2026-10-20:
-- QTM records pitching and hitting for one athlete on one day, and the
-- three-column key collapsed them into a single session.
INSERT IGNORE INTO `capture_session`
  (`id`, `anonymous_capture_subject_id`, `station_source_id`, `capture_date`,
   `sport`, `movement`)
  SELECT 9004, 9001, `id`, '2026-09-10', 'softball', 'pitching'
    FROM `station_source` WHERE `code` = 'cv_app';
SELECT IF(ROW_COUNT() = 1, 'PASS', 'FAIL')                           AS result,
       'a different movement on the same day is a new session'       AS check_name;

INSERT IGNORE INTO `capture_session`
  (`id`, `anonymous_capture_subject_id`, `station_source_id`, `capture_date`,
   `sport`, `movement`)
  SELECT 9005, 9001, `id`, '2026-09-10', 'softball', 'pitching'
    FROM `station_source` WHERE `code` = 'cv_app';
SELECT IF(ROW_COUNT() = 0, 'PASS', 'FAIL')                           AS result,
       'the same sport+movement twice in a day is still rejected'    AS check_name;

-- ============================================================
-- 6. capture_trial: a repeat measurement is a new trial, never an overwrite
-- ============================================================
INSERT INTO `capture_trial`
  (`id`, `capture_session_id`, `trial_number`, `trial_type`, `trial_timestamp`)
  VALUES (9001, 9001, 1, 'movement_screen', UTC_TIMESTAMP(3));
INSERT INTO `capture_trial`
  (`id`, `capture_session_id`, `trial_number`, `trial_type`, `trial_timestamp`)
  VALUES (9002, 9001, 2, 'movement_screen', UTC_TIMESTAMP(3));
SELECT IF(COUNT(*) = 2, 'PASS', 'FAIL')                        AS result,
       'two trials coexist in one session'                     AS check_name
  FROM `capture_trial` WHERE `capture_session_id` = 9001;

INSERT IGNORE INTO `capture_trial`
  (`id`, `capture_session_id`, `trial_number`, `trial_type`, `trial_timestamp`)
  VALUES (9003, 9001, 2, 'movement_screen', UTC_TIMESTAMP(3));
SELECT IF(ROW_COUNT() = 0, 'PASS', 'FAIL')                     AS result,
       'duplicate trial_number in a session is rejected'       AS check_name;

-- ============================================================
-- 6b. client_ref: a retried submit cannot duplicate a trial
-- ============================================================
-- The station writes locally first and retries in the background, so the same
-- trial gets submitted again whenever wifi drops mid-request. Without this,
-- one athlete's measurement lands twice and the duplicate is indistinguishable
-- from a legitimate second trial.
UPDATE `capture_trial` SET `client_ref` = 'test-ref-0001' WHERE `id` = 9001;
INSERT IGNORE INTO `capture_trial`
  (`id`, `capture_session_id`, `trial_number`, `trial_type`, `trial_timestamp`, `client_ref`)
  VALUES (9004, 9001, 3, 'movement_screen', UTC_TIMESTAMP(3), 'test-ref-0001');
SELECT IF(ROW_COUNT() = 0, 'PASS', 'FAIL')                     AS result,
       'a resubmitted client_ref cannot create a second trial' AS check_name;

-- ============================================================
-- 7. lab_movement_screen: one result row per trial
-- ============================================================
INSERT INTO `lab_movement_screen`
  (`capture_trial_id`, `height_cm`, `wingspan_cm`, `hand_span_cm`, `recorded_at`)
  VALUES (9001, 170.25, 172.50, 19.30, UTC_TIMESTAMP(3));
INSERT IGNORE INTO `lab_movement_screen`
  (`capture_trial_id`, `height_cm`, `recorded_at`)
  VALUES (9001, 171.00, UTC_TIMESTAMP(3));
SELECT IF(ROW_COUNT() = 0, 'PASS', 'FAIL')                        AS result,
       'second movement_screen row for one trial is rejected'     AS check_name;

-- Centimetre precision survives the round trip. The old production path
-- rounded wingspan to a whole inch (1.27cm of quantization); this must not.
SELECT IF(`wingspan_cm` = 172.50, 'PASS', 'FAIL')                 AS result,
       'decimal cm precision is preserved on write'               AS check_name
  FROM `lab_movement_screen` WHERE `capture_trial_id` = 9001;

-- ============================================================
-- 8. The one rule: no identity column outside the allowed Layer 1 tables
-- ============================================================
-- NOTE ON THE ALLOWLIST. PDR §9 names five tables: athlete, entity_crosswalk,
-- guardian, guardian_athlete_relationship, nfc_tag_assignment. That list is
-- incomplete against the PDR's own DDL — §7 gives event_roster_entry an
-- athlete_id column, and §4 places it in Layer 1. A roster is a list of people
-- by definition, so it belongs on the allowlist; the checklist just missed it.
-- Flagged rather than silently widened: if the intent was that a roster entry
-- should NOT carry identity, then the PDR's own event_roster_entry DDL is the
-- thing to change, not this query.
--
-- Nothing else may appear here. A hit in any Layer 2 or Layer 3 table is a
-- real defect, not a checklist gap.
SELECT IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL: ', GROUP_CONCAT(CONCAT(`TABLE_NAME`, '.', `COLUMN_NAME`)))) AS result,
       'no identity column leaked into the capture layer'                                                 AS check_name
  FROM `information_schema`.`COLUMNS`
 WHERE `TABLE_SCHEMA` = 'new_lab_pipeline'
   AND `COLUMN_NAME` IN ('athlete_id', 'player_id', 'cse_player_id', 'first_name', 'last_name', 'email', 'dob', 'date_of_birth')
   AND `TABLE_NAME` NOT IN ('athlete', 'entity_crosswalk', 'guardian',
                            'guardian_athlete_relationship', 'nfc_tag_assignment',
                            'event_roster_entry',
                            -- Added 2026-10-20. This is the table whose entire
                            -- job is linking a subject to an athlete, so it
                            -- holds athlete_id by design. See sql/03.
                            'subject_identity_binding');

-- NOTE, 2026-10-20: run against LIVE rather than a fixture, the check above
-- will report failures that are not leaks. Live has tables this allowlist
-- predates — player, parent_athlete_relationship, athlete_merge_history,
-- checkin_pairing_event, binder_pairing_event, event_team — and live calls
-- the guardian concept `parent*`, so the two guardian entries here match
-- nothing. Reconcile the list against the live table set before treating a
-- failure here as real.

-- ============================================================
-- 9. The generated columns are still present and still indexed
-- ============================================================
-- Guards against a future migration tool quietly dropping them and leaving
-- the uniqueness rules to application code.
SELECT IF(COUNT(*) = 4, 'PASS', CONCAT('FAIL: found ', COUNT(*), ' of 4'))  AS result,
       'active-flag generated columns still exist'                          AS check_name
  FROM `information_schema`.`COLUMNS`
 WHERE `TABLE_SCHEMA` = 'new_lab_pipeline'
   AND `COLUMN_NAME` IN ('active_tag_flag', 'active_athlete_flag', 'active_subject_flag')
   AND `TABLE_NAME` IN ('nfc_tag_assignment', 'subject_tag_binding');

-- ---------------------------------------------------------------- teardown
DELETE FROM `lab_movement_screen` WHERE `capture_trial_id` IN (9001, 9002, 9003, 9004);
DELETE FROM `capture_trial`       WHERE `id` IN (9001, 9002, 9003, 9004);
DELETE FROM `capture_session`     WHERE `id` IN (9001, 9002, 9003, 9004, 9005);
-- Both of these tables self-reference (previous_*_id), and DELETE ... IN (...)
-- does not honour the order you list, so break the chains first.
UPDATE `subject_tag_binding` SET `previous_binding_id`    = NULL WHERE `id` IN (9001, 9002, 9003, 9004);
UPDATE `nfc_tag_assignment`  SET `previous_assignment_id` = NULL WHERE `id` IN (9001, 9002, 9003, 9004);
DELETE FROM `subject_tag_binding` WHERE `id` IN (9001, 9002, 9003, 9004);
DELETE FROM `nfc_tag_assignment`  WHERE `id` IN (9001, 9002, 9003, 9004);
DELETE FROM `anonymous_capture_subject` WHERE `id` IN (9001, 9002);
DELETE FROM `nfc_tag`             WHERE `id` IN (9001, 9002);
DELETE FROM `athlete`             WHERE `id` IN (9001, 9002);
