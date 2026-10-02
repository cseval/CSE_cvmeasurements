"""
Opaque subject tokens.

anonymous_capture_subject.subject_token is what the capture layer keys off.
It is deliberately NOT the bracelet UID.

The PDR says subject_token is "usually equal to nfc_tag.tag_uid, but abstracted
so a future non-NFC capture method can plug in". Filling it with the UID is the
tempting shortcut, and it costs the thing the abstraction was for: if the
subject IS the physical tag, then replacing a lost bracelet creates a new
subject with no history, and the athlete's capture record splits in two with
nothing in the data saying they are the same person.

So the token is generated here and the UID stays in nfc_tag, reached through
subject_tag_binding. A replacement bracelet is an unbind and a rebind to the
same subject, and every capture_session already pointing at that subject stays
correct.

Format: TC-XXXX-XXXX over a 30-character ambiguity-free alphabet.
Matches the shape Schema B used for cse_token (TC-4K7M-92QX), so tokens from
either lineage are recognizable to staff reading a log.
"""

import secrets

# Crockford-style: no I, L, O, U, and no 0 or 1. Those are the pairs that get
# misread and mistyped when staff read a token off a screen and into a ticket.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
assert len(ALPHABET) == 30

GROUP_LEN = 4
GROUPS = 2
PREFIX = "TC"


def new_subject_token() -> str:
    """
    Generate a fresh opaque subject token.

    8 characters over a 30-symbol alphabet is 30**8 ~= 6.6e11 possibilities.
    At the scale this lab operates that is collision-free in practice, and
    anonymous_capture_subject.subject_token is UNIQUE, so a collision surfaces
    as a rejected insert and a retry rather than as two athletes sharing a
    subject. generate_unique() below does that retry.
    """
    body = "-".join(
        "".join(secrets.choice(ALPHABET) for _ in range(GROUP_LEN))
        for _ in range(GROUPS)
    )
    return f"{PREFIX}-{body}"


def generate_unique(exists) -> str:
    """
    Generate a token that `exists(token) -> bool` says is free.

    Bounded retries: an exhausted loop means something is wrong with the
    uniqueness check itself, not that the keyspace filled up, and failing
    loudly is better than handing back a token that is about to collide.
    """
    for _ in range(8):
        token = new_subject_token()
        if not exists(token):
            return token
    raise RuntimeError(
        "Could not generate a unique subject_token in 8 attempts — check the "
        "uniqueness query, not the keyspace"
    )
