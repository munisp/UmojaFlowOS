#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import runpy
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, ed448, padding, rsa
from cryptography.x509 import ocsp
from cryptography.x509.oid import NameOID

MODULE_PATH = Path(__file__).with_name("verify_role_sidecar_authorization.py")
SPEC = importlib.util.spec_from_file_location("role_auth", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class RoleAuthorizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sig_dir = self.root / "signatures"
        self.sig_dir.mkdir()
        self.manifest = self.root / "manifest.json"
        release_sha = "a" * 40
        approvals = []
        directory_roles = {}
        for index, role in enumerate(MODULE.ROLES):
            subject = f"{role}-subject"
            raw_key = bytes([index + 1]) * 32
            approvals.append({"role": role, "subject": subject, "release_sha": release_sha})
            self._write(self.sig_dir / f"{role}.json", {
                "role": role, "subject": subject, "release_sha": release_sha,
                "public_key": base64.b64encode(raw_key).decode(),
            })
            directory_roles[role] = [{
                "subject": subject,
                "public_key_sha256": hashlib.sha256(raw_key).hexdigest(),
                "not_before": "2020-01-01T00:00:00Z",
                "not_after": "2099-01-01T00:00:00Z",
            }]
        self._write(self.manifest, {"release_sha": release_sha, "approvals": approvals})
        self.directory = self.root / "directory.json"
        self._write(self.directory, {"roles": directory_roles})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def _write(path: Path, value: dict) -> None:
        path.write_text(json.dumps(value), encoding="utf-8")

    def test_valid_authorized_roles(self) -> None:
        MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_wrong_public_key_digest_rejected(self) -> None:
        data = json.loads(self.directory.read_text())
        data["roles"]["security_owner"][0]["public_key_sha256"] = "0" * 64
        self._write(self.directory, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_unauthorized_subject_rejected(self) -> None:
        data = json.loads(self.directory.read_text())
        data["roles"]["compliance_owner"][0]["subject"] = "different-subject"
        self._write(self.directory, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_expired_entry_rejected(self) -> None:
        data = json.loads(self.directory.read_text())
        data["roles"]["operations_owner"][0]["not_after"] = "2020-01-01T00:00:00Z"
        self._write(self.directory, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_not_yet_valid_entry_rejected(self) -> None:
        data = json.loads(self.directory.read_text())
        data["roles"]["operations_owner"][0]["not_before"] = "2099-01-01T00:00:00Z"
        self._write(self.directory, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_revoked_certificate_serial_rejected(self) -> None:
        data = json.loads(self.directory.read_text())
        data["roles"]["release_manager"][0]["certificate_serial"] = "serial-1"
        data["revoked_serials"] = ["serial-1"]
        self._write(self.directory, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_inactive_or_revoked_entry_rejected(self) -> None:
        data = json.loads(self.directory.read_text())
        data["roles"]["security_owner"][0]["status"] = "revoked"
        self._write(self.directory, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_production_requires_ocsp_evidence(self) -> None:
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory, True)

    def _certificates(self):
        key = ed25519.Ed25519PrivateKey.generate()
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Umoja test CA")])
        issuer = (
            x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(100)
            .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
            .sign(key, None)
        )
        leaf = (
            x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "role")]))
            .issuer_name(issuer.subject).public_key(ed25519.Ed25519PrivateKey.generate().public_key())
            .serial_number(200)
            .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=30))
            .sign(key, None)
        )
        return key, issuer, leaf

    def _crl_directory(self, revoked_serial=None, last=None, next_update=None):
        key, issuer, leaf = self._certificates()
        now = datetime.now(timezone.utc)
        builder = x509.CertificateRevocationListBuilder().issuer_name(issuer.subject).last_update(
            last or (now - timedelta(minutes=1))
        ).next_update(next_update or (now + timedelta(hours=1)))
        if revoked_serial is not None:
            builder = builder.add_revoked_certificate(
                x509.RevokedCertificateBuilder().serial_number(revoked_serial)
                .revocation_date(now - timedelta(minutes=1)).build()
            )
        crl = builder.sign(key, None)
        directory = {
            "crl_pem_b64": base64.b64encode(crl.public_bytes(serialization.Encoding.PEM)).decode(),
            "crl_issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(),
        }
        return directory, leaf

    def test_signed_crl_valid_and_revoked_serials_returned(self) -> None:
        directory, leaf = self._crl_directory(200)
        self.assertEqual(MODULE.check_crl(directory, datetime.now(timezone.utc)), {"200"})
        self.assertEqual(leaf.serial_number, 200)

    def test_signed_der_crl_valid(self) -> None:
        directory, _ = self._crl_directory()
        pem = base64.b64decode(directory["crl_pem_b64"])
        crl = x509.load_pem_x509_crl(pem)
        directory["crl_pem_b64"] = base64.b64encode(crl.public_bytes(serialization.Encoding.DER)).decode()
        self.assertEqual(MODULE.check_crl(directory, datetime.now(timezone.utc)), set())

    def test_ocsp_good_response_is_accepted(self) -> None:
        key, issuer, leaf = self._certificates()
        now = datetime.now(timezone.utc)
        response = (
            ocsp.OCSPResponseBuilder()
            .add_response(
                cert=leaf, issuer=issuer, algorithm=hashes.SHA256(),
                cert_status=ocsp.OCSPCertStatus.GOOD,
                this_update=now - timedelta(seconds=10),
                next_update=now + timedelta(hours=1),
                revocation_time=None, revocation_reason=None,
            )
            .responder_id(ocsp.OCSPResponderEncoding.NAME, issuer)
            .sign(key, None)
        )
        candidate = {
            "certificate_der_b64": base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode(),
            "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(),
            "ocsp_url": "https://ocsp.test", "ocsp_max_age_seconds": 3600,
        }
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(response.public_bytes(serialization.Encoding.DER))):
            MODULE.check_ocsp(candidate, "release_manager", now)

    def test_ocsp_good_response_stale_rejected(self) -> None:
        key, issuer, leaf = self._certificates()
        now = datetime.now(timezone.utc)
        response = (
            ocsp.OCSPResponseBuilder()
            .add_response(cert=leaf, issuer=issuer, algorithm=hashes.SHA256(), cert_status=ocsp.OCSPCertStatus.GOOD,
                          this_update=now - timedelta(hours=2), next_update=now + timedelta(hours=1),
                          revocation_time=None, revocation_reason=None)
            .responder_id(ocsp.OCSPResponderEncoding.NAME, issuer)
            .sign(key, None)
        )
        candidate = {"certificate_der_b64": base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode(),
                     "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(),
                     "ocsp_url": "https://ocsp.test", "ocsp_max_age_seconds": 60}
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(response.public_bytes(serialization.Encoding.DER))):
            with self.assertRaises(MODULE.AuthorizationError): MODULE.check_ocsp(candidate, "release_manager", now)

    def test_signed_crl_malformed_rejected(self) -> None:
        with self.assertRaises(MODULE.AuthorizationError): MODULE.check_crl({"crl_pem_b64": "eA=="}, datetime.now(timezone.utc))

    def test_signed_crl_bad_issuer_signature_rejected(self) -> None:
        directory, _ = self._crl_directory()
        _, wrong_issuer, _ = self._certificates()
        directory["crl_issuer_certificate_der_b64"] = base64.b64encode(wrong_issuer.public_bytes(serialization.Encoding.DER)).decode()
        with self.assertRaises(MODULE.AuthorizationError): MODULE.check_crl(directory, datetime.now(timezone.utc))

    def test_signed_crl_expired_rejected(self) -> None:
        directory, _ = self._crl_directory(next_update=datetime.now(timezone.utc) - timedelta(seconds=1))
        with self.assertRaises(MODULE.AuthorizationError): MODULE.check_crl(directory, datetime.now(timezone.utc))

    def test_signed_crl_not_yet_valid_rejected(self) -> None:
        directory, _ = self._crl_directory(last=datetime.now(timezone.utc) + timedelta(minutes=1))
        with self.assertRaises(MODULE.AuthorizationError): MODULE.check_crl(directory, datetime.now(timezone.utc))

    def test_ocsp_requires_https(self) -> None:
        _, issuer, leaf = self._certificates()
        candidate = {"certificate_der_b64": base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode(), "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(), "ocsp_url": "http://ocsp.test"}
        with self.assertRaises(MODULE.AuthorizationError): MODULE.check_ocsp(candidate, "release_manager", datetime.now(timezone.utc))

    def test_ocsp_transport_failure_rejected(self) -> None:
        _, issuer, leaf = self._certificates()
        candidate = {"certificate_der_b64": base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode(), "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(), "ocsp_url": "https://ocsp.test"}
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=TimeoutError):
            with self.assertRaises(MODULE.AuthorizationError): MODULE.check_ocsp(candidate, "release_manager", datetime.now(timezone.utc))

    def test_ocsp_malformed_response_rejected(self) -> None:
        _, issuer, leaf = self._certificates()
        candidate = {"certificate_der_b64": base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode(), "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(), "ocsp_url": "https://ocsp.test"}
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(b"invalid")):
            with self.assertRaises(MODULE.AuthorizationError): MODULE.check_ocsp(candidate, "release_manager", datetime.now(timezone.utc))

    def test_ocsp_non_success_response_rejected(self) -> None:
        _, issuer, leaf = self._certificates()
        candidate = {"certificate_der_b64": base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode(), "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(), "ocsp_url": "https://ocsp.test"}
        response = ocsp.OCSPResponseBuilder().build_unsuccessful(ocsp.OCSPResponseStatus.MALFORMED_REQUEST)
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(response.public_bytes(serialization.Encoding.DER))):
            with self.assertRaises(MODULE.AuthorizationError): MODULE.check_ocsp(candidate, "release_manager", datetime.now(timezone.utc))

    def test_parse_time_and_decode_errors_rejected(self) -> None:
        with self.assertRaises(MODULE.AuthorizationError): MODULE.parse_time("not-time", "x")
        with self.assertRaises(MODULE.AuthorizationError): MODULE.parse_time("2026-01-01T00:00:00", "x")
        with self.assertRaises(MODULE.AuthorizationError): MODULE.decode_b64("!", "x")
        with self.assertRaises(MODULE.AuthorizationError): MODULE.decode_b64(None, "x")

    def test_read_object_errors_rejected(self) -> None:
        missing = self.root / "missing.json"
        with self.assertRaises(MODULE.AuthorizationError): MODULE.read_object(missing, "missing")
        bad = self.root / "bad.json"; bad.write_text("{")
        with self.assertRaises(MODULE.AuthorizationError): MODULE.read_object(bad, "bad")
        scalar = self.root / "scalar.json"; scalar.write_text("[]")
        with self.assertRaises(MODULE.AuthorizationError): MODULE.read_object(scalar, "scalar")

    def test_crl_missing_issuer_and_bad_issuer_bytes_rejected(self) -> None:
        with self.assertRaises(MODULE.AuthorizationError): MODULE.check_crl({}, datetime.now(timezone.utc))
        directory, _ = self._crl_directory()
        directory["crl_issuer_certificate_der_b64"] = base64.b64encode(b"bad").decode()
        with self.assertRaises(MODULE.AuthorizationError): MODULE.check_crl(directory, datetime.now(timezone.utc))

    def test_ocsp_malformed_certificates_rejected(self) -> None:
        with self.assertRaises(MODULE.AuthorizationError): MODULE.check_ocsp({}, "release_manager", datetime.now(timezone.utc))
        _, issuer, leaf = self._certificates()
        candidate = {"certificate_der_b64": base64.b64encode(b"bad").decode(), "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(), "ocsp_url": "https://ocsp.test"}
        with self.assertRaises(Exception): MODULE.check_ocsp(candidate, "release_manager", datetime.now(timezone.utc))

    def test_manifest_shape_failures_rejected(self) -> None:
        original = json.loads(self.manifest.read_text())
        for approvals in ([], original["approvals"][:3], original["approvals"] + [original["approvals"][0]]):
            data = dict(original); data["approvals"] = approvals; self._write(self.manifest, data)
            with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)
        duplicate = dict(original); duplicate["approvals"] = [dict(item, role="release_manager") for item in original["approvals"]]; self._write(self.manifest, duplicate)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)
        self._write(self.manifest, original)

    def test_sidecar_and_directory_shape_failures_rejected(self) -> None:
        sidecar = self.sig_dir / "release_manager.json"
        saved = sidecar.read_text()
        data = json.loads(saved); data["subject"] = "wrong"; self._write(sidecar, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)
        sidecar.write_text(saved)
        directory = json.loads(self.directory.read_text()); directory["roles"]["security_owner"] = {}; self._write(self.directory, directory)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

        directory = json.loads(self.directory.read_text()); directory["roles"]["security_owner"] = [{"subject": "security_owner-subject", "public_key_sha256": "0"}]; self._write(self.directory, directory)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_revoked_at_and_missing_production_fields_rejected(self) -> None:
        data = json.loads(self.directory.read_text()); data["roles"]["release_manager"][0]["revoked_at"] = "2026-01-01T00:00:00Z"; self._write(self.directory, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)
        data["roles"]["release_manager"][0].pop("revoked_at"); data["roles"]["release_manager"][0]["certificate_serial"] = "1"; self._write(self.directory, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory, True)

        data["roles"]["release_manager"][0]["ocsp_url"] = "https://ocsp.test"; self._write(self.directory, data)
        with patch.object(MODULE, "check_ocsp", side_effect=MODULE.AuthorizationError("revoked")):
            with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_missing_manifest_role_rejected(self) -> None:
        data = json.loads(self.manifest.read_text())
        data["approvals"] = [item for item in data["approvals"] if item["role"] != "release_manager"] + [{"role": "other", "subject": "x"}]
        self._write(self.manifest, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_invalid_public_key_length_rejected(self) -> None:
        path = self.sig_dir / "release_manager.json"
        data = json.loads(path.read_text()); data["public_key"] = base64.b64encode(b"short").decode(); self._write(path, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_missing_role_entry_rejected(self) -> None:
        data = json.loads(self.directory.read_text()); del data["roles"]["operations_owner"]; self._write(self.directory, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_candidate_non_dict_and_release_sha_branches_rejected(self) -> None:
        data = json.loads(self.directory.read_text())
        valid = data["roles"]["release_manager"][0]
        data["roles"]["release_manager"] = ["not-an-object", {"subject": "other"}, valid]
        self._write(self.directory, data)
        path = self.sig_dir / "release_manager.json"; sidecar = json.loads(path.read_text()); sidecar["release_sha"] = "b" * 40; self._write(path, sidecar)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_sidecar_release_sha_mismatch_rejected(self) -> None:
        path = self.sig_dir / "operations_owner.json"; data = json.loads(path.read_text()); data["release_sha"] = "b" * 40; self._write(path, data)
        with self.assertRaises(MODULE.AuthorizationError): MODULE.verify(self.manifest, self.sig_dir, self.directory)

    def test_cli_success_and_failure(self) -> None:
        with patch.object(MODULE.sys, "argv", ["verify", "--manifest", str(self.manifest), "--signatures-dir", str(self.sig_dir), "--authorized-directory", str(self.directory)]):
            self.assertEqual(MODULE.main(), 0)
        path = self.sig_dir / "release_manager.json"; data = json.loads(path.read_text()); data["release_sha"] = "b" * 40; self._write(path, data)
        with patch.object(MODULE.sys, "argv", ["verify", "--manifest", str(self.manifest), "--signatures-dir", str(self.sig_dir), "--authorized-directory", str(self.directory)]):
            self.assertEqual(MODULE.main(), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)


# Generated certificate-chain tests for the bounded OCSP responder path.
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID


def _generated_name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def _generated_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _generated_ca(
    common_name: str,
    issuer: x509.Certificate | None,
    issuer_key,
    path_length: int | None = None,
):
    key = _generated_key()
    subject = _generated_name(common_name)
    issuer_name = issuer.subject if issuer is not None else subject
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=True, path_length=path_length), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(issuer_key or key, hashes.SHA256())
    )
    return key, cert


def _generated_responder(common_name: str, issuer: x509.Certificate, issuer_key):
    key = _generated_key()
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(_generated_name(common_name))
        .issuer_name(issuer.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.OCSP_SIGNING]),
            critical=False,
        )
        .sign(issuer_key, hashes.SHA256())
    )
    return key, cert


class GeneratedCertificatePathTests(unittest.TestCase):
    def test_valid_multi_intermediate_path(self) -> None:
        root_key, root = _generated_ca("Root", None, None, 3)
        int1_key, int1 = _generated_ca("Intermediate 1", root, root_key, 2)
        int2_key, int2 = _generated_ca("Intermediate 2", int1, int1_key, 1)
        _, responder = _generated_responder("Delegated Responder", int2, int2_key)

        path = MODULE.build_and_validate_certificate_path(
            responder,
            root,
            (int1, int2),
            "security_owner",
            datetime.now(timezone.utc),
        )

        self.assertEqual(
            [item.subject.rfc4514_string() for item in path],
            [
                responder.subject.rfc4514_string(),
                int2.subject.rfc4514_string(),
                int1.subject.rfc4514_string(),
                root.subject.rfc4514_string(),
            ],
        )

    def test_missing_intermediate_is_rejected(self) -> None:
        root_key, root = _generated_ca("Root", None, None, 3)
        int1_key, int1 = _generated_ca("Intermediate 1", root, root_key, 2)
        _, responder = _generated_responder("Delegated Responder", int1, int1_key)

        with self.assertRaisesRegex(
            MODULE.AuthorizationError,
            "certificate path is incomplete",
        ):
            MODULE.build_and_validate_certificate_path(
                responder,
                root,
                (),
                "security_owner",
                datetime.now(timezone.utc),
            )

    def test_invalid_intermediate_signature_is_rejected(self) -> None:
        root_key, root = _generated_ca("Root", None, None, 3)
        int1_key, int1 = _generated_ca("Intermediate 1", root, root_key, 2)
        _, responder = _generated_responder("Delegated Responder", int1, int1_key)
        wrong_key, wrong_root = _generated_ca("Wrong Root", None, None, 3)

        with self.assertRaises(MODULE.AuthorizationError):
            MODULE.build_and_validate_certificate_path(
                responder,
                wrong_root,
                (int1,),
                "security_owner",
                datetime.now(timezone.utc),
            )

    def test_path_depth_limit_is_enforced(self) -> None:
        root_key, root = _generated_ca("Root", None, None, 12)
        intermediates = []
        parent = root
        parent_key = root_key
        for index in range(8):
            parent_key, parent = _generated_ca(
                f"Intermediate {index}",
                parent,
                parent_key,
                12 - index,
            )
            intermediates.append(parent)
        responder_key, responder = _generated_responder(
            "Delegated Responder",
            parent,
            parent_key,
        )

        with self.assertRaisesRegex(
            MODULE.AuthorizationError,
            "exceeds maximum depth",
        ):
            MODULE.build_and_validate_certificate_path(
                responder,
                root,
                tuple(intermediates),
                "security_owner",
                datetime.now(timezone.utc),
            )

    def test_delegated_responder_revoked_by_independent_crl(self) -> None:
        now = datetime.now(timezone.utc)
        root_key, root = _generated_ca("Root", None, None, 3)
        responder_key, responder = _generated_responder(
            "Delegated Responder",
            root,
            root_key,
        )
        crl = (
            x509.CertificateRevocationListBuilder()
            .issuer_name(root.subject)
            .last_update(now - timedelta(minutes=1))
            .next_update(now + timedelta(hours=1))
            .add_revoked_certificate(
                x509.RevokedCertificateBuilder()
                .serial_number(responder.serial_number)
                .revocation_date(now - timedelta(minutes=1))
                .build()
            )
            .sign(root_key, hashes.SHA256())
        )

        with self.assertRaisesRegex(
            MODULE.AuthorizationError,
            "delegated OCSP responder certificate is revoked",
        ):
            MODULE.check_certificate_against_crl(
                responder,
                crl,
                "security_owner",
                now,
            )

    def test_pinned_trust_anchor_fingerprint_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root_key, root = _generated_ca("Root", None, None, 3)
            root_der = root.public_bytes(serialization.Encoding.DER)
            config = Path(directory) / "anchors.json"
            config.write_text(
                json.dumps(
                    {
                        "trust_anchors": [
                            {
                                "name": "root",
                                "certificate_der_b64": base64.b64encode(root_der).decode(),
                                "sha256_der": "0" * 64,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                MODULE.AuthorizationError,
                "fingerprint mismatch",
            ):
                MODULE.load_pinned_trust_anchor(config, "root")


class RemainingVerifierBranchTests(unittest.TestCase):
    def test_public_key_dispatch_rsa_ecdsa_ed25519_ed448_and_failures(self) -> None:
        payload = b"coverage-payload"
        rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        rsa_sig = rsa_key.sign(payload, padding.PKCS1v15(), hashes.SHA256())
        MODULE.verify_public_key_signature(rsa_key.public_key(), rsa_sig, payload, hashes.SHA256(), "rsa")

        ec_key = ec.generate_private_key(ec.SECP256R1())
        ec_sig = ec_key.sign(payload, ec.ECDSA(hashes.SHA256()))
        MODULE.verify_public_key_signature(ec_key.public_key(), ec_sig, payload, hashes.SHA256(), "ecdsa")

        ed_key = ed25519.Ed25519PrivateKey.generate()
        MODULE.verify_public_key_signature(ed_key.public_key(), ed_key.sign(payload), payload, None, "ed25519")

        ed448_key = ed448.Ed448PrivateKey.generate()
        MODULE.verify_public_key_signature(ed448_key.public_key(), ed448_key.sign(payload), payload, None, "ed448")

        with self.assertRaises(MODULE.AuthorizationError):
            MODULE.verify_public_key_signature(rsa_key.public_key(), b"bad", payload, hashes.SHA256(), "rsa")
        with self.assertRaises(MODULE.AuthorizationError):
            MODULE.verify_public_key_signature(rsa_key.public_key(), rsa_sig, payload, None, "rsa")
        with self.assertRaises(MODULE.AuthorizationError):
            MODULE.verify_public_key_signature(object(), b"bad", payload, None, "unknown")

    def test_der_tlv_and_responder_key_hash_failure_paths(self) -> None:
        for value in (b"", b"\x30", b"\x30\x82\xff"):
            with self.assertRaises(ValueError):
                MODULE._read_der_tlv(value)
        _, issuer, _ = self._certificates()
        result = Mock(responder_name=None, responder_key_hash=b"bad")
        self.assertFalse(MODULE.responder_matches(result, issuer))

    @staticmethod
    def _certificates():
        key = ed25519.Ed25519PrivateKey.generate()
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "CA")])
        now = datetime.now(timezone.utc)
        issuer = (
            x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(101)
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=30))
            .sign(key, None)
        )
        leaf = (
            x509.CertificateBuilder().subject_name(_generated_name("leaf")).issuer_name(name)
            .public_key(ed25519.Ed25519PrivateKey.generate().public_key()).serial_number(102)
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=30))
            .sign(key, None)
        )
        return key, issuer, leaf

    def test_certificate_validity_and_ca_error_paths(self) -> None:
        key, issuer, leaf = self._certificates()
        now = datetime.now(timezone.utc)
        with self.assertRaises(MODULE.AuthorizationError):
            MODULE.ensure_certificate_current(leaf, "leaf", now + timedelta(days=365))
        with self.assertRaises(MODULE.AuthorizationError):
            MODULE.certificate_is_ca(issuer, "issuer")
        with self.assertRaises(MODULE.AuthorizationError):
            MODULE.verify_certificate_signed_by(leaf, issuer, "role", now)

    def test_pinned_anchor_missing_bad_shape_and_bad_certificate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "anchors.json"
            path.write_text(json.dumps({}), encoding="utf-8")
            with self.assertRaises(MODULE.AuthorizationError):
                MODULE.load_pinned_trust_anchor(path, "root")
            path.write_text(json.dumps({"trust_anchors": []}), encoding="utf-8")
            with self.assertRaises(MODULE.AuthorizationError):
                MODULE.load_pinned_trust_anchor(path, "root")

    def test_cycle_error_is_dedicated_when_certificate_reappears(self) -> None:
        leaf = Mock()
        node = Mock()
        anchor = Mock()
        leaf.subject, leaf.issuer = "A", "B"
        node.subject, node.issuer = "B", "A"
        anchor.subject, anchor.issuer = "ROOT", "ROOT"
        leaf.public_bytes.return_value = b"leaf"
        node.public_bytes.return_value = b"node"
        anchor.public_bytes.return_value = b"anchor"
        leaf.extensions.get_extension_for_class.return_value.value.path_length = None
        node.extensions.get_extension_for_class.return_value.value.path_length = None
        with patch.object(MODULE, "ensure_certificate_current"), patch.object(
            MODULE, "verify_certificate_signed_by_path"
        ), patch.object(MODULE, "certificate_is_ca", return_value=(True, None)):
            with self.assertRaisesRegex(
                MODULE.AuthorizationError,
                "certificate path is circular",
            ):
                MODULE.build_and_validate_certificate_path(
                    leaf,
                    anchor,
                    (node, leaf),
                    "operations_owner",
                    datetime.now(timezone.utc),
                )


class ResidualOCSPCRLBranchTests(unittest.TestCase):
    @staticmethod
    def _ocsp_candidate(status):
        key, issuer, leaf = RoleAuthorizationTests()._certificates()
        now = datetime.now(timezone.utc)
        builder = (
            ocsp.OCSPResponseBuilder()
            .add_response(
                cert=leaf,
                issuer=issuer,
                algorithm=hashes.SHA256(),
                cert_status=status,
                this_update=now - timedelta(seconds=5),
                next_update=now + timedelta(hours=1),
                revocation_time=(now - timedelta(minutes=1)) if status == ocsp.OCSPCertStatus.REVOKED else None,
                revocation_reason=None,
            )
            .responder_id(ocsp.OCSPResponderEncoding.NAME, issuer)
            .sign(key, None)
        )
        candidate = {
            "certificate_der_b64": base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode(),
            "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(),
            "ocsp_url": "https://ocsp.test",
            "ocsp_max_age_seconds": 3600,
        }
        return candidate, builder.public_bytes(serialization.Encoding.DER), now

    def test_ocsp_revoked_status_fails_closed(self) -> None:
        candidate, body, now = self._ocsp_candidate(ocsp.OCSPCertStatus.REVOKED)
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(body)):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "revoked or unknown"):
                MODULE.check_ocsp(candidate, "security_owner", now)

    def test_ocsp_unknown_status_fails_closed(self) -> None:
        candidate, body, now = self._ocsp_candidate(ocsp.OCSPCertStatus.UNKNOWN)
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(body)):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "revoked or unknown"):
                MODULE.check_ocsp(candidate, "security_owner", now)

    def test_crl_valid_base64_invalid_der_reaches_der_fallback(self) -> None:
        malformed_der = base64.b64encode(b"\x30\x82\x01").decode()
        directory = {
            "crl_pem_b64": malformed_der,
            "crl_issuer_certificate_der_b64": base64.b64encode(b"unused").decode(),
        }
        with self.assertRaisesRegex(MODULE.AuthorizationError, "signed CRL is malformed"):
            MODULE.check_crl(directory, datetime.now(timezone.utc))

    def test_crl_valid_der_but_malformed_issuer_rejected(self) -> None:
        directory, _ = RoleAuthorizationTests()._crl_directory()
        directory["crl_issuer_certificate_der_b64"] = base64.b64encode(b"\x30\x82\x01").decode()
        with self.assertRaisesRegex(MODULE.AuthorizationError, "CRL issuer certificate is malformed"):
            MODULE.check_crl(directory, datetime.now(timezone.utc))


class RemainingOCSPPathAndFailClosedTests(unittest.TestCase):
    def _mock_cert(self, subject="subject", issuer="issuer"):
        cert = Mock()
        cert.subject = subject
        cert.issuer = issuer
        cert.public_bytes.return_value = subject.encode()
        cert.public_key.return_value = Mock()
        cert.signature = b"signature"
        cert.tbs_certificate_bytes = b"tbs"
        cert.signature_hash_algorithm = hashes.SHA256()
        return cert

    def test_verify_certificate_signed_by_rejects_non_ca_issuer(self) -> None:
        cert = self._mock_cert()
        issuer = self._mock_cert(subject="issuer", issuer="issuer")
        issuer.extensions.get_extension_for_class.return_value.value.ca = False
        with self.assertRaisesRegex(MODULE.AuthorizationError, "not a CA"):
            MODULE.verify_certificate_signed_by(cert, issuer, "role", datetime.now(timezone.utc))

    def test_verify_certificate_signed_by_rejects_missing_ca_constraints(self) -> None:
        cert = self._mock_cert()
        issuer = self._mock_cert(subject="issuer", issuer="issuer")
        issuer.extensions.get_extension_for_class.side_effect = x509.ExtensionNotFound(
            "basicConstraints", x509.ObjectIdentifier("2.5.29.19")
        )
        with self.assertRaisesRegex(MODULE.AuthorizationError, "lacks CA constraints"):
            MODULE.verify_certificate_signed_by(cert, issuer, "role", datetime.now(timezone.utc))

    def test_verify_certificate_signed_by_accepts_ocsp_eku(self) -> None:
        cert = self._mock_cert()
        issuer = self._mock_cert(subject="issuer", issuer="issuer")
        issuer.extensions.get_extension_for_class.return_value.value.ca = True
        cert.extensions.get_extension_for_class.return_value.value = [
            x509.oid.ExtendedKeyUsageOID.OCSP_SIGNING
        ]
        with patch.object(MODULE, "verify_public_key_signature"), patch.object(
            MODULE, "ensure_certificate_current"
        ):
            MODULE.verify_certificate_signed_by(cert, issuer, "role", datetime.now(timezone.utc))

    def test_verify_certificate_signed_by_rejects_missing_and_wrong_eku(self) -> None:
        issuer = self._mock_cert(subject="issuer", issuer="issuer")
        issuer.extensions.get_extension_for_class.return_value.value.ca = True
        for eku in (None, [x509.oid.ExtendedKeyUsageOID.CLIENT_AUTH]):
            cert = self._mock_cert()
            if eku is None:
                cert.extensions.get_extension_for_class.side_effect = x509.ExtensionNotFound(
                    "extendedKeyUsage", x509.ObjectIdentifier("2.5.29.37")
                )
            else:
                cert.extensions.get_extension_for_class.return_value.value = eku
            with patch.object(MODULE, "verify_public_key_signature"), patch.object(
                MODULE, "ensure_certificate_current"
            ), self.assertRaisesRegex(MODULE.AuthorizationError, "OCSP.*OCSPSigning"):
                MODULE.verify_certificate_signed_by(cert, issuer, "role", datetime.now(timezone.utc))

    def test_delegated_responder_is_discovered_and_validated(self) -> None:
        issuer = self._mock_cert(subject="issuer", issuer="issuer")
        signer = self._mock_cert(subject="responder", issuer="issuer")
        signer.extensions.get_extension_for_class.return_value.value = [
            x509.oid.ExtendedKeyUsageOID.OCSP_SIGNING
        ]
        result = Mock()
        result.responder_name = signer.subject
        result.responder_key_hash = None
        result.certificates = (signer,)
        result.signature = b"response-signature"
        result.tbs_response_bytes = b"response-tbs"
        result.signature_hash_algorithm = hashes.SHA256()
        revocation = {"responder_crl_pem_b64": "x", "responder_crl_issuer_certificate_der_b64": "x"}
        with patch.object(MODULE, "responder_matches", side_effect=lambda response, cert: cert is signer), patch.object(
            MODULE, "load_validated_crl", return_value=Mock()
        ), patch.object(MODULE, "build_and_validate_certificate_path", return_value=(signer, issuer)), patch.object(
            MODULE, "ensure_certificate_current"
        ), patch.object(MODULE, "verify_public_key_signature"), patch.object(
            MODULE, "check_certificate_against_crl"
        ):
            MODULE.verify_ocsp_response_signature(
                result, issuer, "security_owner", datetime.now(timezone.utc), revocation
            )

    def test_delegated_responder_identity_and_crl_fail_closed(self) -> None:
        issuer = self._mock_cert(subject="issuer", issuer="issuer")
        result = Mock()
        result.responder_name = "missing"
        result.responder_key_hash = None
        result.certificates = ()
        with self.assertRaisesRegex(MODULE.AuthorizationError, "identity is not trusted"):
            MODULE.verify_ocsp_response_signature(
                result, issuer, "security_owner", datetime.now(timezone.utc), None
            )

        signer = self._mock_cert(subject="responder", issuer="issuer")
        signer.extensions.get_extension_for_class.return_value.value = [
            x509.oid.ExtendedKeyUsageOID.OCSP_SIGNING
        ]
        result.certificates = (signer,)
        with patch.object(MODULE, "responder_matches", side_effect=lambda response, cert: cert is signer), patch.object(
            MODULE, "load_validated_crl", return_value=Mock()
        ), patch.object(MODULE, "build_and_validate_certificate_path", return_value=(signer, issuer)), patch.object(
            MODULE, "ensure_certificate_current"
        ), patch.object(MODULE, "verify_public_key_signature"):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "no independent CRL"):
                MODULE.verify_ocsp_response_signature(
                    result, issuer, "security_owner", datetime.now(timezone.utc), None
                )


class CertificateTimeAndDERLengthTests(unittest.TestCase):
    def test_certificate_time_rejects_naive_timestamps(self) -> None:
        cert = Mock()
        cert.not_valid_before_utc = datetime(2026, 1, 1)
        cert.not_valid_after_utc = datetime(2027, 1, 1)
        with self.assertRaisesRegex(
            MODULE.AuthorizationError,
            "validity has no timezone",
        ):
            MODULE.certificate_time(cert, "naive")

    def test_rsa_and_ecdsa_missing_hash_algorithm_fail_closed(self) -> None:
        payload = b"payload"
        rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ec_key = ec.generate_private_key(ec.SECP256R1())
        for public_key, name in ((rsa_key.public_key(), "rsa"), (ec_key.public_key(), "ecdsa")):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "signature could not be verified"):
                MODULE.verify_public_key_signature(public_key, b"signature", payload, None, name)

    def test_der_long_form_length_and_truncation_paths(self) -> None:
        self.assertEqual(MODULE._read_der_tlv(b"\x04\x81\x01x"), (0x04, b"x", 4))
        with self.assertRaisesRegex(ValueError, "invalid DER length"):
            MODULE._read_der_tlv(b"\x04\x80")
        with self.assertRaisesRegex(ValueError, "invalid DER length"):
            MODULE._read_der_tlv(b"\x04\x82\x01")
        with self.assertRaisesRegex(ValueError, "DER value truncated"):
            MODULE._read_der_tlv(b"\x04\x02x")


class RemainingSPKIAndTrustAnchorTests(unittest.TestCase):
    def _cert_with_spki(self, encoded: bytes):
        cert = Mock()
        cert.public_key.return_value.public_bytes.return_value = encoded
        return cert

    def test_spki_invalid_sequence_tag_and_trailing_bytes(self) -> None:
        for encoded in (b"\x04\x00", b"\x30\x02\x30\x00\x00"):
            with self.assertRaises(ValueError):
                MODULE.subject_public_key_bits(self._cert_with_spki(encoded))

    def test_spki_invalid_algorithm_or_bit_string_tlv(self) -> None:
        malformed = (
            b"\x30\x03\x30\x01\x00",       # no BIT STRING
            b"\x30\x06\x30\x00\x04\x02xx", # wrong BIT STRING tag
            b"\x30\x07\x30\x00\x03\x03\x01xx", # non-zero unused bits
        )
        for encoded in malformed:
            with self.assertRaises(ValueError):
                MODULE.subject_public_key_bits(self._cert_with_spki(encoded))

    def test_spki_valid_bit_string_returns_key_bits(self) -> None:
        encoded = b"\x30\x08\x30\x00\x03\x04\x00abc"
        self.assertEqual(
            MODULE.subject_public_key_bits(self._cert_with_spki(encoded)),
            b"abc",
        )

    def test_trust_anchor_configuration_shape_and_encoding_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "anchors.json"
            cases = (
                {},
                {"trust_anchors": "not-a-list"},
                {"trust_anchors": [{"name": "root"}]},
                {"trust_anchors": [{"name": "root", "certificate_der_b64": "%%%", "sha256_der": "0" * 64}]},
            )
            for value in cases:
                path.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(MODULE.AuthorizationError):
                    MODULE.load_pinned_trust_anchor(path, "root")

    def test_trust_anchor_not_ca_is_rejected(self) -> None:
        key = ed25519.Ed25519PrivateKey.generate()
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "not-ca")])
        now = datetime.now(timezone.utc)
        certificate = (
            x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(901)
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=30))
            .sign(key, None)
        )
        raw = certificate.public_bytes(serialization.Encoding.DER)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "anchors.json"
            path.write_text(json.dumps({
                "trust_anchors": [{
                    "name": "root",
                    "certificate_der_b64": base64.b64encode(raw).decode(),
                    "sha256_der": hashlib.sha256(raw).hexdigest(),
                }]
            }), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.AuthorizationError, "BasicConstraints"):
                MODULE.load_pinned_trust_anchor(path, "root")


class FinalVerifierGapCoverageTests(unittest.TestCase):
    def _mock_cert(self, subject="subject", issuer="issuer", der=b"cert"):
        cert = Mock()
        cert.subject = subject
        cert.issuer = issuer
        cert.public_bytes.return_value = der
        cert.public_key.return_value = Mock()
        cert.signature = b"signature"
        cert.tbs_certificate_bytes = b"tbs"
        cert.signature_hash_algorithm = hashes.SHA256()
        return cert

    def test_responder_key_hash_and_no_identity(self) -> None:
        cert = self._mock_cert(der=b"spki-cert")
        result = Mock(responder_name=None, responder_key_hash=hashlib.sha1(b"bits").digest())
        with patch.object(MODULE, "subject_public_key_bits", return_value=b"bits"):
            self.assertTrue(MODULE.responder_matches(result, cert))
        result.responder_key_hash = b"wrong"
        with patch.object(MODULE, "subject_public_key_bits", side_effect=ValueError("bad spki")):
            self.assertFalse(MODULE.responder_matches(result, cert))
        result.responder_key_hash = None
        self.assertFalse(MODULE.responder_matches(result, cert))

    def test_certificate_issuer_and_ca_key_usage_failures(self) -> None:
        cert = self._mock_cert(issuer="wrong")
        issuer = self._mock_cert(subject="issuer")
        with self.assertRaisesRegex(MODULE.AuthorizationError, "issuer does not match"):
            MODULE.verify_certificate_signed_by_path(cert, issuer, "path")

        cert = self._mock_cert()
        issuer = self._mock_cert(subject="issuer")
        issuer.extensions.get_extension_for_class.return_value.value.ca = True
        with patch.object(MODULE, "verify_public_key_signature"), patch.object(MODULE, "ensure_certificate_current"):
            cert.extensions.get_extension_for_class.return_value.value = []
            with self.assertRaisesRegex(MODULE.AuthorizationError, "lacks id-kp-OCSPSigning"):
                MODULE.verify_certificate_signed_by(cert, issuer, "role", datetime.now(timezone.utc))

        ca = self._mock_cert()
        ca.extensions.get_extension_for_class.return_value.value.ca = False
        with self.assertRaisesRegex(MODULE.AuthorizationError, "not a CA"):
            MODULE.certificate_is_ca(ca, "intermediate")

        ca = self._mock_cert()
        constraints = Mock(ca=True, path_length=0)
        ca.extensions.get_extension_for_class.return_value.value = constraints
        usage = Mock(key_cert_sign=False)
        ca.extensions.get_extension_for_class.side_effect = [Mock(value=constraints), Mock(value=usage)]
        with self.assertRaisesRegex(MODULE.AuthorizationError, "keyCertSign"):
            MODULE.certificate_is_ca(ca, "intermediate")

        ca = self._mock_cert()
        ca.extensions.get_extension_for_class.side_effect = [Mock(value=constraints), x509.ExtensionNotFound("missing", x509.ObjectIdentifier("2.5.29.15"))]
        self.assertEqual(MODULE.certificate_is_ca(ca, "intermediate"), (True, 0))

    def test_path_anchor_transition_and_ca_path_length_failure(self) -> None:
        now = datetime.now(timezone.utc)
        leaf = self._mock_cert(subject="leaf", issuer="anchor", der=b"leaf")
        anchor = self._mock_cert(subject="anchor", issuer="anchor", der=b"anchor")
        with patch.object(MODULE, "ensure_certificate_current"), patch.object(MODULE, "verify_certificate_signed_by_path"), patch.object(MODULE, "certificate_is_ca"):
            self.assertEqual(MODULE.build_and_validate_certificate_path(leaf, anchor, (), "role", now), (leaf, anchor))

        current = self._mock_cert(subject="anchor", issuer="anchor", der=b"anchor")
        with self.assertRaisesRegex(MODULE.AuthorizationError, "signature could not be verified"):
            with patch.object(MODULE, "ensure_certificate_current"):
                MODULE.build_and_validate_certificate_path(current, current, (), "role", now)

        parent1 = self._mock_cert(subject="parent1", issuer="parent2", der=b"parent1")
        parent2 = self._mock_cert(subject="parent2", issuer="anchor", der=b"parent2")
        leaf = self._mock_cert(subject="leaf", issuer="parent1", der=b"leaf")
        parent1.extensions.get_extension_for_class.return_value = Mock(value=Mock(path_length=None))
        parent2.extensions.get_extension_for_class.return_value = Mock(value=Mock(path_length=0))
        with patch.object(MODULE, "ensure_certificate_current"), patch.object(MODULE, "verify_certificate_signed_by_path"), patch.object(MODULE, "certificate_is_ca", return_value=(True, 0)):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "path exceeds CA path length"):
                MODULE.build_and_validate_certificate_path(leaf, anchor, (parent1, parent2), "role", now)

    def test_pinned_anchor_malformed_and_fingerprint_encoding_errors(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "anchors.json"
            path.write_text(json.dumps({"trust_anchors": [{"name": "root", "certificate_der_b64": base64.b64encode(b"bad").decode(), "sha256_der": "0" * 64}]}), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.AuthorizationError, "malformed"):
                MODULE.load_pinned_trust_anchor(path, "root")

        self.assertFalse(MODULE.hmac_compare("not-ascii-\\u2603", "abc"))

    def test_ocsp_no_identity_and_untrusted_responder(self) -> None:
        issuer = self._mock_cert(subject="issuer")
        result = Mock(responder_name=None, responder_key_hash=None, certificates=())
        with self.assertRaisesRegex(MODULE.AuthorizationError, "no responder identity"):
            MODULE.verify_ocsp_response_signature(result, issuer, "role", datetime.now(timezone.utc))

        result.responder_name = "unknown"
        with self.assertRaisesRegex(MODULE.AuthorizationError, "identity is not trusted"):
            MODULE.verify_ocsp_response_signature(result, issuer, "role", datetime.now(timezone.utc))

    def test_check_ocsp_serial_and_trust_anchor_failures(self) -> None:
        key, issuer, leaf = RoleAuthorizationTests()._certificates()
        now = datetime.now(timezone.utc)
        candidate = {
            "certificate_der_b64": base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode(),
            "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(),
            "ocsp_url": "https://ocsp.test",
        }
        result = Mock(
            response_status=ocsp.OCSPResponseStatus.SUCCESSFUL,
            certificate_status=ocsp.OCSPCertStatus.GOOD,
            serial_number=leaf.serial_number + 1,
        )
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(b"response")), patch.object(MODULE.ocsp, "load_der_ocsp_response", return_value=result):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "does not match"):
                MODULE.check_ocsp(candidate, "role", now)

        result.serial_number = leaf.serial_number
        candidate["trust_anchor_der_b64"] = base64.b64encode(b"bad-anchor").decode()
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(b"response")), patch.object(MODULE.ocsp, "load_der_ocsp_response", return_value=result):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "trust anchor certificate is malformed"):
                MODULE.check_ocsp(candidate, "role", now)

    def test_check_ocsp_expired_next_update(self) -> None:
        key, issuer, leaf = RoleAuthorizationTests()._certificates()
        now = datetime.now(timezone.utc)
        response = (
            ocsp.OCSPResponseBuilder().add_response(
                cert=leaf, issuer=issuer, algorithm=hashes.SHA256(),
                cert_status=ocsp.OCSPCertStatus.GOOD,
                this_update=now - timedelta(seconds=1),
                next_update=now - timedelta(seconds=1),
                revocation_time=None, revocation_reason=None,
            ).responder_id(ocsp.OCSPResponderEncoding.NAME, issuer).sign(key, None)
        )
        candidate = {
            "certificate_der_b64": base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode(),
            "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(),
            "ocsp_url": "https://ocsp.test",
        }
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(response.public_bytes(serialization.Encoding.DER))):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "OCSP response is stale"):
                MODULE.check_ocsp(candidate, "role", now)


class RemainingFailClosedArcTests(unittest.TestCase):
    def _certs(self):
        fixture = RoleAuthorizationTests()
        fixture.setUp()
        return fixture._certificates()

    def _fixture(self):
        fixture = RoleAuthorizationTests()
        fixture.setUp()
        return fixture

    def test_responder_crl_window_and_revoked_serial(self) -> None:
        now = datetime.now(timezone.utc)
        cert = Mock(serial_number=7)
        expired = Mock(next_update_utc=now - timedelta(seconds=1), last_update_utc=now - timedelta(minutes=1))
        with self.assertRaisesRegex(MODULE.AuthorizationError, "outside its validity window"):
            MODULE.check_certificate_against_crl(cert, expired, "role", now)
        future = Mock(next_update_utc=now + timedelta(hours=1), last_update_utc=now + timedelta(seconds=1))
        with self.assertRaisesRegex(MODULE.AuthorizationError, "outside its validity window"):
            MODULE.check_certificate_against_crl(cert, future, "role", now)
        revoked = Mock(next_update_utc=now + timedelta(hours=1), last_update_utc=now - timedelta(minutes=1))
        revoked.__iter__ = Mock(return_value=iter([Mock(serial_number=7)]))
        with self.assertRaisesRegex(MODULE.AuthorizationError, "revoked by CRL"):
            MODULE.check_certificate_against_crl(cert, revoked, "role", now)

    def test_delegated_responder_missing_and_wrong_eku(self) -> None:
        issuer = Mock(subject="issuer")
        result = Mock(responder_name="delegated", responder_key_hash=None, certificates=())
        signer = Mock(subject="delegated", issuer="issuer")
        with patch.object(MODULE, "responder_matches", side_effect=lambda r, c: c is signer), patch.object(MODULE, "build_and_validate_certificate_path", return_value=(signer, issuer)), patch.object(MODULE, "ensure_certificate_current"), patch.object(MODULE, "verify_public_key_signature"), patch.object(MODULE, "load_validated_crl", return_value=Mock()):
            signer.extensions.get_extension_for_class.side_effect = x509.ExtensionNotFound("missing", x509.ObjectIdentifier("2.5.29.37"))
            result.certificates = (signer,)
            with self.assertRaisesRegex(MODULE.AuthorizationError, "lacks id-kp-OCSPSigning"):
                MODULE.verify_ocsp_response_signature(result, issuer, "role", datetime.now(timezone.utc), {"responder_crl_pem_b64": "eA==", "responder_crl_issuer_certificate_der_b64": "eA=="})
            signer.extensions.get_extension_for_class.return_value.value = [x509.oid.ExtendedKeyUsageOID.CLIENT_AUTH]
            with self.assertRaisesRegex(MODULE.AuthorizationError, "lacks id-kp-OCSPSigning"):
                MODULE.verify_ocsp_response_signature(result, issuer, "role", datetime.now(timezone.utc), {"responder_crl_pem_b64": "eA==", "responder_crl_issuer_certificate_der_b64": "eA=="})

    def test_ocsp_missing_and_expired_timestamps(self) -> None:
        key, issuer, leaf = self._certs()
        now = datetime.now(timezone.utc)
        candidate = {
            "certificate_der_b64": base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode(),
            "issuer_certificate_der_b64": base64.b64encode(issuer.public_bytes(serialization.Encoding.DER)).decode(),
            "ocsp_url": "https://ocsp.test",
        }
        for produced, next_update in ((None, now + timedelta(hours=1)), (now - timedelta(seconds=1), now - timedelta(seconds=1))):
            result = Mock(response_status=ocsp.OCSPResponseStatus.SUCCESSFUL, certificate_status=ocsp.OCSPCertStatus.GOOD, serial_number=leaf.serial_number, this_update_utc=produced, next_update_utc=next_update)
            with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(b"response")), patch.object(MODULE.ocsp, "load_der_ocsp_response", return_value=result), patch.object(MODULE, "verify_ocsp_response_signature"):
                expected = "no this_update" if produced is None else "OCSP response is stale"
                with self.assertRaisesRegex(MODULE.AuthorizationError, expected):
                    MODULE.check_ocsp(candidate, "role", now)

    def test_verify_malformed_directory_and_partial_anchor_options(self) -> None:
        fixture = self._fixture()
        fixture._write(fixture.directory, {"roles": []})
        with self.assertRaisesRegex(MODULE.AuthorizationError, "roles object"):
            MODULE.verify(fixture.manifest, fixture.sig_dir, fixture.directory)
        fixture._write(fixture.directory, {"roles": {role: [{}] for role in MODULE.ROLES}})
        with self.assertRaisesRegex(MODULE.AuthorizationError, "supplied together"):
            MODULE.verify(fixture.manifest, fixture.sig_dir, fixture.directory, trust_anchor_config=fixture.directory)

    def test_verify_production_prerequisites_and_cli_entry(self) -> None:
        fixture = self._fixture()
        data = json.loads(fixture.directory.read_text())
        data["roles"]["release_manager"][0]["certificate_serial"] = None
        fixture._write(fixture.directory, data)
        with patch.object(MODULE, "check_crl", return_value=set()):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "certificate_serial"):
                MODULE.verify(fixture.manifest, fixture.sig_dir, fixture.directory, require_revocation_evidence=True)
        data["roles"]["release_manager"][0]["certificate_serial"] = "123"
        fixture._write(fixture.directory, data)
        with patch.object(MODULE, "check_crl", return_value=set()):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "OCSP evidence"):
                MODULE.verify(fixture.manifest, fixture.sig_dir, fixture.directory, require_revocation_evidence=True)
        with patch.object(MODULE, "verify"):
            with patch.object(MODULE.sys, "argv", ["verify_role_sidecar_authorization.py", "--manifest", str(fixture.manifest), "--signatures-dir", str(fixture.sig_dir), "--authorized-directory", str(fixture.directory)]):
                self.assertEqual(MODULE.main(), 0)


class Final98CoverageTests(unittest.TestCase):
    def _fixture(self):
        fixture = RoleAuthorizationTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        return fixture

    def test_missing_intermediate_basic_constraints_is_fail_closed(self) -> None:
        now = datetime.now(timezone.utc)
        leaf = Mock(subject="leaf", issuer="intermediate", public_bytes=Mock(return_value=b"leaf"))
        intermediate = Mock(subject="intermediate", issuer="root", public_bytes=Mock(return_value=b"intermediate"))
        root = Mock(subject="root", issuer="root", public_bytes=Mock(return_value=b"root"))
        leaf.extensions.get_extension_for_class.return_value = Mock(value=Mock(path_length=None))
        intermediate.extensions.get_extension_for_class.side_effect = x509.ExtensionNotFound("missing", x509.ObjectIdentifier("2.5.29.19"))
        with patch.object(MODULE, "ensure_certificate_current"), patch.object(MODULE, "verify_certificate_signed_by_path"), patch.object(MODULE, "certificate_is_ca", return_value=(True, None)):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "lacks BasicConstraints"):
                MODULE.build_and_validate_certificate_path(leaf, root, (intermediate,), "role", now)

    def test_delegated_responder_wrong_ocsp_signing_eku(self) -> None:
        now = datetime.now(timezone.utc)
        issuer = Mock(subject="issuer")
        signer = Mock(subject="signer", issuer="issuer")
        result = Mock(responder_name="signer", responder_key_hash=None, certificates=(signer,))
        signer.extensions.get_extension_for_class.return_value = Mock(value=[x509.oid.ExtendedKeyUsageOID.CLIENT_AUTH])
        with patch.object(MODULE, "responder_matches", side_effect=lambda _r, c: c is signer), patch.object(MODULE, "load_validated_crl", return_value=Mock()), patch.object(MODULE, "build_and_validate_certificate_path", return_value=(signer, issuer)), patch.object(MODULE, "ensure_certificate_current"), patch.object(MODULE, "verify_public_key_signature"):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "lacks id-kp-OCSPSigning"):
                MODULE.verify_ocsp_response_signature(result, issuer, "role", now, {"responder_crl_pem_b64": "eA==", "responder_crl_issuer_certificate_der_b64": "eA=="})

    def test_delegated_responder_revoked_crl_is_fail_closed(self) -> None:
        now = datetime.now(timezone.utc)
        issuer = Mock(subject="issuer")
        signer = Mock(subject="signer", issuer="issuer", serial_number=55)
        signer.extensions.get_extension_for_class.return_value = Mock(value=[x509.oid.ExtendedKeyUsageOID.OCSP_SIGNING])
        result = Mock(responder_name="signer", responder_key_hash=None, certificates=(signer,))
        with patch.object(MODULE, "responder_matches", side_effect=lambda _r, c: c is signer), patch.object(MODULE, "load_validated_crl", return_value=Mock()), patch.object(MODULE, "build_and_validate_certificate_path", return_value=(signer, issuer)), patch.object(MODULE, "ensure_certificate_current"), patch.object(MODULE, "verify_public_key_signature"), patch.object(MODULE, "check_certificate_against_crl", side_effect=MODULE.AuthorizationError("role delegated OCSP responder certificate is revoked by CRL")):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "revoked by CRL"):
                MODULE.verify_ocsp_response_signature(result, issuer, "role", now, {"responder_crl_pem_b64": "eA==", "responder_crl_issuer_certificate_der_b64": "eA=="})

    def test_verify_pinned_anchor_pair_injects_anchor_and_calls_production_ocsp(self) -> None:
        fixture = self._fixture()
        anchor = Mock()
        anchor.public_bytes.return_value = b"anchor-der"
        with patch.object(MODULE, "load_pinned_trust_anchor", return_value=anchor), patch.object(MODULE, "check_ocsp") as check_ocsp:
            data = json.loads(fixture.directory.read_text())
            for role in MODULE.ROLES:
                data["roles"][role][0]["certificate_serial"] = str(100 + len(role))
                data["roles"][role][0]["ocsp_url"] = "https://ocsp.test"
            fixture._write(fixture.directory, data)
            with patch.object(MODULE, "check_crl", return_value=set()):
                MODULE.verify(fixture.manifest, fixture.sig_dir, fixture.directory, require_revocation_evidence=True, trust_anchor_config=fixture.directory, trust_anchor_name="root")
            self.assertEqual(check_ocsp.call_count, 4)
            for call in check_ocsp.call_args_list:
                self.assertEqual(call.args[0]["trust_anchor_der_b64"], base64.b64encode(b"anchor-der").decode("ascii"))

    def test_module_entry_point_executes_main(self) -> None:
        fixture = self._fixture()
        script = str(MODULE_PATH)
        command = [sys.executable, script, "--manifest", str(fixture.manifest), "--signatures-dir", str(fixture.sig_dir), "--authorized-directory", str(fixture.directory)]
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("role authorization: PASSED", completed.stdout)


class Final100CoverageTests(unittest.TestCase):
    def _fixture(self):
        fixture = RoleAuthorizationTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        return fixture

    def test_certificate_not_yet_valid_and_issuer_mismatch(self) -> None:
        now = datetime.now(timezone.utc)
        cert = Mock()
        with patch.object(MODULE, "certificate_time", return_value=(now + timedelta(minutes=1), now + timedelta(hours=1))):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "not yet valid"):
                MODULE.ensure_certificate_current(cert, "role", now)
        certificate = Mock(issuer="wrong")
        signer = Mock(subject="expected")
        with self.assertRaisesRegex(MODULE.AuthorizationError, "issuer does not match"):
            MODULE.verify_certificate_signed_by_path(certificate, signer, "role path")

    def test_pinned_anchor_success_and_non_ascii_digest_compare(self) -> None:
        raw = b"valid-anchor-der"
        anchor = Mock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "anchors.json"
            path.write_text(json.dumps({"trust_anchors": [{"name": "root", "certificate_der_b64": base64.b64encode(raw).decode(), "sha256_der": hashlib.sha256(raw).hexdigest()}]}), encoding="utf-8")
            with patch.object(MODULE.x509, "load_der_x509_certificate", return_value=anchor), patch.object(MODULE, "certificate_is_ca"):
                self.assertIs(MODULE.load_pinned_trust_anchor(path, "root"), anchor)
        self.assertFalse(MODULE.hmac_compare("\\N{SNOWMAN}", "abc"))

    def test_non_leaf_trust_anchor_transition_returns_path(self) -> None:
        now = datetime.now(timezone.utc)
        leaf = Mock(subject="leaf", issuer="root", public_bytes=Mock(return_value=b"leaf"))
        intermediate = Mock(subject="root", issuer="root", public_bytes=Mock(return_value=b"root"))
        anchor = Mock(subject="root", issuer="root", public_bytes=Mock(return_value=b"root"))
        with patch.object(MODULE, "ensure_certificate_current"), patch.object(MODULE, "verify_certificate_signed_by_path"), patch.object(MODULE, "certificate_is_ca"):
            self.assertEqual(MODULE.build_and_validate_certificate_path(leaf, anchor, (intermediate,), "role", now), (leaf, anchor))

    def test_revoked_crl_generator_true_exit(self) -> None:
        now = datetime.now(timezone.utc)
        cert = Mock(serial_number=7)
        crl = Mock(next_update_utc=now + timedelta(hours=1), last_update_utc=now - timedelta(minutes=1))
        crl.__iter__ = Mock(return_value=iter([Mock(serial_number=7)]))
        with self.assertRaisesRegex(MODULE.AuthorizationError, "revoked by CRL"):
            MODULE.check_certificate_against_crl(cert, crl, "role", now)

    def test_in_process_main_entry_point(self) -> None:
        fixture = self._fixture()
        argv = ["verify_role_sidecar_authorization.py", "--manifest", str(fixture.manifest), "--signatures-dir", str(fixture.sig_dir), "--authorized-directory", str(fixture.directory)]
        with patch.object(sys, "argv", argv):
            with self.assertRaises(SystemExit) as raised:
                runpy.run_path(str(MODULE_PATH), run_name="__main__")
        self.assertEqual(raised.exception.code, 0)


class FinalRemainingArcTests(unittest.TestCase):
    def test_issuer_mismatch_and_unicode_compare(self) -> None:
        certificate = Mock(issuer="wrong")
        issuer = Mock(subject="right")
        with self.assertRaisesRegex(MODULE.AuthorizationError, "issuer does not match"):
            MODULE.verify_certificate_signed_by(certificate, issuer, "role", datetime.now(timezone.utc))
        self.assertFalse(MODULE.hmac_compare("\N{SNOWMAN}", "abc"))

    def test_missing_intermediate_basic_constraints_direct_path(self) -> None:
        now = datetime.now(timezone.utc)
        leaf = Mock(subject="leaf", issuer="intermediate", public_bytes=Mock(return_value=b"leaf"))
        intermediate = Mock(subject="intermediate", issuer="root", public_bytes=Mock(return_value=b"intermediate"))
        root = Mock(subject="root", issuer="root", public_bytes=Mock(return_value=b"root"))
        intermediate.extensions.get_extension_for_class.side_effect = x509.ExtensionNotFound("missing", x509.ObjectIdentifier("2.5.29.19"))
        with patch.object(MODULE, "ensure_certificate_current"), patch.object(MODULE, "verify_certificate_signed_by_path"), patch.object(MODULE, "certificate_is_ca", side_effect=MODULE.AuthorizationError("role OCSP intermediate lacks BasicConstraints")):
            with self.assertRaisesRegex(MODULE.AuthorizationError, "lacks BasicConstraints"):
                MODULE.build_and_validate_certificate_path(leaf, root, (intermediate,), "role", now)

    def test_crl_generator_exit_arc_with_nonmatching_serial(self) -> None:
        now = datetime.now(timezone.utc)
        cert = Mock(serial_number=7)
        crl = Mock(next_update_utc=now + timedelta(hours=1), last_update_utc=now - timedelta(minutes=1))
        crl.__iter__ = Mock(return_value=iter([Mock(serial_number=8)]))
        MODULE.check_certificate_against_crl(cert, crl, "role", now)


class LoopArcCoverageTests(unittest.TestCase):
    def test_two_intermediate_chain_returns_to_loop_header(self) -> None:
        now = datetime.now(timezone.utc)
        leaf = Mock(subject="leaf", issuer="intermediate-1", public_bytes=Mock(return_value=b"leaf"))
        intermediate1 = Mock(subject="intermediate-1", issuer="intermediate-2", public_bytes=Mock(return_value=b"intermediate-1"))
        intermediate2 = Mock(subject="intermediate-2", issuer="root", public_bytes=Mock(return_value=b"intermediate-2"))
        anchor = Mock(subject="root", issuer="root", public_bytes=Mock(return_value=b"root"))
        for cert in (leaf, intermediate1, intermediate2):
            cert.extensions.get_extension_for_class.return_value = Mock(value=Mock(path_length=None))
        with patch.object(MODULE, "ensure_certificate_current"), patch.object(MODULE, "verify_certificate_signed_by_path"), patch.object(MODULE, "certificate_is_ca", return_value=(True, None)):
            result = MODULE.build_and_validate_certificate_path(leaf, anchor, (intermediate1, intermediate2), "role", now)
        self.assertEqual(result, (leaf, intermediate1, intermediate2, anchor))
