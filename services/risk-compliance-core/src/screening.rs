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
