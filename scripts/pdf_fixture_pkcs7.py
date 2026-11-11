#!/usr/bin/env python3
"""A PKCS#7 ``SignedData`` blob for the signature fixtures, assembled from DER by hand.

Why this module exists rather than a call to a signing tool
-----------------------------------------------------------
The signature row of ``docs/research/reader-sweep-reconciliation.md`` needs a PDF whose
``/Sig`` value carries a PKCS#7 blob that **this repo did not sign**. On this box:

* ``mutool`` and ``qpdf`` are not installed, so neither the MuPDF nor the libqpdf CLI
  signer is available;
* PyMuPDF 1.28.2 here exposes no ``sign_file`` / ``sign_archive`` (``dir(pymupdf.
  Document)`` has no ``sign`` entry), so the Python binding of MuPDF cannot sign either;
* ``openssl cms -sign`` and ``cryptography``'s ``pkcs7`` layer both **can** produce a
  detached ``SignedData``, but each stamps ``signingTime`` with the wall clock, and a
  fixture whose bytes move every run is a fixture no CI test can hash-pin.

So the DER is laid out here, one field at a time, from a key pair and certificate that
OpenSSL generated once and that are committed beside the fixtures
(``signer-key.pem``, ``signer-cert.pem``). Everything else is outside code: the RSA
signature is made by ``cryptography`` (OpenSSL bindings), the certificate is X.509 from
OpenSSL, and the result is verified by ``openssl cms -verify`` in the census — an
independent implementation confirming the bytes before this repo's reader is asked
about them.

Deterministic by construction: PKCS#1 v1.5 RSA signing is not randomized, the
certificate and its ``signingTime`` are fixed strings, and no clock is read.
"""
from __future__ import annotations

import hashlib

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import Encoding

# ---------------------------------------------------------------------------
# DER primitives
# ---------------------------------------------------------------------------


def tlv(tag: int, body: bytes) -> bytes:
    """One tag-length-value triple, with the long-form length the body needs."""
    if len(body) < 128:
        return bytes([tag, len(body)]) + body
    length = len(body).to_bytes((len(body).bit_length() + 7) // 8, "big")
    return bytes([tag, 0x80 | len(length)]) + length + body


def der_bytes(value: bytes) -> bytes:
    return tlv(0x04, value)


def der_integer(value: int) -> bytes:
    """A non-negative INTEGER, with the leading zero byte DER requires at bit 7."""
    raw = value.to_bytes(max(1, (value.bit_length() + 8) // 8), "big")
    return tlv(0x02, raw)


def der_oid(dotted: str) -> bytes:
    """An OBJECT IDENTIFIER: two arcs in the first byte, then base-128 groups."""
    parts = [int(part) for part in dotted.split(".")]
    body = bytearray([40 * parts[0] + parts[1]])
    for part in parts[2:]:
        group = bytearray([part & 0x7F])
        part >>= 7
        while part:
            group.append((part & 0x7F) | 0x80)
            part >>= 7
        body.extend(reversed(group))
    return tlv(0x06, bytes(body))


def der_sequence(*members: bytes) -> bytes:
    return tlv(0x30, b"".join(members))


def der_set(*members: bytes) -> bytes:
    return tlv(0x31, b"".join(members))


def der_context(tag_number: int, *members: bytes) -> bytes:
    """`[tag_number]` **constructed** — the implicit wrapper PKCS#7 uses."""
    return tlv(0xA0 | tag_number, b"".join(members))


def der_printable(value: str) -> bytes:
    return tlv(0x13, value.encode("ascii"))


def der_utctime(value: str) -> bytes:
    return tlv(0x17, value.encode("ascii"))


def der_null() -> bytes:
    return tlv(0x05, b"")


# ---------------------------------------------------------------------------
# The object identifiers PDF signature work actually uses
# ---------------------------------------------------------------------------

OID_PKCS7_SIGNED_DATA = "1.2.840.113549.1.7.2"
OID_PKCS7_DATA = "1.2.840.113549.1.7.1"
OID_CONTENT_TYPE = "1.2.840.113549.1.9.3"
OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4"
OID_SIGNING_TIME = "1.2.840.113549.1.9.5"
OID_SHA1 = "1.3.14.3.2.26"
OID_SHA256 = "2.16.840.1.101.3.4.2.1"
OID_SHA384 = "2.16.840.1.101.3.4.2.2"
OID_SHA512 = "2.16.840.1.101.3.4.2.3"
OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1"
OID_SHA1_RSA = "1.2.840.113549.1.1.5"
OID_SHA256_RSA = "1.2.840.113549.1.1.11"
OID_SHA384_RSA = "1.2.840.113549.1.1.12"
OID_SHA512_RSA = "1.2.840.113549.1.1.13"

#: digest algorithm name → (digest OID, signature OID, hashlib constructor)
ALGORITHMS = {
    "sha1": (OID_SHA1, OID_SHA1_RSA, hashlib.sha1),
    "sha256": (OID_SHA256, OID_SHA256_RSA, hashlib.sha256),
    "sha384": (OID_SHA384, OID_SHA384_RSA, hashlib.sha384),
    "sha512": (OID_SHA512, OID_SHA512_RSA, hashlib.sha512),
}


def _algorithm(identifier: str) -> bytes:
    """``AlgorithmIdentifier`` — parameters are ``NULL`` for every pair above."""
    digest_oid, _, _ = ALGORITHMS[identifier]
    return der_sequence(der_oid(digest_oid), der_null())


def _signed_attribute(oid: str, *values: bytes) -> bytes:
    return der_sequence(der_oid(oid), der_set(*values))


def signed_data(content: bytes, certificate, private_key,
                *, algorithm: str = "sha256", signing_time: str = "240101120000Z") -> bytes:
    """A detached ``SignedData`` over `content`, in DER.

    `certificate` and `private_key` are the `cryptography` objects loaded from the
    committed PEM pair. The shape is the one `adbe.pkcs7.detached` describes: no
    encapsulated content, the certificate in the bag, and the three signed
    attributes every PDF verifier looks for (content type, message digest, signing
    time). Version 1 signer info, so the signer is named by issuer **and** serial
    number rather than by subject key identifier.
    """
    digest_oid, signature_oid, hash_factory = ALGORITHMS[algorithm]
    digest = hash_factory(content).digest()

    attributes = der_context(
        0,
        _signed_attribute(OID_CONTENT_TYPE, der_oid(OID_PKCS7_DATA)),
        _signed_attribute(OID_MESSAGE_DIGEST, der_bytes(digest)),
        _signed_attribute(OID_SIGNING_TIME, der_utctime(signing_time)),
    )
        # PKCS#7 rule: the attributes are *stored* under context tag 0 but *signed*
    # under the SET tag they replace.
    attributes_for_signature = der_set(
        _signed_attribute(OID_CONTENT_TYPE, der_oid(OID_PKCS7_DATA)),
        _signed_attribute(OID_MESSAGE_DIGEST, der_bytes(digest)),
        _signed_attribute(OID_SIGNING_TIME, der_utctime(signing_time)),
    )
    signature = private_key.sign(attributes_for_signature, padding.PKCS1v15(), _hash(algorithm))

    signer_info = der_sequence(
        der_integer(1),
        der_sequence(certificate.issuer.public_bytes(), der_integer(certificate.serial_number)),
        der_sequence(der_oid(digest_oid), der_null()),
        attributes,
        der_sequence(der_oid(signature_oid), der_null()),
        der_bytes(signature),
    )
    body = der_sequence(
        der_integer(1),
        der_set(_algorithm(algorithm)),
        der_sequence(der_oid(OID_PKCS7_DATA)),
        der_context(0, certificate.public_bytes(Encoding.DER)),
        der_set(signer_info),
    )
    return der_sequence(der_oid(OID_PKCS7_SIGNED_DATA), der_context(0, body))


def _hash(algorithm: str):
    """The `cryptography` hash object matching a DER digest algorithm name."""
    return {
        "sha1": hashes.SHA1,
        "sha256": hashes.SHA256,
        "sha384": hashes.SHA384,
        "sha512": hashes.SHA512,
    }[algorithm]()
