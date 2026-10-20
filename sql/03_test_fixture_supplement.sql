-- ============================================================================
--  new_lab_pipeline — TEST FIXTURE SUPPLEMENT
-- ============================================================================
--  LOCAL TEST DATABASES ONLY. Never run this against Azure.
--
--  01_create_new_lab_pipeline_hybrid.sql is the Sept. 10 capture baseline and
--  says so in its own header: the live database has since gained app-contract
--  tables it does not define. One of them, subject_identity_binding, is read
--  by db.py on every tap resolution, which meant tests/test_capture_flow.py
--  could not run at all from the committed SQL — it died on 1146 before the
--  first assertion.
--
--  This file adds only what the CV capture tests actually touch. It is not an
--  attempt to mirror the whole live schema, and it must not become one: a
--  fixture that invents tables is how the drift this file exists to fix got
--  started.
--
--  Reconciled against live new_lab_pipeline on 2026-10-20 from
--  information_schema.COLUMNS, .STATISTICS and the GENERATION_EXPRESSION of
--  the virtual columns. Foreign keys were NOT captured from live; the ones
--  below are inferred from the auto-named indexes live carries on those
--  columns, and exist so the fixture rejects orphans the way live will.
--
--  Run order:  01_create_new_lab_pipeline_hybrid.sql  →  this file
-- ============================================================================

USE `new_lab_pipeline`;

-- ============================================================
--  subject_identity_binding
-- ============================================================
--  The ONLY table that links an anonymous capture subject to a named athlete.
--  CV reads it and never writes it: db.py asks a single EXISTS question — is
--  this subject or this tag claimed yet — and reports the answer as the
--  `enrolled` flag so the station can nudge staff to reconcile at the desk.
--  Capture is never gated on it.
--
--  It legitimately holds athlete_id. That is the point of the table, and it is
--  why it belongs on the identity allowlist in 02_verify_constraints.sql
--  rather than tripping the no-identity-column rule.
CREATE TABLE IF NOT EXISTS `subject_identity_binding` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `anonymous_capture_subject_id` INT NOT NULL,
  `nfc_tag_id` INT NOT NULL,
  `athlete_id` INT NOT NULL,
  `event_session_id` INT NULL,
  `event_roster_entry_id` INT NULL,
  `paired_via` VARCHAR(20) NOT NULL COMMENT 'How the claim happened: desk, binder, self-service, etc.',
  `paired_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `revoked_at` DATETIME(3) NULL,
  `revoked_by` VARCHAR(100) NULL,
  `revoked_reason` VARCHAR(255) NULL,
  `claim_ip` VARCHAR(45) NULL,
  `user_agent` VARCHAR(500) NULL,
  `device_label` VARCHAR(100) NULL,
  `operator` VARCHAR(100) NULL,
  `notes` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,

  -- The MySQL one-active-row trick, same as subject_tag_binding: MySQL ignores
  -- NULLs in a unique key, so a column that is 1 while active and NULL
  -- otherwise gives "at most one active row per subject/per tag" without the
  -- partial indexes MySQL does not have.
  --
  -- Both flags key off status rather than one off status and one off a date,
  -- which is what live does. They are therefore identical expressions; the two
  -- columns exist so each can pair with a different leading column below.
  `active_subject_flag` TINYINT GENERATED ALWAYS AS (IF(`status` = 'active', 1, NULL)) VIRTUAL,
  `active_tag_flag`     TINYINT GENERATED ALWAYS AS (IF(`status` = 'active', 1, NULL)) VIRTUAL,

  FOREIGN KEY (`anonymous_capture_subject_id`) REFERENCES `anonymous_capture_subject` (`id`),
  FOREIGN KEY (`nfc_tag_id`) REFERENCES `nfc_tag` (`id`),
  FOREIGN KEY (`athlete_id`) REFERENCES `athlete` (`id`),
  FOREIGN KEY (`event_session_id`) REFERENCES `event_session` (`id`),
  FOREIGN KEY (`event_roster_entry_id`) REFERENCES `event_roster_entry` (`id`),

  UNIQUE KEY `uq_active_identity_per_subject` (`anonymous_capture_subject_id`, `active_subject_flag`),
  UNIQUE KEY `uq_active_identity_per_tag` (`nfc_tag_id`, `active_tag_flag`),
  KEY `ix_identity_binding_athlete` (`athlete_id`, `paired_at`),
  KEY `ix_identity_binding_path` (`paired_via`, `paired_at`)
) COMMENT = 'Layer 1. The subject-to-athlete claim. CV reads only.';
