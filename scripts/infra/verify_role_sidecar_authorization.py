#!/usr/bin/env python3
"""Verify four role sidecars against an externally managed PKI directory.

Production verification is fail-closed. It validates role/subject/public-key
bindings, signed CRL evidence, certificate validity, and—when requested—an
OCSP response whose signer is either the configured issuer or a delegated
OCSP-signing certificate embedded in the response.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, ed448, padding, rsa
from cryptography.x509 import ocsp

ROLES = ("release_manager", "security_owner", "compliance_owner", "operations_owner")


class AuthorizationError(ValueError):
    pass


def parse_time(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise AuthorizationError(f"{field} must be RFC3339") from exc
    if parsed.tzinfo is None:
        raise AuthorizationError(f"{field} must include timezone")
    return parsed.astimezone(timezone.utc)


def read_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AuthorizationError(f"cannot read {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise AuthorizationError(f"{label} must be a JSON object")
    return value


def decode_b64(value: object, label: str) -> bytes:
    if not isinstance(value, str):
        raise AuthorizationError(f"{label} must be base64 text")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise AuthorizationError(f"{label} is invalid base64") from exc


def certificate_time(cert: x509.Certificate, name: str) -> tuple[datetime, datetime]:
    not_before = cert.not_valid_before_utc
    not_after = cert.not_valid_after_utc
    if not_before.tzinfo is None or not_after.tzinfo is None:
        raise AuthorizationError(f"{name} certificate validity has no timezone")
    return not_before.astimezone(timezone.utc), not_after.astimezone(timezone.utc)


def ensure_certificate_current(cert: x509.Certificate, name: str, now: datetime) -> None:
    not_before, not_after = certificate_time(cert, name)
    if now < not_before:
        raise AuthorizationError(f"{name} certificate is not yet valid")
    if now >= not_after:
        raise AuthorizationError(f"{name} certificate is expired")


def verify_public_key_signature(
    public_key: Any,
    signature: bytes,
    payload: bytes,
    algorithm: hashes.HashAlgorithm | None,
    name: str,
) -> None:
    """Verify signatures for the supported public-key families."""
    try:
        if isinstance(public_key, rsa.RSAPublicKey):
            if algorithm is None:
                raise AuthorizationError(f"{name} has no signature hash algorithm")
            public_key.verify(signature, payload, padding.PKCS1v15(), algorithm)
        elif isinstance(public_key, ec.EllipticCurvePublicKey):
            if algorithm is None:
                raise AuthorizationError(f"{name} has no signature hash algorithm")
            public_key.verify(signature, payload, ec.ECDSA(algorithm))
        elif isinstance(public_key, (ed25519.Ed25519PublicKey, ed448.Ed448PublicKey)):
            public_key.verify(signature, payload)
        else:
            raise AuthorizationError(f"{name} uses an unsupported public-key type")
    except InvalidSignature as exc:
        raise AuthorizationError(f"{name} signature is invalid") from exc
    except (TypeError, ValueError) as exc:
        raise AuthorizationError(f"{name} signature could not be verified") from exc


def _read_der_tlv(data: bytes, offset: int = 0) -> tuple[int, bytes, int]:
    """Read one definite-length DER TLV; sufficient for SubjectPublicKeyInfo."""
    if offset >= len(data):
        raise ValueError("DER truncated before tag")
    tag = data[offset]
    offset += 1
    if offset >= len(data):
        raise ValueError("DER truncated before length")
    length_byte = data[offset]
    offset += 1
    if length_byte & 0x80:
        count = length_byte & 0x7F
        if count == 0 or offset + count > len(data):
            raise ValueError("invalid DER length")
        length = int.from_bytes(data[offset:offset + count], "big")
        offset += count
    else:
        length = length_byte
    end = offset + length
    if end > len(data):
        raise ValueError("DER value truncated")
    return tag, data[offset:end], end


def subject_public_key_bits(cert: x509.Certificate) -> bytes:
    """Return the RFC 6960 responder-key-hash input: the SPKI BIT STRING."""
    spki = cert.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    seq_tag, seq_value, end = _read_der_tlv(spki)
    if seq_tag != 0x30 or end != len(spki):
        raise ValueError("invalid SubjectPublicKeyInfo sequence")
    _, _, algorithm_end = _read_der_tlv(seq_value)
    bit_tag, bit_value, bit_end = _read_der_tlv(seq_value, algorithm_end)
    if bit_tag != 0x03 or bit_end != len(seq_value) or not bit_value:
        raise ValueError("invalid SubjectPublicKeyInfo bit string")
    if bit_value[0] != 0:
        raise ValueError("non-zero unused bits in SubjectPublicKeyInfo")
    return bit_value[1:]


def responder_matches(result: Any, cert: x509.Certificate) -> bool:
    if result.responder_name is not None:
        return cert.subject == result.responder_name
    if result.responder_key_hash is not None:
        try:
            return hashlib.sha1(subject_public_key_bits(cert)).digest() == result.responder_key_hash
        except ValueError:
            return False
    return False


def verify_certificate_signed_by(
    certificate: x509.Certificate,
    issuer: x509.Certificate,
    role: str,
    now: datetime,
) -> None:
    if certificate.issuer != issuer.subject:
        raise AuthorizationError(f"{role} OCSP responder issuer does not match configured CA")
    try:
        issuer_constraints = issuer.extensions.get_extension_for_class(x509.BasicConstraints).value
        if not issuer_constraints.ca:
            raise AuthorizationError(f"{role} configured OCSP issuer is not a CA")
    except x509.ExtensionNotFound:
        raise AuthorizationError(f"{role} configured OCSP issuer lacks CA constraints")
    verify_public_key_signature(
        issuer.public_key(),
        certificate.signature,
        certificate.tbs_certificate_bytes,
        certificate.signature_hash_algorithm,
        f"{role} OCSP responder certificate",
    )
    ensure_certificate_current(certificate, f"{role} OCSP responder", now)
    try:
        eku = certificate.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    except x509.ExtensionNotFound as exc:
        raise AuthorizationError(f"{role} OCSP responder lacks id-kp-OCSPSigning") from exc
    if x509.oid.ExtendedKeyUsageOID.OCSP_SIGNING not in eku:
        raise AuthorizationError(f"{role} OCSP responder lacks id-kp-OCSPSigning")


def certificate_is_ca(cert: x509.Certificate, name: str) -> tuple[bool, int | None]:
    try:
        constraints = cert.extensions.get_extension_for_class(x509.BasicConstraints).value
    except x509.ExtensionNotFound as exc:
        raise AuthorizationError(f"{name} lacks BasicConstraints") from exc
    if not constraints.ca:
        raise AuthorizationError(f"{name} is not a CA certificate")
    try:
        key_usage = cert.extensions.get_extension_for_class(x509.KeyUsage).value
        if not key_usage.key_cert_sign:
            raise AuthorizationError(f"{name} lacks keyCertSign usage")
    except x509.ExtensionNotFound:
        pass
    return constraints.ca, constraints.path_length


def verify_certificate_signed_by_path(
    certificate: x509.Certificate,
    signer: x509.Certificate,
    name: str,
) -> None:
    if certificate.issuer != signer.subject:
        raise AuthorizationError(f"{name} issuer does not match its signer")
    verify_public_key_signature(
        signer.public_key(),
        certificate.signature,
        certificate.tbs_certificate_bytes,
        certificate.signature_hash_algorithm,
        name,
    )


def load_pinned_trust_anchor(config_path: Path, name: str) -> x509.Certificate:
    config = read_object(config_path, "trust-anchor configuration")
    anchors = config.get("trust_anchors")
    if not isinstance(anchors, list):
        raise AuthorizationError("trust-anchor configuration requires trust_anchors")
    record = next((item for item in anchors if isinstance(item, dict) and item.get("name") == name), None)
    if record is None:
        raise AuthorizationError(f"pinned trust anchor is not configured: {name}")
    raw = decode_b64(record.get("certificate_der_b64"), f"trust_anchors.{name}.certificate_der_b64")
    try:
        certificate = x509.load_der_x509_certificate(raw)
    except ValueError as exc:
        raise AuthorizationError(f"pinned trust anchor {name} is malformed") from exc
    expected = record.get("sha256_der")
    actual = hashlib.sha256(raw).hexdigest()
    if not isinstance(expected, str) or not hmac_compare(expected, actual):
        raise AuthorizationError(f"pinned trust anchor {name} SHA-256 fingerprint mismatch")
    certificate_is_ca(certificate, f"pinned trust anchor {name}")
    return certificate


def hmac_compare(left: str, right: str) -> bool:
    import hmac
    try:
        return hmac.compare_digest(left.encode("ascii"), right.encode("ascii"))
    except UnicodeEncodeError:
        return False


def build_and_validate_certificate_path(
    leaf: x509.Certificate,
    trust_anchor: x509.Certificate,
    intermediates: tuple[x509.Certificate, ...],
    role: str,
    now: datetime,
) -> tuple[x509.Certificate, ...]:
    """Build a bounded, issuer-linked path ending at the configured trust anchor."""
    path = [leaf]
    current = leaf
    remaining = list(intermediates)
    visited: set[bytes] = set()
    max_depth = 8

    for _ in range(max_depth):
        current_id = hashlib.sha256(
            current.public_bytes(serialization.Encoding.DER)
        ).digest()
        if current_id in visited:
            raise AuthorizationError(
                f"{role} OCSP responder certificate path is circular"
            )
        visited.add(current_id)
        ensure_certificate_current(current, f"{role} OCSP responder path", now)
        if current.issuer == trust_anchor.subject:
            verify_certificate_signed_by_path(current, trust_anchor, f"{role} OCSP responder path")
            certificate_is_ca(trust_anchor, f"{role} OCSP trust anchor")
            path.append(trust_anchor)
            return tuple(path)
        next_cert = next((candidate for candidate in remaining if candidate.subject == current.issuer), None)
        if next_cert is None:
            raise AuthorizationError(f"{role} OCSP responder certificate path is incomplete")
        verify_certificate_signed_by_path(current, next_cert, f"{role} OCSP responder path")
        certificate_is_ca(next_cert, f"{role} OCSP intermediate")
        path.append(next_cert)
        remaining.remove(next_cert)
        current = next_cert
        # `path` always contains the leaf and the newly appended certificate here.
        # The former `if len(path) > 1` guard was invariant-true and created a
        # non-actionable coverage branch; retain the validation unconditionally.
        parent = path[-2]
        try:
            path_length = next_cert.extensions.get_extension_for_class(x509.BasicConstraints).value.path_length
            ca_below = sum(1 for item in path[1:-1] if item.subject != trust_anchor.subject)
            if path_length is not None and ca_below > path_length:
                raise AuthorizationError(f"{role} OCSP responder path exceeds CA path length")
        except x509.ExtensionNotFound as exc:
            raise AuthorizationError(f"{role} OCSP intermediate lacks BasicConstraints") from exc
    raise AuthorizationError(f"{role} OCSP responder path exceeds maximum depth")


def check_certificate_against_crl(
    certificate: x509.Certificate,
    crl: x509.CertificateRevocationList,
    role: str,
    now: datetime,
) -> None:
    next_update = crl.next_update_utc
    last_update = crl.last_update_utc
    if next_update < now or last_update > now:
        raise AuthorizationError(f"{role} responder CRL is outside its validity window")
    if any(item.serial_number == certificate.serial_number for item in crl):
        raise AuthorizationError(f"{role} delegated OCSP responder certificate is revoked by CRL")


def verify_ocsp_response_signature(
    result: Any,
    issuer: x509.Certificate,
    role: str,
    now: datetime,
    revocation_directory: dict[str, Any] | None = None,
    trust_anchor: x509.Certificate | None = None,
) -> None:
    """Validate responder identity, complete path, EKU, revocation, and response signature."""
    if result.responder_name is None and result.responder_key_hash is None:
        raise AuthorizationError(f"{role} OCSP response has no responder identity")

    embedded = tuple(result.certificates or ())
    responder_crl = None
    if not responder_matches(result, issuer) and revocation_directory is not None:
        responder_crl = load_validated_crl(revocation_directory, now, "responder_")
    if responder_matches(result, issuer):
        signer = issuer
        path = (issuer,)
    else:
        signer = next((candidate for candidate in embedded if responder_matches(result, candidate)), None)
        if signer is None:
            raise AuthorizationError(f"{role} OCSP responder identity is not trusted")
        intermediates = tuple(candidate for candidate in embedded if candidate != signer)
        anchor = trust_anchor or issuer
        path = build_and_validate_certificate_path(signer, anchor, intermediates, role, now)
        try:
            eku = signer.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
        except x509.ExtensionNotFound as exc:
            raise AuthorizationError(f"{role} OCSP responder lacks id-kp-OCSPSigning") from exc
        if x509.oid.ExtendedKeyUsageOID.OCSP_SIGNING not in eku:
            raise AuthorizationError(f"{role} OCSP responder lacks id-kp-OCSPSigning")
        if responder_crl is None:
            raise AuthorizationError(f"{role} delegated OCSP responder has no independent CRL")
        check_certificate_against_crl(signer, responder_crl, role, now)

    ensure_certificate_current(signer, f"{role} OCSP signer", now)
    verify_public_key_signature(
        signer.public_key(),
        result.signature,
        result.tbs_response_bytes,
        result.signature_hash_algorithm,
        f"{role} OCSP response",
    )


def load_validated_crl(directory: dict[str, Any], now: datetime, prefix: str = "") -> x509.CertificateRevocationList:
    raw = decode_b64(directory.get(f"{prefix}crl_pem_b64"), f"{prefix}crl_pem_b64")
    issuer_raw = decode_b64(
        directory.get(f"{prefix}crl_issuer_certificate_der_b64"),
        f"{prefix}crl_issuer_certificate_der_b64",
    )
    try:
        crl = x509.load_pem_x509_crl(raw)
    except ValueError:
        try:
            crl = x509.load_der_x509_crl(raw)
        except ValueError as exc:
            raise AuthorizationError(f"{prefix}signed CRL is malformed") from exc
    try:
        issuer = x509.load_der_x509_certificate(issuer_raw)
    except ValueError as exc:
        raise AuthorizationError(f"{prefix}CRL issuer certificate is malformed") from exc
    if crl.issuer != issuer.subject or not crl.is_signature_valid(issuer.public_key()):
        raise AuthorizationError(f"{prefix}CRL issuer or signature is invalid")
    next_update = crl.next_update_utc
    last_update = crl.last_update_utc
    if next_update < now:
        raise AuthorizationError(f"{prefix}CRL is expired")
    if last_update > now:
        raise AuthorizationError(f"{prefix}CRL is not yet valid")
    return crl


def check_crl(directory: dict[str, Any], now: datetime) -> set[str]:
    """Validate a DER/PEM X.509 CRL signed by its declared issuer."""
    crl = load_validated_crl(directory, now)
    return {str(item.serial_number) for item in crl}


def check_ocsp(candidate: dict[str, Any], role: str, now: datetime) -> None:
    """Require a current, cryptographically authenticated OCSP GOOD response."""
    try:
        cert = x509.load_der_x509_certificate(
            decode_b64(candidate.get("certificate_der_b64"), f"{role}.certificate_der_b64")
        )
        issuer = x509.load_der_x509_certificate(
            decode_b64(candidate.get("issuer_certificate_der_b64"), f"{role}.issuer_certificate_der_b64")
        )
    except ValueError as exc:
        raise AuthorizationError(f"{role} OCSP certificate encoding is malformed") from exc
    ensure_certificate_current(cert, f"{role} certificate", now)
    ensure_certificate_current(issuer, f"{role} OCSP issuer", now)

    url = candidate.get("ocsp_url")
    if not isinstance(url, str) or not url.startswith("https://"):
        raise AuthorizationError(f"{role}.ocsp_url must be an HTTPS URL")
    request = ocsp.OCSPRequestBuilder().add_certificate(cert, issuer, hashes.SHA256()).build()
    http_request = urllib.request.Request(
        url,
        data=request.public_bytes(serialization.Encoding.DER),
        headers={"Content-Type": "application/ocsp-request", "Accept": "application/ocsp-response"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(http_request, timeout=3.0) as response:
            response_bytes = response.read()
    except Exception as exc:
        raise AuthorizationError(f"{role} OCSP request failed") from exc
    try:
        result = ocsp.load_der_ocsp_response(response_bytes)
    except ValueError as exc:
        raise AuthorizationError(f"{role} OCSP response is malformed") from exc
    if result.response_status != ocsp.OCSPResponseStatus.SUCCESSFUL:
        raise AuthorizationError(f"{role} OCSP responder was not successful")
    if result.certificate_status != ocsp.OCSPCertStatus.GOOD:
        raise AuthorizationError(f"{role} certificate is revoked or unknown by OCSP")
    if result.serial_number != cert.serial_number:
        raise AuthorizationError(f"{role} OCSP response certificate does not match")
    trust_anchor = None
    if candidate.get("trust_anchor_der_b64"):
        try:
            trust_anchor = x509.load_der_x509_certificate(
                decode_b64(candidate["trust_anchor_der_b64"], f"{role}.trust_anchor_der_b64")
            )
        except ValueError as exc:
            raise AuthorizationError(f"{role} trust anchor certificate is malformed") from exc
    verify_ocsp_response_signature(result, issuer, role, now, candidate, trust_anchor)
    produced = result.this_update_utc
    next_update = result.next_update_utc
    if produced is None:
        raise AuthorizationError(f"{role} OCSP response has no this_update")
    max_age = int(candidate.get("ocsp_max_age_seconds", 3600))
    if max_age <= 0 or (now - produced).total_seconds() > max_age:
        raise AuthorizationError(f"{role} OCSP response is stale")
    if next_update is not None and next_update < now:
        raise AuthorizationError(f"{role} OCSP response is stale")


def verify(
    manifest_path: Path,
    signatures_dir: Path,
    directory_path: Path,
    require_revocation_evidence: bool = False,
    trust_anchor_config: Path | None = None,
    trust_anchor_name: str | None = None,
) -> None:
    manifest = read_object(manifest_path, "manifest")
    directory = read_object(directory_path, "authorized subject directory")
    entries = directory.get("roles")
    if not isinstance(entries, dict):
        raise AuthorizationError("authorized directory requires roles object")
    revoked_serials = {str(value) for value in directory.get("revoked_serials", [])}
    now = datetime.now(timezone.utc)
    pinned_anchor = None
    if (trust_anchor_config is None) != (trust_anchor_name is None):
        raise AuthorizationError("trust-anchor config and name must be supplied together")
    if trust_anchor_config is not None and trust_anchor_name is not None:
        pinned_anchor = load_pinned_trust_anchor(trust_anchor_config, trust_anchor_name)
    if require_revocation_evidence:
        revoked_serials |= check_crl(directory, now)
    approvals = manifest.get("approvals")
    release_sha = manifest.get("release_sha")
    if not isinstance(approvals, list) or len(approvals) != 4:
        raise AuthorizationError("manifest must contain exactly four approvals")
    approval_by_role = {item.get("role"): item for item in approvals if isinstance(item, dict)}
    if len(approval_by_role) != 4:
        raise AuthorizationError("manifest approval roles must be unique")

    for role in ROLES:
        approval = approval_by_role.get(role)
        if not approval:
            raise AuthorizationError(f"missing manifest approval for {role}")
        sidecar = read_object(signatures_dir / f"{role}.json", f"{role} sidecar")
        subject = sidecar.get("subject")
        if subject != approval.get("subject"):
            raise AuthorizationError(f"{role} subject does not match manifest approval")
        candidates = entries.get(role)
        if not isinstance(candidates, list):
            raise AuthorizationError(f"authorized directory has no entries for {role}")
        public_key = decode_b64(sidecar.get("public_key"), f"{role}.public_key")
        if len(public_key) != 32:
            raise AuthorizationError(f"{role} public_key must be 32 bytes")
        key_digest = hashlib.sha256(public_key).hexdigest()
        authorized = False
        for candidate in candidates:
            if not isinstance(candidate, dict) or candidate.get("subject") != subject:
                continue
            serial = candidate.get("certificate_serial")
            if serial is not None and str(serial) in revoked_serials:
                continue
            if candidate.get("status", "active") != "active" or candidate.get("revoked_at") is not None:
                continue
            if candidate.get("public_key_sha256") != key_digest:
                continue
            if "not_before" in candidate and now < parse_time(candidate["not_before"], f"{role}.not_before"):
                continue
            if "not_after" in candidate and now >= parse_time(candidate["not_after"], f"{role}.not_after"):
                continue
            candidate_for_check = dict(candidate)
            if pinned_anchor is not None:
                candidate_for_check["trust_anchor_der_b64"] = base64.b64encode(
                    pinned_anchor.public_bytes(serialization.Encoding.DER)
                ).decode("ascii")
            if require_revocation_evidence:
                if not candidate_for_check.get("certificate_serial"):
                    raise AuthorizationError(f"{role} requires certificate_serial for CRL checking")
                if not candidate_for_check.get("ocsp_url"):
                    raise AuthorizationError(f"{role} requires OCSP evidence")
                check_ocsp(candidate_for_check, role, now)
            elif candidate_for_check.get("ocsp_url"):
                check_ocsp(candidate_for_check, role, now)
            authorized = True
            break
        if not authorized:
            raise AuthorizationError(f"{role} subject/public key is not currently PKI-authorized")
        if sidecar.get("release_sha") != release_sha:
            raise AuthorizationError(f"{role} sidecar release_sha does not match manifest")


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify role sidecars against external PKI authorization")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--signatures-dir", required=True, type=Path)
    parser.add_argument("--authorized-directory", required=True, type=Path)
    parser.add_argument("--require-revocation-evidence", action="store_true")
    parser.add_argument("--trust-anchor-config", type=Path)
    parser.add_argument("--trust-anchor-name")
    args = parser.parse_args()
    try:
        verify(
            args.manifest,
            args.signatures_dir,
            args.authorized_directory,
            args.require_revocation_evidence,
            args.trust_anchor_config,
            args.trust_anchor_name,
        )
    except AuthorizationError as exc:
        print(f"role authorization: FAILED: {exc}", file=sys.stderr)
        return 1
    print("role authorization: PASSED (four subjects, keys, validity, and revocation checks authorized)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
