"""Schema-agnostic persistence for the CV measurement station.

SCHEMA_PROFILE selects the concrete target database. Handoff §6.0 makes
this a HUMAN decision; this module deliberately does not pick — it exposes
the switch so the choice is a one-line env change, not a rebuild:

  a (default)  ->  new_lab_pipeline   (NEW Pipeline/new-lab-pipeline-pdr.md)
                   newer doc; what the project's V1 diagram reflects; the
                   NFC station validation protocol's acceptance queries
                   are written against it.
  b            ->  cse_db_v2_dev      (NEW Pipeline/sql/01_create_cse_v2_schema.sql)
                   abstract cse_token identity, seeded 'cv_app' station,
                   scan_event audit log, graceful lost-bracelet rebind.

Both schema documents remain on disk until the owner archives the loser —
do not delete either one from here.
"""
import os

from .base import (  # noqa: F401  (re-exported)
    MARKER_SIZES,
    PersistenceAdapter,
    UID_RE,
    validate_uid,
)


def get_adapter() -> PersistenceAdapter:
    profile = (os.environ.get("SCHEMA_PROFILE") or "a").strip().lower()
    if profile in ("a", "schema_a", "new_lab_pipeline"):
        from .schema_a import SchemaAAdapter

        return SchemaAAdapter()
    if profile in ("b", "schema_b", "cse_db_v2"):
        from .schema_b import SchemaBAdapter

        return SchemaBAdapter()
    raise ValueError(
        f"SCHEMA_PROFILE={profile!r} is not recognized — expected 'a' or 'b' "
        "(handoff §6.0: this is a human decision)"
    )


__all__ = [
    "get_adapter",
    "PersistenceAdapter",
    "validate_uid",
    "MARKER_SIZES",
    "UID_RE",
]
