#!/usr/bin/env python3
"""
Generate the standalone copy of the reader bench check.

There are two copies of this page and only one source:

  reader-bench.html             published as a hosted Artifact. The platform
                                wraps it in <!doctype html><head>...<body>, so
                                the file itself carries no page skeleton.
  reader-bench-standalone.html  a complete HTML document that opens by
                                double-clicking, AirDropping, or emailing it.

This script builds the second from the first, so a fix to the tap logic cannot
land in one and miss the other. Run it after any edit to reader-bench.html:

    python scripts/build_reader_bench_standalone.py

The only difference between the two files is the skeleton added here, which
reproduces what the Artifact platform supplies: charset, viewport, a small
reset, and light/dark colour-scheme support.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "reader-bench.html"
TARGET = ROOT / "reader-bench-standalone.html"

# Matches what the Artifact platform injects, so the standalone renders
# identically rather than subtly differently.
HEAD_EXTRAS = """  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Reader Check">
  <meta name="description" content="Bench check for the CSE lab NFC bracelet reader.">
  <style>
    :root { color-scheme: light dark; }
    html, body { margin: 0; }
    body { font: 14px/1.5 system-ui, -apple-system, sans-serif; }
    img { max-width: 100%; }
    [hidden] { display: none !important; }
  </style>
"""


def build() -> int:
    if not SOURCE.exists():
        print(f"missing source: {SOURCE}", file=sys.stderr)
        return 1

    content = SOURCE.read_text(encoding="utf-8")

    # The source opens with <title>, then the font <link>s, then <style>.
    # Everything up to the end of the last <link> belongs in <head>; the rest
    # is body content. Split on the first <style> tag, which is unambiguous
    # here and does not depend on how the font links are formatted.
    match = re.search(r"^\s*<style>", content, re.MULTILINE)
    if not match:
        print("could not find the opening <style> tag in the source", file=sys.stderr)
        return 1

    head_part = content[: match.start()].strip()
    rest = content[match.start():]

    # The <style> block stays in <head>; everything after it is the body.
    close = rest.find("</style>")
    if close == -1:
        print("unterminated <style> block in the source", file=sys.stderr)
        return 1
    style_part = rest[: close + len("</style>")]
    body_part = rest[close + len("</style>"):].strip()

    document = (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "<head>\n"
        f"{HEAD_EXTRAS}"
        f"{_indent(head_part)}\n"
        f"{_indent(style_part)}\n"
        "</head>\n"
        "<body>\n"
        f"{body_part}\n"
        "</body>\n"
        "</html>\n"
    )

    TARGET.write_text(document, encoding="utf-8")
    print(f"wrote {TARGET.relative_to(ROOT)} ({len(document):,} bytes)")
    return 0


def _indent(block: str) -> str:
    return "\n".join(("  " + line) if line.strip() else line
                     for line in block.splitlines())


if __name__ == "__main__":
    sys.exit(build())
