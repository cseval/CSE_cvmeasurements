"""
NFC tap validation.

The reader is a USB HID keyboard, not an API. On tag detection the firmware
(NEW Pipeline/hardware/code.py) types the UID as uppercase hex with no
separators and presses Enter. So a tap is indistinguishable from someone
typing very fast into a focused text field, and this module is the only thing
standing between "the reader fired" and "we created a subject".

UID LENGTH IS NOT FIXED. The firmware formats whatever the tag returns:

    "".join("{:02X}".format(b) for b in uid)

  - 7-byte NTAG21x UID  -> 14 hex characters
  - 4-byte Mifare-family -> 8 hex characters

Observed in the ordered bracelets (NEW Pipeline/NFC Bracelet IDs.xlsx): all 14
characters, all beginning 04, which is the NXP manufacturer byte — consistent
with NTAG21x. Two 8-character values are also in that sheet, so short UIDs are
in circulation at the lab too. Nothing here hard-codes a length; the observed
length is recorded per tag in nfc_tag.chip_type at enrollment instead.
"""

import os
import re

# PREFIX must match the firmware's PREFIX setting. Empty in the current build;
# set it (e.g. "BR-") on both sides if you ever need to tell readers apart.
PREFIX = os.environ.get("NFC_PREFIX", "")

# Even length between 8 and 20 hex characters. Even because the firmware emits
# two characters per byte, so an odd length means a truncated read — usually a
# tag pulled out of the field mid-transfer.
_UID_RE = re.compile(r"^[0-9A-F]{8,20}$")

MIN_LEN = 8
MAX_LEN = 20


class TapRejected(Exception):
    """Raised when a scan does not have the shape of a tag UID."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def normalize(raw: str) -> str:
    """
    Clean a raw scan into a candidate UID.

    Does NOT validate. Callers must keep the raw string too: scan_event stores
    raw_scan_value exactly as the reader typed it, because a malformed scan is
    evidence about the hardware and cleaning it up destroys that.
    """
    value = (raw or "").strip().upper()
    # Some HID readers emit a trailing tab or CR before Enter.
    value = value.strip("\t\r\n")
    if PREFIX and value.startswith(PREFIX.upper()):
        value = value[len(PREFIX):]
    return value


def validate(raw: str) -> str:
    """
    Normalize and validate a scan. Returns the clean UID.

    Raises TapRejected with an operator-readable reason otherwise. The reason
    is deliberately specific: at a station, "8 characters, expected an even
    count" tells staff the read was truncated, while "contains non-hex
    characters" tells them someone typed into the field.
    """
    uid = normalize(raw)

    if not uid:
        raise TapRejected("Empty scan — the reader sent nothing")

    if len(uid) % 2 != 0:
        raise TapRejected(
            f"Odd length ({len(uid)} characters) — the tag left the field "
            f"mid-read. Tap again and hold it flat on the reader."
        )

    if not _UID_RE.match(uid):
        if len(uid) < MIN_LEN:
            raise TapRejected(
                f"Too short ({len(uid)} characters, minimum {MIN_LEN}) — "
                f"partial read"
            )
        if len(uid) > MAX_LEN:
            raise TapRejected(
                f"Too long ({len(uid)} characters, maximum {MAX_LEN}) — "
                f"this looks like typing, not a tap"
            )
        raise TapRejected(
            "Contains characters that are not uppercase hex — this looks like "
            "typing, not a tap"
        )

    return uid


def is_valid(raw: str) -> bool:
    """Shape check without the exception, for logging paths."""
    try:
        validate(raw)
        return True
    except TapRejected:
        return False


def guess_chip_family(uid: str) -> str | None:
    """
    A conservative guess at chip family from UID length alone, for recording
    at first sight. Deliberately a family, not a part number: length cannot
    distinguish NTAG213 from NTAG215, and only a real read of the capability
    container can. Confirm during station validation and correct the row.
    """
    n = len(uid)
    if n == 14:
        return "NTAG21x"          # 7-byte UID
    if n == 8:
        return "Mifare-family"    # 4-byte UID
    return None
