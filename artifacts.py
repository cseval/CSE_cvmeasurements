"""
Photo storage for capture artifacts.

Decision on record: photos ARE kept, wired to file_artifact.

That is a materially different retention posture than storing three numbers,
because these are full-body photographs of minor athletes. Two things follow,
and both are implemented here rather than left to policy:

  1. Nothing in a stored filename identifies anyone. Names come from the
     opaque subject_token plus the trial id — no UID, no cse_player_id, no
     athlete name. Invariant 5 in the handoff says identity must not appear in
     a filename and this is where that is actually enforced.
  2. Every artifact gets a purge_after date at write time, so retention is a
     dated row a job can act on rather than an intention. PHOTO_RETENTION_DAYS
     sets it. The default below is a PLACEHOLDER pending the guardian-consent
     and biometric-statute review that the partnership assessment flags as the
     longest-lead item — it is not a legal determination.

Two backends. Local filesystem is the default and is what runs on Azure App
Service today. Set ARTIFACT_AZURE_CONTAINER (and either
AZURE_STORAGE_CONNECTION_STRING or ARTIFACT_AZURE_ACCOUNT_URL for managed
identity) to switch to Blob storage, which is where this should end up: App
Service local disk is not durable across a redeploy or a scale-out.
"""

import hashlib
import logging
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger(__name__)

ARTIFACT_DIR = Path(os.environ.get("ARTIFACT_DIR", "/home/site/artifacts"))
AZURE_CONTAINER = os.environ.get("ARTIFACT_AZURE_CONTAINER", "").strip()
AZURE_CONN = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "").strip()
AZURE_ACCOUNT_URL = os.environ.get("ARTIFACT_AZURE_ACCOUNT_URL", "").strip()

_DEFAULT_RETENTION_DAYS = 365
try:
    RETENTION_DAYS = int(os.environ.get("PHOTO_RETENTION_DAYS", _DEFAULT_RETENTION_DAYS))
except ValueError:
    RETENTION_DAYS = _DEFAULT_RETENTION_DAYS

if "PHOTO_RETENTION_DAYS" not in os.environ:
    log.warning(
        "PHOTO_RETENTION_DAYS is not set; defaulting to %d days. This default "
        "is a placeholder, not a retention policy — set it explicitly once the "
        "consent and biometric-statute review lands.",
        RETENTION_DAYS,
    )

# 0 means keep indefinitely. Allowed, but it has to be typed on purpose.
RETENTION_INDEFINITE = RETENTION_DAYS <= 0


def purge_after_date(today: date | None = None) -> date | None:
    """The purge_after value to stamp on a new artifact row."""
    if RETENTION_INDEFINITE:
        return None
    return (today or datetime.now(timezone.utc).date()) + timedelta(days=RETENTION_DAYS)


def _use_azure() -> bool:
    return bool(AZURE_CONTAINER and (AZURE_CONN or AZURE_ACCOUNT_URL))


def build_key(subject_token: str, trial_id: int, kind: str, content: bytes) -> str:
    """
    Storage key for one artifact.

    Shape: yyyy/mm/<subject_token>_t<trial_id>_<kind>_<hash8>.jpg

    subject_token is opaque by construction (see tokens.py), so this carries no
    identity and no raw tag UID. The short content hash makes the key stable
    for identical bytes, so an operator who saves twice does not leave two
    copies of the same photo behind under different names.
    """
    if kind not in ("tpose_raw", "tpose_annotated"):
        raise ValueError(f"Unknown artifact kind: {kind}")
    now = datetime.now(timezone.utc)
    digest = hashlib.sha256(content).hexdigest()
    # Defence in depth: a token that somehow contained a path separator would
    # otherwise escape the artifact root.
    safe_token = "".join(c for c in subject_token if c.isalnum() or c in "-_")
    return f"{now:%Y/%m}/{safe_token}_t{trial_id}_{kind}_{digest[:8]}.jpg"


def store(subject_token: str, trial_id: int, kind: str, content: bytes) -> dict:
    """
    Persist one artifact. Returns the row fields file_artifact needs.

    Never raises on a storage failure — a photo that cannot be written must not
    cost the operator the measurement, which is the actual deliverable. The
    caller logs the miss and saves the trial anyway. Returns None-ish dict with
    'stored': False in that case.
    """
    key = build_key(subject_token, trial_id, kind, content)
    sha = hashlib.sha256(content).hexdigest()

    try:
        if _use_azure():
            _store_azure(key, content)
            path = f"azure://{AZURE_CONTAINER}/{key}"
        else:
            dest = ARTIFACT_DIR / key
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)
            path = str(dest)
    except Exception as exc:
        log.error("Artifact write failed for trial %s (%s): %s", trial_id, kind, exc)
        return {"stored": False, "file_path": None, "byte_size": len(content), "sha256": sha}

    return {
        "stored": True,
        "file_path": path,
        "file_type": kind,
        "byte_size": len(content),
        "sha256": sha,
        "purge_after": purge_after_date(),
    }


def _store_azure(key: str, content: bytes) -> None:
    from azure.storage.blob import BlobServiceClient  # imported lazily

    if AZURE_CONN:
        client = BlobServiceClient.from_connection_string(AZURE_CONN)
    else:
        from azure.identity import DefaultAzureCredential

        client = BlobServiceClient(
            account_url=AZURE_ACCOUNT_URL, credential=DefaultAzureCredential()
        )
    blob = client.get_blob_client(container=AZURE_CONTAINER, blob=key)
    blob.upload_blob(content, overwrite=True, content_type="image/jpeg")


def describe_backend() -> str:
    """One line for the health endpoint, so a misconfigured station is visible."""
    if _use_azure():
        where = f"azure blob container '{AZURE_CONTAINER}'"
    else:
        where = f"local filesystem {ARTIFACT_DIR}"
    retention = "indefinite" if RETENTION_INDEFINITE else f"{RETENTION_DAYS} days"
    return f"{where}, retention {retention}"
