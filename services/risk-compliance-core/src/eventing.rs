//! Event contracts and publishers for the Rust risk core.
//!
//! The publisher is intentionally a narrow Dapr pub/sub adapter. It carries a
//! policy decision as evidence for downstream analysis; it cannot carry a
//! provider credential, request a transfer, or turn a policy result into an
//! execution instruction. The policy event itself pins
//! `external_execution_authorized` to false and its test proves that guard.

use crate::{Decision, PolicyResult};
use fluvio::{
    config::{FluvioClusterConfig, TlsPolicy},
    Fluvio, RecordKey,
};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::time::Duration;

pub const POLICY_DECISION_EVENT_V1: &str = "umojaflowos.policy.decision.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyDecisionEvent {
    pub event_id: String,
    pub correlation_id: String,
    pub event_type: String,
    pub schema_version: String,
    pub decision: String,
    pub reason_codes: Vec<String>,
    pub external_execution_authorized: bool,
}

pub fn policy_event(
    event_id: String,
    correlation_id: String,
    result: PolicyResult,
) -> Result<PolicyDecisionEvent, &'static str> {
    if event_id.trim().is_empty() || correlation_id.trim().is_empty() {
        return Err("event identity is required");
    }
    let decision = match result.decision {
        Decision::Allow => "ALLOW",
        Decision::ManualReview => "MANUAL_REVIEW",
        Decision::Block => "BLOCK",
    };
    Ok(PolicyDecisionEvent {
        event_id,
        correlation_id,
        event_type: POLICY_DECISION_EVENT_V1.into(),
        schema_version: "v1".into(),
        decision: decision.into(),
        reason_codes: result.reason_codes,
        external_execution_authorized: false,
    })
}

/// Deployment configuration for Dapr's HTTP pub/sub API.
///
/// A Dapr sidecar normally speaks plaintext HTTP on loopback; production
/// routing is a separate mesh/sidecar trust boundary. This code nevertheless
/// refuses plaintext to every non-loopback address, and it refuses a URL with
/// embedded credentials. That makes the local exception narrow rather than a
/// silent bypass for a remote endpoint.
#[derive(Debug, Clone)]
pub struct DaprConfig {
    pub base_url: String,
    pub pubsub_name: String,
    pub timeout: Duration,
    pub allow_insecure_loopback: bool,
}

fn loopback_host(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn safe_path_segment(value: &str) -> bool {
    !value.trim().is_empty()
        && !value.contains('/')
        && !value.contains('?')
        && !value.contains('#')
        && !value.contains("..")
}

/// Publisher that calls Dapr's documented `v1.0/publish` HTTP endpoint.
#[derive(Clone)]
pub struct DaprPublisher {
    base_url: Url,
    pubsub_name: String,
    client: Client,
}

impl DaprPublisher {
    pub fn new(config: DaprConfig) -> Result<Self, String> {
        if !safe_path_segment(&config.pubsub_name) {
            return Err("Dapr pubsub name must be a single non-empty path segment".to_string());
        }
        let base_url = Url::parse(&config.base_url)
            .map_err(|error| format!("Dapr base URL is invalid: {error}"))?;
        if base_url.username() != "" || base_url.password().is_some() {
            return Err("Dapr base URL must not embed credentials".to_string());
        }
        match base_url.scheme() {
            "https" => {}
            "http"
                if config.allow_insecure_loopback
                    && base_url.host_str().is_some_and(loopback_host) => {}
            "http" if !config.allow_insecure_loopback => {
                return Err(
                    "Dapr plaintext transport requires the explicit loopback exemption".to_string(),
                )
            }
            "http" => {
                return Err("Dapr plaintext transport is permitted on loopback only".to_string())
            }
            scheme => return Err(format!("unsupported Dapr URL scheme {scheme:?}")),
        }

        let timeout = if config.timeout.is_zero() {
            Duration::from_secs(5)
        } else {
            config.timeout
        };
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|error| format!("Dapr HTTP client could not be created: {error}"))?;

        Ok(Self {
            base_url,
            pubsub_name: config.pubsub_name,
            client,
        })
    }

    /// Publish one policy event. Non-2xx, unreachable, timeout and malformed
    /// endpoint cases are all errors; the caller must decide whether to fail its
    /// operation closed rather than silently losing the event.
    pub async fn publish_policy_event(
        &self,
        topic: &str,
        event: &PolicyDecisionEvent,
    ) -> Result<(), String> {
        if !safe_path_segment(topic) {
            return Err("Dapr event topic must be a single non-empty path segment".to_string());
        }
        if event.event_id.trim().is_empty()
            || event.correlation_id.trim().is_empty()
            || event.event_type != POLICY_DECISION_EVENT_V1
            || event.schema_version != "v1"
            || event.external_execution_authorized
        {
            return Err("policy event violates the immutable v1 event contract".to_string());
        }
        let endpoint = self
            .base_url
            .join(&format!("v1.0/publish/{}/{topic}", self.pubsub_name))
            .map_err(|error| format!("Dapr publish endpoint could not be built: {error}"))?;
        let response = self
            .client
            .post(endpoint)
            .json(event)
            .send()
            .await
            .map_err(|error| format!("Dapr publish failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Dapr publish returned status {}",
                response.status()
            ));
        }
        Ok(())
    }
}

/// Configuration for the native Fluvio mirror.
///
/// Fluvio carries evidence-only policy decisions into a separate, compact
/// compliance stream. It is not the payment-execution transport: even an
/// ALLOW decision remains evidence for a separately authorised workflow. The
/// profile points to an operator-managed Fluvio configuration file, keeping
/// endpoints and certificates out of application source.
#[derive(Debug, Clone)]
pub struct FluvioPublisherConfig {
    pub profile: String,
    pub topic: String,
    pub tls_required: bool,
    pub allow_insecure_loopback: bool,
}

fn fluvio_endpoint_is_loopback(endpoint: &str) -> bool {
    // Local Fluvio profiles are host:port. Do not resolve arbitrary DNS names:
    // a name that looks local but resolves elsewhere is not enough to make
    // plaintext acceptable.
    let host = endpoint
        .strip_prefix('[')
        .and_then(|value| value.split_once(']').map(|(host, _)| host))
        .or_else(|| endpoint.rsplit_once(':').map(|(host, _)| host))
        .unwrap_or(endpoint);
    loopback_host(host)
}

/// Publishes an immutable policy event to one configured Fluvio topic.
#[derive(Debug, Clone)]
pub struct FluvioPublisher {
    config: FluvioPublisherConfig,
}

impl FluvioPublisher {
    pub fn new(config: FluvioPublisherConfig) -> Result<Self, String> {
        if config.profile.trim().is_empty() {
            return Err("Fluvio profile is required".to_string());
        }
        if !safe_path_segment(&config.topic) {
            return Err("Fluvio topic must be a single non-empty path segment".to_string());
        }
        Ok(Self { config })
    }

    fn validated_cluster_config(&self) -> Result<FluvioClusterConfig, String> {
        let cluster = FluvioClusterConfig::load_with_profile(&self.config.profile)
            .map_err(|error| format!("Fluvio profile could not be loaded: {error}"))?
            .ok_or_else(|| format!("Fluvio profile {:?} does not exist", self.config.profile))?;
        match cluster.tls {
            TlsPolicy::Verified(_) => Ok(cluster),
            TlsPolicy::Anonymous => {
                Err("Fluvio TLS must verify certificates and domains".to_string())
            }
            TlsPolicy::Disabled
                if !self.config.tls_required
                    && self.config.allow_insecure_loopback
                    && fluvio_endpoint_is_loopback(&cluster.endpoint) =>
            {
                Ok(cluster)
            }
            TlsPolicy::Disabled if self.config.tls_required => {
                Err("Fluvio TLS is required but the selected profile disables TLS".to_string())
            }
            TlsPolicy::Disabled if !self.config.allow_insecure_loopback => Err(
                "Fluvio plaintext transport requires the explicit loopback exemption".to_string(),
            ),
            TlsPolicy::Disabled => Err(format!(
                "Fluvio plaintext transport is permitted on loopback only, got {:?}",
                cluster.endpoint
            )),
        }
    }

    /// Connects using the selected profile, sends the full immutable event, and
    /// flushes before returning. A completed future therefore means the local
    /// Fluvio producer has accepted the evidence; any connection, metadata,
    /// produce, or flush error remains a failure for the caller to handle.
    pub async fn publish_policy_event(&self, event: &PolicyDecisionEvent) -> Result<(), String> {
        if event.event_id.trim().is_empty()
            || event.correlation_id.trim().is_empty()
            || event.event_type != POLICY_DECISION_EVENT_V1
            || event.schema_version != "v1"
            || event.external_execution_authorized
        {
            return Err("policy event violates the immutable v1 event contract".to_string());
        }
        let cluster = self.validated_cluster_config()?;
        let client = Fluvio::connect_with_config(&cluster)
            .await
            .map_err(|error| format!("Fluvio connection failed: {error}"))?;
        let producer = client
            .topic_producer(&self.config.topic)
            .await
            .map_err(|error| format!("Fluvio producer could not be opened: {error}"))?;
        let encoded = serde_json::to_string(event)
            .map_err(|error| format!("policy event could not be encoded: {error}"))?;
        producer
            .send(RecordKey::NULL, encoded)
            .await
            .map_err(|error| format!("Fluvio publish failed: {error}"))?;
        producer
            .flush()
            .await
            .map_err(|error| format!("Fluvio producer flush failed: {error}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Decision, PolicyResult};
    use std::env;

    fn event() -> PolicyDecisionEvent {
        policy_event(
            "event-1".to_string(),
            "order-1".to_string(),
            PolicyResult {
                decision: Decision::ManualReview,
                reason_codes: vec!["SANCTIONS_POTENTIAL_MATCH".to_string()],
            },
        )
        .expect("build a valid policy event")
    }

    #[test]
    fn policy_events_are_evidence_not_execution_authority() {
        let event = event();
        assert!(!event.external_execution_authorized);
        assert_eq!(event.event_type, POLICY_DECISION_EVENT_V1);
        assert_eq!(event.schema_version, "v1");
    }

    #[test]
    fn publisher_refuses_remote_or_credentialed_plaintext() {
        for base_url in [
            "http://dapr.example.com:3500",
            "http://token@example.com:3500",
            "ftp://127.0.0.1:3500",
        ] {
            let result = DaprPublisher::new(DaprConfig {
                base_url: base_url.to_string(),
                pubsub_name: "kafka".to_string(),
                timeout: Duration::from_secs(1),
                allow_insecure_loopback: true,
            });
            assert!(result.is_err(), "{base_url} must be refused");
        }
        let no_exemption = DaprPublisher::new(DaprConfig {
            base_url: "http://127.0.0.1:3500".to_string(),
            pubsub_name: "kafka".to_string(),
            timeout: Duration::from_secs(1),
            allow_insecure_loopback: false,
        });
        assert!(no_exemption.is_err());
    }

    #[tokio::test]
    async fn unreachable_and_malformed_publish_attempts_fail_closed() {
        let publisher = DaprPublisher::new(DaprConfig {
            base_url: "http://127.0.0.1:1".to_string(),
            pubsub_name: "kafka".to_string(),
            timeout: Duration::from_millis(50),
            allow_insecure_loopback: true,
        })
        .expect("local configuration is valid even if nothing listens");
        let error = publisher
            .publish_policy_event("compliance.events", &event())
            .await
            .expect_err("unreachable Dapr must fail closed");
        assert!(error.contains("Dapr publish failed"));

        let invalid_topic = publisher
            .publish_policy_event("compliance/events", &event())
            .await
            .expect_err("path-shaped topics must be refused before a request");
        assert!(invalid_topic.contains("single non-empty path segment"));

        let mut authority = event();
        authority.external_execution_authorized = true;
        let invalid_event = publisher
            .publish_policy_event("compliance.events", &authority)
            .await
            .expect_err("execution-shaped policy event must be refused");
        assert!(invalid_event.contains("immutable v1 event contract"));
    }

    #[test]
    fn fluvio_publisher_rejects_incomplete_configuration() {
        assert!(FluvioPublisher::new(FluvioPublisherConfig {
            profile: "".to_string(),
            topic: "compliance-events".to_string(),
            tls_required: true,
            allow_insecure_loopback: false,
        })
        .is_err());
        assert!(FluvioPublisher::new(FluvioPublisherConfig {
            profile: "local".to_string(),
            topic: "compliance/events".to_string(),
            tls_required: true,
            allow_insecure_loopback: false,
        })
        .is_err());
        let missing_profile = FluvioPublisher::new(FluvioPublisherConfig {
            profile: "this-profile-must-not-exist".to_string(),
            topic: "compliance-events".to_string(),
            tls_required: true,
            allow_insecure_loopback: false,
        })
        .expect("shape is valid")
        .validated_cluster_config();
        assert!(missing_profile.is_err());
    }

    #[tokio::test]
    async fn live_fluvio_publish_accepts_an_evidence_only_policy_event() {
        let profile = match env::var("FLUVIO_LIVE_PROFILE") {
            Ok(profile) => profile,
            Err(_) => {
                eprintln!("set FLUVIO_LIVE_PROFILE to run the live Fluvio regression");
                return;
            }
        };
        let publisher = FluvioPublisher::new(FluvioPublisherConfig {
            profile,
            topic: "compliance-events".to_string(),
            tls_required: false,
            allow_insecure_loopback: true,
        })
        .expect("local loopback profile configuration is valid");
        let unique = format!(
            "fluvio-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        );
        let policy = policy_event(
            format!("event-{unique}"),
            unique,
            PolicyResult {
                decision: Decision::ManualReview,
                reason_codes: vec!["SANCTIONS_POTENTIAL_MATCH".to_string()],
            },
        )
        .expect("build policy event");
        publisher
            .publish_policy_event(&policy)
            .await
            .expect("live Fluvio accepted and flushed the evidence event");
    }
}
