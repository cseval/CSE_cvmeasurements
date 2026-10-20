-- ============================================================================
--  new_lab_pipeline — V1 HYBRID SCHEMA
-- ============================================================================
--  CURRENT STATUS WARNING (post app-contract cleanup): this file is the
--  historical Sept. 10 hybrid capture baseline, not the complete live V1 test
--  schema. The live new_lab_pipeline database has since gained app-contract
--  tables/columns such as player, entity_crosswalk, subject_identity_binding,
--  checkin_pairing_event, binder_pairing_event, binder station seed, and the
--  current decision that CV Measurement is read-only for nfc_tag,
--  anonymous_capture_subject, and subject_tag_binding setup.
--
--  Do not use this file alone as the current source of truth. See:
--    cse-lab-pipeline/docs/prd/new-lab-pipeline-schema-decisions.md
--    cse-lab-pipeline/docs/prd/new-lab-pipeline-app-database-contracts.md
-- ============================================================================
--  Resolves the two-competing-schemas fork documented in the CV measurement
--  app rebuild handoff (§3.0). Decision: HYBRID.
--
--  Base is Schema A (new-lab-pipeline-pdr.md): three layers, capture_trial
--  with a trial_type discriminator. The V1 diagram and the NFC station
--  validation protocol's acceptance queries are written against this shape.
--
--  Three things are pulled forward from Schema B (01_create_cse_v2_schema.sql,
--  the cse_db_v2_dev design), because Schema A either leaves them to the
--  application layer or cannot express them:
--
--    1. subject_token is a genuinely OPAQUE token, never the raw bracelet UID.
--       Schema A's PDR says subject_token is "usually equal to nfc_tag.tag_uid".
--       Filling it with the UID is the tempting shortcut and it destroys the
--       lost-bracelet story, because the subject then IS the physical tag.
--    2. `subject_tag_binding` — Schema B's token_binding role. The physical
--       medium binds to the durable subject, so replacing a lost bracelet is an
--       unbind/rebind and the subject's capture history is untouched. This
--       REPLACES Schema A's anonymous_capture_subject.nfc_tag_id column.
--    3. `scan_event` and `station_source` — an every-tap audit log and a
--       constrained station lookup, instead of free-text station codes and
--       application-layer handling of unresolved taps.
--
--  Plus one addition that neither schema had (handoff §6.1):
--    4. `lab_movement_screen` — somewhere to actually put the measurements.
--
--  ---------------------------------------------------------------------------
--  !! NAMING WARNING !!
--  `lab_movement_screen` in THIS database is a NEW anonymous table keyed to
--  capture_trial_id. A DIFFERENT, identity-native table of the same name
--  already exists in the PRODUCTION database (cse_db), carrying cse_player_id,
--  first_name and last_name. They are not the same table and must never be
--  joined as if they were. Always qualify the database name in any query that
--  could touch both.
--  ---------------------------------------------------------------------------
--
--  Run top to bottom. Later tables have FKs into earlier ones.
--  Target: Azure Database for MySQL (cse_db_test.csedb.mysql.database.azure.com)
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `new_lab_pipeline`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE `new_lab_pipeline`;

-- ============================================================
-- THE ONE RULE (PDR §3), restated because the DDL has to enforce it
-- ============================================================
-- Raw capture tables never carry athlete_id, player_id or cse_player_id.
-- The ONLY table linking a physical tag to an athlete identity is
-- nfc_tag_assignment. Everything else joins through it, and beyond this
-- database through entity_crosswalk. No exceptions in this schema.

-- ============================================================
-- LAYER 1: Operational identity & event (thin, local — not a copy of prod PII)
-- ============================================================

CREATE TABLE `athlete` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `display_label` VARCHAR(100) COMMENT 'Local, non-PII label only (e.g. an internal reference code). Name/email/DOB live in production and are reached via entity_crosswalk, never duplicated here.',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `entity_crosswalk` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `athlete_id` INT NOT NULL,
  `source_system` VARCHAR(50) NOT NULL COMMENT 'e.g. cse_prod, tcs, auth_user',
  `external_id` VARCHAR(100) NOT NULL COMMENT 'e.g. the cse_player_id value in production',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`athlete_id`) REFERENCES `athlete` (`id`),
  UNIQUE KEY `uq_crosswalk_source` (`source_system`, `external_id`)
) COMMENT = 'Maps this database''s local athlete.id out to real identity systems. The only place a real-world identifier (cse_player_id, TCS person ID) appears.';

CREATE TABLE `guardian` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `display_label` VARCHAR(100) COMMENT 'Same non-PII rule as athlete.display_label.',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) COMMENT = 'Stub for V1. Populate only if/when consent or minor-athlete workflows require it locally; not required for capture itself.';

CREATE TABLE `guardian_athlete_relationship` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `guardian_id` INT NOT NULL,
  `athlete_id` INT NOT NULL,
  `relationship_type` VARCHAR(30),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`guardian_id`) REFERENCES `guardian` (`id`),
  FOREIGN KEY (`athlete_id`) REFERENCES `athlete` (`id`)
);

CREATE TABLE `event` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `name` VARCHAR(255),
  `start_date` DATE,
  `external_event_ref` VARCHAR(100) COMMENT 'Optional pointer back to a production events/showcase ID, if this lab visit is tied to one.'
);

CREATE TABLE `event_session` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `event_id` INT,
  `session_date` DATE,
  `location` VARCHAR(100),
  `lab` VARCHAR(50),
  FOREIGN KEY (`event_id`) REFERENCES `event` (`id`)
);

CREATE TABLE `event_roster_entry` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `event_session_id` INT NOT NULL,
  `athlete_id` INT NOT NULL,
  `status` VARCHAR(20) COMMENT 'e.g. expected, checked_in, no_show. Gates reporting visibility, never gates capture.',
  FOREIGN KEY (`event_session_id`) REFERENCES `event_session` (`id`),
  FOREIGN KEY (`athlete_id`) REFERENCES `athlete` (`id`)
);

-- ============================================================
-- LAYER 2: Anonymous capture — stations, NFC lifecycle, subjects, trials
-- ============================================================

-- HYBRID ADDITION 3a (from Schema B's station_source).
-- Schema A had capture_session.source_device as free text, which means station
-- codes drift ('cv_app', 'cv-app', 'CV App') and grouping by station silently
-- splits. This constrains them.
CREATE TABLE `station_source` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `code` VARCHAR(30) NOT NULL UNIQUE COMMENT 'Stable machine code, e.g. cv_app. Never rename in place — retire and add.',
  `label` VARCHAR(100) NOT NULL,
  `is_closed_system` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = no injection point for a tag UID (Rapsodo, Trackman, Blast). These stations cannot write scan_event at capture time and must be joined on a timestamp window via station_tap_log instead.',
  `active` TINYINT(1) NOT NULL DEFAULT 1
) COMMENT = 'Lookup of every station that produces capture in the lab.';

INSERT INTO `station_source` (`code`, `label`, `is_closed_system`) VALUES
  ('cv_app',    'CV measurement app',        0),
  ('checkin',   'NFC check-in station',      0),
  ('qtm',       'QTM cameras / force plates', 0),
  ('rapsodo',   'Rapsodo',                   1),
  ('trackman',  'TrackMan',                  1),
  ('blast',     'Blast Motion',              1);

CREATE TABLE `nfc_tag` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `tag_uid` VARCHAR(32) NOT NULL UNIQUE COMMENT 'Physical serial burned at the factory, uppercase hex, no separators. VARCHAR(32) not (20): UID length is chip-dependent and is NOT fixed. Observed in the ordered bracelets: 14 chars (7-byte NTAG21x, all starting 04). Also in circulation: 8 chars (4-byte, Mifare-Classic-family). Never hard-code a length anywhere.',
  `chip_type` VARCHAR(30) COMMENT 'e.g. NTAG213, NTAG215, MifareClassic1K. Recorded from observation at enrollment, not assumed.',
  `tag_type` VARCHAR(30) DEFAULT 'bracelet' COMMENT 'bracelet / card / other physical medium.',
  `status` VARCHAR(20) DEFAULT 'issued' COMMENT 'issued / lost / retired. Physical object state only — has nothing to do with which athlete or subject it is linked to.',
  `issued_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `retired_at` TIMESTAMP NULL,
  `lost_at` TIMESTAMP NULL,
  `notes` VARCHAR(255)
);

-- The ONLY tag-to-identity link in this database.
CREATE TABLE `nfc_tag_assignment` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `tag_id` INT NOT NULL,
  `athlete_id` INT NOT NULL,
  `active_from` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `active_to` TIMESTAMP NULL COMMENT 'NULL = currently active. Set when the tag is lost/replaced.',
  `assignment_status` VARCHAR(20) DEFAULT 'active',
  `reissue_reason` VARCHAR(100) COMMENT 'e.g. lost, damaged. Populated only when active_to is set.',
  `previous_assignment_id` INT NULL COMMENT 'Chains to the prior assignment for this athlete, if this row exists because of a reissue.',
  `created_by` VARCHAR(100),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- MySQL has no partial unique index, so these generated columns simulate
  -- "unique WHERE active_to IS NULL". MySQL unique indexes allow unlimited
  -- NULLs, so only two simultaneously-active rows would ever collide.
  -- THESE COLUMNS ARE LOAD-BEARING. Do not drop them and move the constraint
  -- into application code — it has to hold against a raw INSERT too.
  `active_tag_flag` TINYINT GENERATED ALWAYS AS (IF(`active_to` IS NULL, 1, NULL)) VIRTUAL,
  `active_athlete_flag` TINYINT GENERATED ALWAYS AS (IF(`active_to` IS NULL, 1, NULL)) VIRTUAL,
  FOREIGN KEY (`tag_id`) REFERENCES `nfc_tag` (`id`),
  FOREIGN KEY (`athlete_id`) REFERENCES `athlete` (`id`),
  FOREIGN KEY (`previous_assignment_id`) REFERENCES `nfc_tag_assignment` (`id`),
  UNIQUE KEY `uq_one_active_per_tag` (`tag_id`, `active_tag_flag`),
  UNIQUE KEY `uq_one_active_per_athlete` (`athlete_id`, `active_athlete_flag`)
) COMMENT = 'The ONLY table in this database where a tag and an athlete identity are linked. Written by the check-in station at enrollment, never by a capture station.';

-- HYBRID CHANGE 1: subject_token is opaque, and nfc_tag_id is GONE from here.
CREATE TABLE `anonymous_capture_subject` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `subject_token` VARCHAR(64) NOT NULL UNIQUE COMMENT 'OPAQUE, generated by us. Format TC-XXXX-XXXX over a 30-char ambiguity-free alphabet (no I/L/O/U/0/1). It is deliberately NOT the bracelet UID: the UID lives in nfc_tag and reaches this row through subject_tag_binding. That indirection is the whole point — it is what makes a replaced bracelet a rebinding instead of a new subject with no history.',
  `capture_method` VARCHAR(20) NOT NULL DEFAULT 'nfc' COMMENT 'nfc / qr / manual / device_generated. A future non-NFC method plugs in here with no schema change.',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) COMMENT = 'What the capture layer keys off. Deliberately references neither nfc_tag_assignment nor athlete. Layer 3 only ever needs this table, never identity.';

-- HYBRID ADDITION 2 (Schema B's token_binding role).
-- Replaces anonymous_capture_subject.nfc_tag_id. Same generated-column trick
-- as nfc_tag_assignment, for the same MySQL reason.
CREATE TABLE `subject_tag_binding` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `anonymous_capture_subject_id` INT NOT NULL,
  `nfc_tag_id` INT NOT NULL,
  `medium` VARCHAR(20) NOT NULL DEFAULT 'nfc_bracelet' COMMENT 'nfc_bracelet / nfc_card / qr_card',
  `active_from` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `active_to` TIMESTAMP NULL COMMENT 'NULL = currently active.',
  `unbind_reason` VARCHAR(100) COMMENT 'e.g. lost, damaged, returned. Populated only when active_to is set.',
  `previous_binding_id` INT NULL,
  `created_by` VARCHAR(100),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `active_tag_flag` TINYINT GENERATED ALWAYS AS (IF(`active_to` IS NULL, 1, NULL)) VIRTUAL,
  `active_subject_flag` TINYINT GENERATED ALWAYS AS (IF(`active_to` IS NULL, 1, NULL)) VIRTUAL,
  FOREIGN KEY (`anonymous_capture_subject_id`) REFERENCES `anonymous_capture_subject` (`id`),
  FOREIGN KEY (`nfc_tag_id`) REFERENCES `nfc_tag` (`id`),
  FOREIGN KEY (`previous_binding_id`) REFERENCES `subject_tag_binding` (`id`),
  UNIQUE KEY `uq_binding_one_active_per_tag` (`nfc_tag_id`, `active_tag_flag`),
  UNIQUE KEY `uq_binding_one_active_per_subject` (`anonymous_capture_subject_id`, `active_subject_flag`)
) COMMENT = 'Binds a physical medium to a durable anonymous subject. No identity column — this is tag-to-subject, not tag-to-athlete. Unbind + rebind to replace a lost bracelet without touching capture history.';

CREATE TABLE `source_import_batch` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `import_source` VARCHAR(50) COMMENT 'e.g. qtm_export, rapsodo_api, trackman_export, cv_app_queue_flush',
  `file_or_device` VARCHAR(255),
  `imported_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `imported_by` VARCHAR(100),
  `row_count` INT,
  `error_count` INT DEFAULT 0,
  `notes` VARCHAR(255)
) COMMENT = 'Provenance for every reconciliation/ETL run.';

CREATE TABLE `capture_session` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `anonymous_capture_subject_id` INT NOT NULL,
  `event_session_id` INT NULL,
  `station_source_id` INT NOT NULL COMMENT 'HYBRID: constrained FK, replacing Schema A''s free-text source_device.',
  `capture_date` DATE NOT NULL,
  `lab_location` VARCHAR(100),
  `sport` VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'Part of the unique key, so NOT NULL DEFAULT '''' rather than nullable: MySQL treats NULLs in a unique key as distinct from one another, and a single NULL would make every session unique and switch the dedupe off. CV writes ''''.',
  `movement` VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'pitching / hitting / etc. Added 2026-10-20 so QTM can record more than one movement for an athlete on one day. CV writes ''''. Same NOT NULL DEFAULT '''' reasoning as sport.',
  `session_type` VARCHAR(30),
  -- Reconciled against live 2026-10-20: live still carries Schema A's
  -- free-text source_device, nullable and unwritten, alongside the
  -- station_source_id FK that was supposed to replace it. Kept here so the
  -- fixture matches, but it is dead weight and a trap — anything that starts
  -- populating it reintroduces the free-text station problem station_source
  -- exists to prevent.
  `source_device` VARCHAR(50) NULL COMMENT 'Vestigial. Use station_source_id.',
  `operator` VARCHAR(100) COMMENT 'Staff identifier for the operator running the station. Staff, not athlete — this is not subject PII.',
  `source_import_batch_id` INT NULL,
  -- No created_at: live does not have one. The fixture did, which is the
  -- dangerous direction for drift — code selecting it would pass in tests and
  -- fail in production.
  FOREIGN KEY (`anonymous_capture_subject_id`) REFERENCES `anonymous_capture_subject` (`id`),
  FOREIGN KEY (`event_session_id`) REFERENCES `event_session` (`id`),
  FOREIGN KEY (`station_source_id`) REFERENCES `station_source` (`id`),
  FOREIGN KEY (`source_import_batch_id`) REFERENCES `source_import_batch` (`id`),
  -- One session per subject per station per day PER SPORT AND MOVEMENT.
  --
  -- This is what lets a second visit to the same station on the same day add a
  -- TRIAL rather than a session, while a visit next week is correctly a new
  -- session. CV writes '' for sport and movement, so for CV it behaves exactly
  -- as the original three-column key did.
  --
  -- sport and movement joined the key on 2026-10-20. The three-column version
  -- suited CV but stopped QTM recording pitching and hitting for one athlete
  -- on one day, which is a normal session there.
  UNIQUE KEY `uq_session_subject_station_date_sport_movement`
    (`anonymous_capture_subject_id`, `station_source_id`, `capture_date`,
     `sport`, `movement`),
  -- Index names and column order follow live, reconciled 2026-10-20.
  INDEX `ix_capture_session_station_date` (`station_source_id`, `capture_date`),
  INDEX `ix_capture_session_subject_date` (`anonymous_capture_subject_id`, `capture_date`)
) COMMENT = 'Generalized parent for a lab visit / station visit. No identity column.';

CREATE TABLE `capture_trial` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `capture_session_id` INT NOT NULL,
  -- These three are NULLABLE in live as of 2026-10-20, and the fixture now
  -- matches so tests are not run against a stricter schema than production.
  -- Worth tightening in live: db.py always writes all three, uq_trial_session_
  -- number cannot do its job with a NULL trial_number (MySQL treats each NULL
  -- in a unique key as distinct), and a trial with no timestamp is unjoinable
  -- to the binding that was active when it happened.
  `trial_number` INT NULL COMMENT 'Sequential within the session, starting at 1. Every save creates a NEW trial — a repeat measurement never overwrites an earlier one.',
  `trial_type` VARCHAR(30) NULL COMMENT 'pitch / swing / movement_screen / etc. The CV measurement app writes movement_screen. Nothing downstream can distinguish trial kinds without this.',
  `trial_timestamp` DATETIME(3) NULL COMMENT 'UTC. DATETIME(3) not TIMESTAMP: millisecond precision, and no 2038 ceiling.',
  `device_file` VARCHAR(300),
  `side` VARCHAR(20) COMMENT 'handedness/side, 1 or 2 as applicable',
  `validity_flag` TINYINT DEFAULT 1,
  `notes` VARCHAR(255),
  `client_ref` VARCHAR(64) NULL COMMENT 'Idempotency key minted on the station device before the first send attempt. The station writes locally first and retries in the background, so the same trial WILL be submitted more than once whenever wifi drops mid-request — the UNIQUE constraint here is what makes that retry safe instead of duplicating the athlete''s measurement.',
  FOREIGN KEY (`capture_session_id`) REFERENCES `capture_session` (`id`) ON DELETE RESTRICT,
  -- Names and the extra index follow live, reconciled 2026-10-20. The
  -- client_ref key is named rather than left as MySQL's auto-generated
  -- `client_ref`, which is what live carries.
  UNIQUE KEY `uq_capture_trial_client_ref` (`client_ref`),
  UNIQUE KEY `uq_trial_session_number` (`capture_session_id`, `trial_number`),
  INDEX `ix_capture_trial_session_type` (`capture_session_id`, `trial_type`, `trial_number`),
  INDEX `ix_trial_type_time` (`trial_type`, `trial_timestamp`)
);

-- HYBRID ADDITION 3b (from Schema B's scan_event).
-- Every tap at an open station, resolved or not. This is the concrete
-- deliverable behind the "little ability to audit data quality" gap: a station
-- that scanned but produced no data shows up here as a visible gap instead of
-- disappearing.
--
-- NOTE: this is NOT the same table as station_tap_log below. Do not collapse
-- them. See the comment on station_tap_log.
CREATE TABLE `scan_event` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `raw_scan_value` VARCHAR(64) NOT NULL COMMENT 'EXACTLY what the reader typed, before normalization or validation. Never cleaned up — a malformed scan is evidence.',
  `station_source_id` INT NOT NULL,
  `scanned_at` DATETIME(3) NOT NULL COMMENT 'UTC.',
  `operator` VARCHAR(100),
  `device_label` VARCHAR(100) COMMENT 'Which physical station device, e.g. ipad-lab-01.',
  `valid_shape` TINYINT(1) NOT NULL COMMENT '1 = passed UID shape validation. 0 = reader noise, partial read, or someone typing in the field.',
  `resolved` TINYINT(1) NOT NULL COMMENT '1 = resolved to an anonymous_capture_subject.',
  `anonymous_capture_subject_id` INT NULL COMMENT 'NULL when unresolved, by design.',
  `subject_tag_binding_id` INT NULL,
  `nfc_tag_id` INT NULL,
  `enrolled` TINYINT(1) NULL COMMENT '1 = an active nfc_tag_assignment existed for this tag at scan time. 0 = unenrolled tap: capture still proceeds (anonymous capture does not require enrollment), but staff must reconcile before the athlete leaves. NULL = not checked.',
  `capture_trial_id` INT NULL COMMENT 'Backfilled when this tap produced a trial. Still NULL after the shift = a tap that produced no data.',
  `note` VARCHAR(255),
  FOREIGN KEY (`station_source_id`) REFERENCES `station_source` (`id`),
  FOREIGN KEY (`anonymous_capture_subject_id`) REFERENCES `anonymous_capture_subject` (`id`),
  FOREIGN KEY (`subject_tag_binding_id`) REFERENCES `subject_tag_binding` (`id`),
  FOREIGN KEY (`nfc_tag_id`) REFERENCES `nfc_tag` (`id`),
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`),
  INDEX `ix_scan_station_time` (`station_source_id`, `scanned_at`),
  INDEX `ix_scan_unresolved` (`resolved`, `scanned_at`),
  INDEX `ix_scan_orphan` (`capture_trial_id`, `scanned_at`)
) COMMENT = 'Audit log of every tap at an open station. Keyed on raw_scan_value / resolved / binding. Has no tap_round and plays no window-join role.';

-- Schema-A-aligned lab tap log. DELIBERATELY SEPARATE FROM scan_event.
--
-- Its job is to let CLOSED systems with no injection point — Rapsodo,
-- TrackMan, Blast — be joined to a subject on a timestamp window, using
-- tap_round to disambiguate an athlete's repeat visits to the same station.
-- scan_event cannot do this job: it has no tap_round.
--
-- The CV measurement app does NOT write this table. It is an open station with
-- a real injection point, so it creates its trial directly and writes
-- scan_event. Included here so the next person building a closed-station
-- integration finds it, and so nobody implements one of these two thinking it
-- is the other and ships a table missing the column three of five stations
-- join on.
CREATE TABLE `station_tap_log` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `station_source_id` INT NOT NULL,
  `bracelet_uid` VARCHAR(32) NOT NULL,
  `tapped_at` DATETIME(3) NOT NULL COMMENT 'UTC. The window anchor.',
  `tap_round` INT NOT NULL DEFAULT 1 COMMENT 'Which visit to this station this tap represents. Disambiguates repeat visits within one session.',
  `operator` VARCHAR(100),
  FOREIGN KEY (`station_source_id`) REFERENCES `station_source` (`id`),
  INDEX `ix_tap_window` (`station_source_id`, `tapped_at`),
  INDEX `ix_tap_uid_time` (`bracelet_uid`, `tapped_at`)
) COMMENT = 'Timestamp-window join source for closed capture systems. NOT an alias for scan_event.';

CREATE TABLE `file_artifact` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `capture_session_id` INT NULL,
  `capture_trial_id` INT NULL,
  `file_path` VARCHAR(500) NOT NULL COMMENT 'Storage key. MUST contain no identity and no raw UID — see artifacts.py, which names files from subject_token + trial id.',
  `file_type` VARCHAR(30) COMMENT 'e.g. tpose_raw, tpose_annotated, qtm_export.',
  `byte_size` BIGINT,
  `sha256` CHAR(64) COMMENT 'Content hash. Lets a re-upload be detected as the same photo.',
  `retention_class` VARCHAR(30) DEFAULT 'standard' COMMENT 'Drives the retention job. Full-body photos of minor athletes are a materially different posture than three numbers — set this deliberately and give the retention job something to filter on.',
  `source_import_batch_id` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `purge_after` DATE NULL COMMENT 'Set at write time from the station''s retention policy. NULL = keep indefinitely, which for athlete photos should be a deliberate choice, not a default.',
  FOREIGN KEY (`capture_session_id`) REFERENCES `capture_session` (`id`),
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`),
  FOREIGN KEY (`source_import_batch_id`) REFERENCES `source_import_batch` (`id`),
  INDEX `ix_artifact_purge` (`purge_after`)
);

-- ============================================================
-- HYBRID ADDITION 4: the measurement values (handoff §6.1)
-- ============================================================
-- Neither schema had anywhere to put height, wingspan, hand span, hip ER/IR,
-- t-spine rotation or grip strength. PDR §10 deferred trial_metric to V1.5.
-- This pulls a purpose-built movement-screen result table forward into V1.
--
-- ALL LINEAR MEASUREMENTS ARE DECIMAL CENTIMETRES. The old production write
-- path stored height as a STRING in cm, wingspan rounded to a whole INCH
-- (±1.27cm of quantization on a value the CV resolves far finer than that),
-- and hand span in inches to one decimal. That mixing is lossy and it is fixed
-- here. Convert to feet/inches at display time only, never on the way in.
--
-- See the NAMING WARNING at the top of this file: the production database has
-- a different, identity-native table with this same name.
CREATE TABLE `lab_movement_screen` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `capture_trial_id` INT NOT NULL UNIQUE COMMENT 'One movement-screen result per trial. No identity column — resolve through capture_session -> anonymous_capture_subject -> subject_tag_binding -> nfc_tag -> nfc_tag_assignment -> athlete -> entity_crosswalk.',

  -- CV-derived anthropometrics, centimetres
  `height_cm` DECIMAL(6,2) NULL,
  `wingspan_cm` DECIMAL(6,2) NULL,
  `hand_span_cm` DECIMAL(6,2) NULL,

  -- How those three numbers came to exist. Without this, a hand-typed value
  -- and a CV-derived value are indistinguishable downstream.
  `measurement_method` VARCHAR(20) NOT NULL DEFAULT 'cv' COMMENT 'cv = straight from the pipeline. cv_adjusted = operator dragged an endpoint. manual = typed in because CV failed. mixed = per-field combination.',
  `height_method` VARCHAR(20) NULL COMMENT 'Per-field override of measurement_method.',
  `wingspan_method` VARCHAR(20) NULL,
  `hand_span_method` VARCHAR(20) NULL,

  -- Scale provenance. marker_cm is operator-selected and the app cannot verify
  -- it against the physical printout, so selecting 20cm while holding a 12cm
  -- print yields confidently wrong values. Storing both means a whole session's
  -- worth of bad scale is recoverable by rescaling instead of remeasuring.
  `marker_cm` DECIMAL(5,2) NULL COMMENT 'Marker size the operator selected: 12, 16 or 20.',
  `px_per_cm` DECIMAL(8,3) NULL COMMENT 'Scale the pipeline derived from the detected marker at that assumed size.',
  `scale_warning` VARCHAR(255) NULL COMMENT 'Set when a derived value fell outside a plausible human range, which is the only marker-size sanity check available without a second reference object.',

  -- Manually measured assessment fields
  `age_years` INT NULL,
  `weight_lb` DECIMAL(6,2) NULL COMMENT 'Pounds — the unit the lab actually measures in. Named explicitly because the production column was just "weight".',
  `hip_er_r` DECIMAL(5,1) NULL COMMENT 'Degrees.',
  `hip_ir_r` DECIMAL(5,1) NULL,
  `hip_er_l` DECIMAL(5,1) NULL,
  `hip_ir_l` DECIMAL(5,1) NULL,
  `tspine_rot_l` DECIMAL(5,1) NULL COMMENT 'Degrees.',
  `tspine_rot_r` DECIMAL(5,1) NULL,
  `grip_str_r` DECIMAL(5,1) NULL COMMENT 'Kilograms-force as read off the dynamometer.',
  `grip_str_l` DECIMAL(5,1) NULL,

  `cv_warnings` TEXT NULL COMMENT 'Pipeline warnings verbatim, e.g. a hand-span detection failure.',
  `notes` VARCHAR(500) NULL,
  `recorded_at` DATETIME(3) NOT NULL COMMENT 'UTC.',
  `updated_at` DATETIME(3) NULL COMMENT 'UTC. Set when the additional-info screen fills in the assessment fields.',

  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`) ON DELETE CASCADE
) COMMENT = 'Movement-screen results for one trial. ANONYMOUS — not the same table as production cse_db.lab_movement_screen.';

-- ============================================================
-- LAYER 3: Device/modality raw capture (keyed to capture_trial only)
-- ============================================================

CREATE TABLE `land_qtm_capture_meta` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `capture_trial_id` INT NOT NULL,
  `qtm_station_id` VARCHAR(20),
  `camera_count` INT,
  `marker_set` VARCHAR(50),
  `calibration_file` VARCHAR(300),
  `calibration_residual` DECIMAL(8,4),
  `qtm_software_version` VARCHAR(20),
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`)
) COMMENT = 'Which camera rig, calibration, marker set produced this trial''s capture.';

CREATE TABLE `land_qtm_marker_raw` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `capture_trial_id` INT NOT NULL,
  `marker_label` VARCHAR(50),
  `frame_number` INT,
  `x` DECIMAL(10,4),
  `y` DECIMAL(10,4),
  `z` DECIMAL(10,4),
  `residual` DECIMAL(8,4) COMMENT 'QTM 3D reconstruction quality for this marker/frame.',
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`),
  INDEX `ix_qtm_marker_trial_frame` (`capture_trial_id`, `frame_number`)
) COMMENT = 'High-volume. BIGINT PK is load-bearing — one QTM trial at typical marker counts and frame rates exceeds INT range faster than it looks like it should. Do not downgrade.';

CREATE TABLE `land_theia_segment_frame` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `capture_trial_id` INT NOT NULL,
  `segment_label` VARCHAR(50),
  `frame_number` INT,
  `valid` TINYINT(1),
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`),
  INDEX `ix_theia_segment_trial_frame` (`capture_trial_id`, `frame_number`)
);

CREATE TABLE `land_theia_inertia` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `capture_trial_id` INT NOT NULL,
  `segment_label` VARCHAR(50),
  `sex_model_used` VARCHAR(10),
  `theia_model_version` VARCHAR(20),
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`)
);

CREATE TABLE `land_theia_metadata` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `capture_trial_id` INT NOT NULL,
  `land_qtm_capture_meta_id` INT COMMENT 'Trace-back: which QTM capture produced the markers Theia consumed.',
  `theia_version` VARCHAR(20),
  `model_version` VARCHAR(20),
  `filter_freq_hz` DECIMAL(6,2),
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`),
  FOREIGN KEY (`land_qtm_capture_meta_id`) REFERENCES `land_qtm_capture_meta` (`id`)
);

CREATE TABLE `land_force_platform_geometry` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `capture_trial_id` INT NOT NULL,
  `plate_index` INT,
  `plate_role` VARCHAR(20),
  `plate_serial` VARCHAR(20),
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`)
);

CREATE TABLE `land_qrf_raw` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `capture_trial_id` INT NOT NULL,
  `plate_role` VARCHAR(20),
  `axis` VARCHAR(5),
  `frame_number` INT,
  `value` DECIMAL(14,4),
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`),
  INDEX `ix_qrf_trial_frame` (`capture_trial_id`, `frame_number`)
) COMMENT = 'Force plate raw stream, 300Hz. Same high-volume indexing pattern as marker_raw.';

CREATE TABLE `raw_rapsodo_pitch` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `capture_trial_id` INT COMMENT 'Set later by a reconciliation job (station_tap_log window + session match), not at capture time.',
  `rapsodo_player_id` INT COMMENT 'OPEN ITEM: Rapsodo''s API requires an email to create a player profile, which conflicts with the no-PII-in-capture rule. Resolution is unresolved — do not wire up the live Rapsodo integration until it is settled.',
  `velocity` DECIMAL(6,2),
  `spin_rate` DECIMAL(8,2),
  `pitch_type` VARCHAR(30),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `source_import_batch_id` INT,
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`),
  FOREIGN KEY (`source_import_batch_id`) REFERENCES `source_import_batch` (`id`)
);

CREATE TABLE `raw_rapsodo_swing` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `capture_trial_id` INT COMMENT 'Set later by reconciliation job.',
  `rapsodo_player_id` INT COMMENT 'Same open item as raw_rapsodo_pitch.',
  `exit_velocity` DECIMAL(6,2),
  `launch_angle` DECIMAL(6,2),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `source_import_batch_id` INT,
  FOREIGN KEY (`capture_trial_id`) REFERENCES `capture_trial` (`id`),
  FOREIGN KEY (`source_import_batch_id`) REFERENCES `source_import_batch` (`id`)
);
