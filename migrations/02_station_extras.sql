-- =====================================================================
-- CV measurement station — schema additions (handoff §4.2 / §6.1)
--
-- STATUS: PENDING HUMAN CONFIRMATION (handoff §6.0 + §6.1).
--   * movement_screen_result implements §6.1 option (a) — "pull the
--     movement-screen result table forward into V1 so measurements land
--     keyed to capture_trial_id". The handoff recommends (a) or (c) and
--     explicitly warns against defaulting into (b). This DDL is that
--     recommendation made concrete; apply only after the decision.
--   * Profile A also adds station_tap_log — the lab tap log from the NFC
--     station validation protocol. It is NOT an alias of Schema B's
--     scan_event: it carries station_id / bracelet_uid / tapped_at /
--     tap_round so closed systems (Rapsodo, Trackman, Blast) can join on
--     a timestamp window. Do not collapse the two (handoff §3.0).
--
-- The two blocks are independent — run the block for your profile
-- against its database, after (and only if) the §6.0/§6.1 decision.
-- Requires MySQL 8.0.19+ (the `AS new` upsert alias used by the app).
-- =====================================================================


-- ---------------------------------------------------------------------
-- PROFILE A: new_lab_pipeline
-- ---------------------------------------------------------------------
USE new_lab_pipeline;

CREATE TABLE IF NOT EXISTS station_tap_log (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  station_id        VARCHAR(50)     NOT NULL,
  bracelet_uid      VARCHAR(20)     NOT NULL COMMENT 'tag UID the reader emitted (raw text for manual/test)',
  tapped_at         DATETIME(3)     NOT NULL,
  tap_round         INT             NOT NULL DEFAULT 1 COMMENT 'per-station, per-day sequence',
  raw_scan_value    VARCHAR(64)     NULL     COMMENT 'exactly what the reader typed, pre-validation',
  resolved          TINYINT(1)      NOT NULL DEFAULT 0,
  enrolled          TINYINT(1)      NOT NULL DEFAULT 0 COMMENT 'active nfc_tag_assignment existed at tap time',
  operator          VARCHAR(100)    NULL,
  device_id         VARCHAR(64)     NULL,
  capture_batch_id  VARCHAR(64)     NULL     COMMENT 'app-side record id of the capture this tap started, if any',
  KEY ix_tap_station_time (station_id, tapped_at),
  KEY ix_tap_uid (bracelet_uid, tapped_at)
) ENGINE = InnoDB COMMENT = 'Lab tap log (validation protocol). Not scan_event — see header.';

CREATE TABLE IF NOT EXISTS movement_screen_result (
  id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  capture_trial_id    INT           NOT NULL,
  height_cm           DECIMAL(6,2)  NULL,
  wingspan_cm         DECIMAL(6,2)  NULL,
  hand_span_cm        DECIMAL(6,2)  NULL,
  marker_cm           DECIMAL(4,1)  NULL,
  capture_method      VARCHAR(20)   NULL COMMENT 'cv | manual',
  age                 INT           NULL,
  weight              DECIMAL(5,1)  NULL,
  hips_r_hip_er       INT           NULL,
  hips_r_hip_ir       INT           NULL,
  hips_l_hip_er       INT           NULL,
  hips_l_hip_ir       INT           NULL,
  tspine_tspine_rot_l INT           NULL,
  tspine_tspine_rot_r INT           NULL,
  grip_grip_str_r     INT           NULL,
  grip_grip_str_l     INT           NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_msr_trial (capture_trial_id),
  CONSTRAINT fk_msr_trial
    FOREIGN KEY (capture_trial_id) REFERENCES capture_trial (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE = InnoDB COMMENT = 'One row per movement-screen trial. All lengths in cm (display converts).';


-- ---------------------------------------------------------------------
-- PROFILE B: cse_db_v2_dev
-- (B's base schema has no trial table at all — handoff §6.1: "Schema B
-- is worse in this respect". These two tables are the (a)-option
-- addition under B.)
-- ---------------------------------------------------------------------
USE cse_db_v2_dev;

CREATE TABLE IF NOT EXISTS capture_trial (
  trial_id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id      BIGINT UNSIGNED NOT NULL,
  cse_id          CHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trial_number    INT             NOT NULL DEFAULT 1,
  trial_type      VARCHAR(30)     NOT NULL DEFAULT 'movement_screen',
  trial_timestamp DATETIME(3)     NOT NULL,
  validity_flag   TINYINT(1)      NOT NULL DEFAULT 1,
  notes           VARCHAR(255)    NULL,
  KEY ix_trial_session (session_id, trial_number),
  CONSTRAINT fk_trial_session
    FOREIGN KEY (session_id, cse_id) REFERENCES capture_session (session_id, cse_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_trial_token
    FOREIGN KEY (cse_id) REFERENCES cse_token (cse_id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS movement_screen_result (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  capture_trial_id    BIGINT UNSIGNED NOT NULL,
  height_cm           DECIMAL(6,2)  NULL,
  wingspan_cm         DECIMAL(6,2)  NULL,
  hand_span_cm        DECIMAL(6,2)  NULL,
  marker_cm           DECIMAL(4,1)  NULL,
  capture_method      VARCHAR(20)   NULL COMMENT 'cv | manual',
  age                 INT           NULL,
  weight              DECIMAL(5,1)  NULL,
  hips_r_hip_er       INT           NULL,
  hips_r_hip_ir       INT           NULL,
  hips_l_hip_er       INT           NULL,
  hips_l_hip_ir       INT           NULL,
  tspine_tspine_rot_l INT           NULL,
  tspine_tspine_rot_r INT           NULL,
  grip_grip_str_r     INT           NULL,
  grip_grip_str_l     INT           NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                              ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_msr_trial (capture_trial_id),
  CONSTRAINT fk_msr_trial
    FOREIGN KEY (capture_trial_id) REFERENCES capture_trial (trial_id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE = InnoDB COMMENT = 'One row per movement-screen trial. All lengths in cm (display converts).';
