use crate::ScreeningState;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScreeningRequest {
    pub subject_reference: String,
    pub legal_name: String,
    pub country_code: String,
    pub scope: String,
    pub correlation_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScreeningResult {
    pub state: ScreeningState,
    pub provider_reference: String,
    pub source_version: String,
    pub evidence_sha256: String,
    pub screened_at: String,
}

#[derive(Clone)]
pub struct ScreeningGateway {
    endpoint: Url,
    api_key: String,
    client: Client,
}

fn required_non_blank(value: &str, field: &str, maximum: usize) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > maximum || !trimmed.is_char_boundary(trimmed.len()) {
        return Err(format!("screening {field} is required"));
    }
    Ok(())
}

fn has_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn permitted_endpoint(raw: &str, allow_loopback: bool) -> Result<Url, String> {
    let endpoint = Url::parse(raw.trim())
        .map_err(|_| "screening endpoint must be an absolute URL".to_string())?;
    if endpoint.username() != ""
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(
            "screening endpoint must not embed credentials, query parameters, or fragments"
                .to_string(),
        );
    }
    let host = endpoint.host_str().unwrap_or_default();
    let loopback = host == "127.0.0.1" || host == "localhost" || host == "::1";
    if endpoint.scheme() != "https" && !(endpoint.scheme() == "http" && allow_loopback && loopback)
    {
        return Err("screening endpoint must use HTTPS unless explicit loopback development transport is enabled".to_string());
    }
    Ok(endpoint)
}

fn resolve_file_secret(root: &Path, reference: &str) -> Result<String, String> {
    let path = reference
        .strip_prefix("file:///")
        .ok_or_else(|| "screening API key reference must be a file:/// path".to_string())?;
    let approved_root = root
        .canonicalize()
        .map_err(|_| "screening secret root is unavailable".to_string())?;
    let candidate = PathBuf::from("/")
        .join(path)
        .canonicalize()
        .map_err(|_| "screening secret reference is unavailable".to_string())?;
    if !candidate.starts_with(&approved_root) {
        return Err("screening secret reference escapes the approved root".to_string());
    }
    let value = fs::read_to_string(candidate)
        .map_err(|_| "screening secret material cannot be read".to_string())?;
    if value.len() < 12 {
        return Err("screening API key material is unavailable".to_string());
    }
    Ok(value)
}

impl ScreeningGateway {
    pub fn from_environment() -> Result<Option<Self>, String> {
        let enabled = env::var("UMOJA_SCREENING_ENABLED").unwrap_or_else(|_| "false".to_string());
        let enabled = enabled
            .parse::<bool>()
            .map_err(|_| "UMOJA_SCREENING_ENABLED must be true or false".to_string())?;
        if !enabled {
            return Ok(None);
        }
        let allow_loopback = env::var("UMOJA_SCREENING_ALLOW_INSECURE_LOOPBACK")
            .unwrap_or_else(|_| "false".to_string())
            .parse::<bool>()
            .map_err(|_| {
                "UMOJA_SCREENING_ALLOW_INSECURE_LOOPBACK must be true or false".to_string()
            })?;
        let endpoint = permitted_endpoint(
            &env::var("UMOJA_SCREENING_ENDPOINT").unwrap_or_default(),
            allow_loopback,
        )?;
        let root = env::var("UMOJA_SCREENING_MATERIAL_ROOT")
            .unwrap_or_else(|_| "/run/umoja-secrets".to_string());
        let api_key = resolve_file_secret(
            Path::new(&root),
            &env::var("UMOJA_SCREENING_API_KEY_SECRET_REFERENCE").unwrap_or_default(),
        )?;
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "screening HTTP client could not be configured".to_string())?;
        Ok(Some(Self {
            endpoint,
            api_key,
            client,
        }))
    }

    pub async fn screen(&self, request: ScreeningRequest) -> Result<ScreeningResult, String> {
        required_non_blank(&request.subject_reference, "subject reference", 255)?;
        required_non_blank(&request.legal_name, "legal name", 512)?;
        if request.country_code.trim().len() != 2 {
            return Err("screening country code must be ISO-3166 alpha-2".to_string());
        }
        required_non_blank(&request.scope, "scope", 128)?;
        required_non_blank(&request.correlation_id, "correlation id", 255)?;
        let response = self
            .client
            .post(self.endpoint.clone())
            .header("authorization", format!("Bearer {}", self.api_key))
            .header("x-umoja-correlation-id", request.correlation_id.clone())
            .json(&request)
            .send()
            .await
            .map_err(|_| "screening provider is unavailable".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "screening provider returned HTTP {}",
                response.status().as_u16()
            ));
        }
        let result: ScreeningResult = response
            .json()
            .await
            .map_err(|_| "screening provider returned an invalid response".to_string())?;
        required_non_blank(&result.provider_reference, "provider reference", 255)?;
        required_non_blank(&result.source_version, "source version", 128)?;
        required_non_blank(&result.screened_at, "screened-at timestamp", 64)?;
        if !has_sha256(&result.evidence_sha256) {
            return Err("screening provider response requires an evidence SHA-256".to_string());
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_requires_https_except_explicit_loopback() {
        assert!(permitted_endpoint("https://screening.example/v1/check", false).is_ok());
        assert!(permitted_endpoint("http://screening.example/v1/check", true).is_err());
        assert!(permitted_endpoint("http://127.0.0.1:8089/v1/check", true).is_ok());
    }

    #[test]
    fn result_requires_a_non_fabricated_evidence_hash() {
        assert!(has_sha256(&"a".repeat(64)));
        assert!(!has_sha256("not-a-digest"));
    }
}

#[cfg(test)]
mod additional_tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temporary_root() -> PathBuf {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = env::temp_dir().join(format!("umoja-screening-test-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn required_fields_reject_blank_and_oversized_values() {
        assert!(required_non_blank(" ", "name", 10).is_err());
        assert!(required_non_blank(&"a".repeat(11), "name", 10).is_err());
        assert!(required_non_blank("valid", "name", 10).is_ok());
    }

    #[test]
    fn endpoint_policy_rejects_malformed_credentials_queries_fragments_and_remote_http() {
        for endpoint in [
            "not-a-url",
            "https://user:pass@example.test/check",
            "https://example.test/check?debug=true",
            "https://example.test/check#fragment",
            "http://example.test/check",
            "http://localhost:8080/check",
        ] {
            assert!(permitted_endpoint(endpoint, false).is_err(), "accepted {endpoint}");
        }
        assert!(permitted_endpoint("http://localhost:8080/check", true).is_ok());
        assert!(permitted_endpoint("https://127.0.0.1:8080/check", false).is_ok());
    }

    #[test]
    fn file_secret_resolution_is_root_bound_and_length_checked() {
        let root = temporary_root();
        let secret = root.join("api-key");
        fs::write(&secret, "screening-secret-material").unwrap();
        assert_eq!(resolve_file_secret(&root, &format!("file:///{}", secret.strip_prefix("/").unwrap().display())).unwrap(), "screening-secret-material");
        assert!(resolve_file_secret(&root, "https://example/key").is_err());
        assert!(resolve_file_secret(&root, "file:///does/not/exist").is_err());
        let short = root.join("short");
        fs::write(&short, "short").unwrap();
        assert!(resolve_file_secret(&root, &format!("file:///{}", short.strip_prefix("/").unwrap().display())).is_err());
        let outside = root.parent().unwrap().join("outside-screening-secret");
        fs::write(&outside, "outside-secret-material").unwrap();
        assert!(resolve_file_secret(&root, &format!("file:///{}", outside.strip_prefix("/").unwrap().display())).is_err());
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn environment_constructor_fails_closed_before_external_calls() {
        let _guard = ENV_LOCK.lock().unwrap();
        let names = [
            "UMOJA_SCREENING_ENABLED",
            "UMOJA_SCREENING_ALLOW_INSECURE_LOOPBACK",
            "UMOJA_SCREENING_ENDPOINT",
            "UMOJA_SCREENING_MATERIAL_ROOT",
            "UMOJA_SCREENING_API_KEY_SECRET_REFERENCE",
        ];
        let saved: Vec<_> = names.iter().map(|name| (*name, env::var(name).ok())).collect();
        for name in names { env::remove_var(name); }
        assert!(ScreeningGateway::from_environment().unwrap().is_none());
        env::set_var("UMOJA_SCREENING_ENABLED", "not-bool");
        assert!(ScreeningGateway::from_environment().is_err());
        env::set_var("UMOJA_SCREENING_ENABLED", "true");
        env::set_var("UMOJA_SCREENING_ALLOW_INSECURE_LOOPBACK", "not-bool");
        assert!(ScreeningGateway::from_environment().is_err());
        env::set_var("UMOJA_SCREENING_ALLOW_INSECURE_LOOPBACK", "false");
        env::set_var("UMOJA_SCREENING_ENDPOINT", "http://remote.example/check");
        assert!(ScreeningGateway::from_environment().is_err());
        for (name, value) in saved { if let Some(value) = value { env::set_var(name, value); } else { env::remove_var(name); } }
    }
}
