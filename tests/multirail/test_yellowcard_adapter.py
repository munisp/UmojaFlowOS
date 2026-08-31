import importlib.util
from pathlib import Path

_IMPL = Path(__file__).parents[2] / "services" / "risk-compliance-core" / "yellowcard_adapter.py"
_spec = importlib.util.spec_from_file_location("yellowcard_adapter", _IMPL)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)


def test_completed_status_never_allows_retry():
    result = _module.normalize_yellowcard_status("ref", "seq", "complete")
    assert result.status == _module.NormalizedStatus.SETTLED
    assert result.retryable_without_business_effect is False


def test_expired_status_is_the_only_safe_non_submission_family():
    result = _module.normalize_yellowcard_status("ref", "seq", "expired")
    assert result.status == _module.NormalizedStatus.FAILED
    assert result.retryable_without_business_effect is True


def test_generic_failure_is_unknown():
    result = _module.normalize_yellowcard_status("ref", "seq", "failed")
    assert result.status == _module.NormalizedStatus.UNKNOWN
    assert result.retryable_without_business_effect is False


def test_unrecognized_status_is_unknown():
    result = _module.normalize_yellowcard_status("ref", "seq", "provider_new_state")
    assert result.status == _module.NormalizedStatus.UNKNOWN
    assert result.retryable_without_business_effect is False
