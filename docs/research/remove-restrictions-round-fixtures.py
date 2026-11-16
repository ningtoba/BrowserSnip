#!/usr/bin/env python3
"""The `remove-restrictions` round's two restriction-only fixtures.

The triage file the round was handed (`locked128.pdf`) is locked with a **user**
secret: a reader has to be handed something before it will show the pages. A
*restriction-only* file is the other shape — the user secret is empty, so nothing
has to be typed, and `/P` is the only thing holding the file back. That shape is
what the tool's name is about, and nothing in the repository carried it.

Two files, one document (`tests/fixtures/encrypted/structure-plain.pdf`, the
enclosure/annot/form/outline fixture), both written by **libqpdf** so this app's
writer is not judging its own bytes:

  restrict-none-aes-128.pdf   `--print=none --modify=none`   `/P -3392`, refused
                              printing, editing, copying, comments, form filling
                              and page assembly
  restrict-open-aes-128.pdf   nothing refused                `/P -4`, the control:
                              a dictionary that restricts nothing, which the card
                              used to describe with the same words as the first

    python3 docs/research/remove-restrictions-round-fixtures.py tests/fixtures/encrypted

Both open with **nothing typed** and are checked with `qpdf --check` after they are
written; the `/P` of each is printed, because the pair is only meaningful if one
refuses and the other does not.
"""
import os
import sys

import pikepdf
import pymupdf
import pypdf

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/r54")  # noqa: S108 — the round's scratch dir
PLAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests", "fixtures", "encrypted", "structure-plain.pdf")
PLAIN = os.path.abspath(PLAIN)
OWNER = "owner-pass"

DENY = ["--print=none", "--modify=none", "--annotate=n", "--form=n", "--assemble=n"]
ALLOW = ["--print=full", "--modify=all", "--annotate=y", "--form=y", "--assemble=y"]
COMMON = ["--extract=y", "--accessibility=y"]

CASES = [
    ("restrict-none-aes-128.pdf", DENY),
    ("restrict-open-aes-128.pdf", ALLOW),
    # `/EncryptMetadata false` is the flag that catches a decrypt pass which reads
    # "metadata" as "/Info too": `qpdf --cleartext-metadata` leaves only the
    # document-level XMP stream in the clear and ciphers `/Info` all the same (qpdf
    # #1368), so a copy that honours the literal reading keeps a title nobody can
    # read (`core/crypto.ts`).
    ("restrict-none-aes-128-clearmeta.pdf", [*DENY, "--cleartext-metadata"]),
]


def write(name: str, flags: list[str]) -> None:
    path = os.path.join(OUT, name)
    # The brief's own command shape: an empty user secret, an owner key, AES-128.
    job = pikepdf.Job(["qpdf", "--encrypt", "", OWNER, "128", "--use-aes=y", *flags, *COMMON, "--", PLAIN, path])
    job.run()
    if job.exit_code not in (0, 3):
        raise RuntimeError(f"qpdf refused to write {path} (exit {job.exit_code})")
    check = pikepdf.Job(["qpdf", "--check", path])
    check.run()
    if check.exit_code not in (0, 3):
        raise RuntimeError(f"qpdf --check is unhappy with {path} (exit {check.exit_code})")
    with pikepdf.open(path, password=OWNER) as doc:
        entry = doc.encryption
    reader = pymupdf.open(path)
    # An empty user secret is the whole point: the file has to open with nothing
    # typed, or it is a user-password fixture wearing a restriction fixture's name.
    print(
        f"{name}: /V {entry.V} /R {entry.R} {entry.stream_method} /P {entry.P} "
        f"opens-with-nothing {not reader.needs_pass} pypdf-user {pypdf.PdfReader(path).decrypt('')} "
        f"qpdf-check {check.exit_code}"
    )


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for name, flags in CASES:
        write(name, flags)


if __name__ == "__main__":
    main()
