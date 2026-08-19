// Package authorization enforces control-plane permissions through Permify.
//
// Why a dedicated authorization service rather than role checks in code.
//
// Role checks scattered across procedures answer "is this caller a compliance
// officer?". The question that actually matters is "may this caller approve
// THIS order?", which depends on the relationship between the subject and the
// specific resource. Permify models that relationship explicitly, so the
// authorization decision is reviewable as data rather than inferred by reading
// every call site.
//
// Two properties are non-negotiable here:
//
//  1. Deny by default. An unreachable Permify, a malformed response, a
//     timeout, or any result the client does not positively recognise as
//     ALLOWED is a denial. An authorization service that fails open is worse
//     than none, because it creates false confidence.
//
//  2. No authority beyond the control plane. This package decides who may act
//     inside UmojaFlowOS. It does not authorise a payment provider call, a
//     TigerBeetle transfer, sanctions screening, or a regulatory submission;
//     those remain separately gated.
package authorization

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Decision is the outcome of a permission check.
type Decision string

const (
	// Allowed is returned only when Permify positively allows the action.
	Allowed Decision = "ALLOWED"
	// Denied covers both an explicit denial and every failure mode.
	Denied Decision = "DENIED"
)

// Result carries the decision together with why it was reached, so a denial
// caused by an outage is distinguishable in logs from a denial by policy.
// Both are denials; only the remediation differs.
type Result struct {
	Decision Decision
	// Reason is always populated for a denial.
	Reason string
	// Indeterminate is true when the decision could not be obtained at all.
	// The caller must still treat it as a denial; this exists for alerting.
	Indeterminate bool
}

// Config describes how to reach Permify.
type Config struct {
	// BaseURL is the Permify HTTP endpoint.
	BaseURL string
	// TenantID scopes the schema and relationships.
	TenantID string
	// Timeout bounds a single check. A slow authorization service must not
	// become a slow application; it must become a denial.
	Timeout time.Duration
	// AllowInsecureLoopback permits plaintext to 127.0.0.1 only, for
	// development. Any other plaintext endpoint is refused outright.
	AllowInsecureLoopback bool
}

func (c Config) validate() error {
	if strings.TrimSpace(c.BaseURL) == "" {
		return errors.New("permify base url is required")
	}
	if strings.TrimSpace(c.TenantID) == "" {
		return errors.New("permify tenant id is required")
	}
	parsed, err := url.Parse(c.BaseURL)
	if err != nil {
		return fmt.Errorf("permify base url is not a valid url: %w", err)
	}
	if parsed.User != nil {
		return errors.New("permify base url must not embed credentials")
	}
	switch parsed.Scheme {
	case "https":
		return nil
	case "http":
		if !c.AllowInsecureLoopback {
			return errors.New("plaintext permify transport requires the loopback exemption")
		}
		host := parsed.Hostname()
		if host != "127.0.0.1" && host != "localhost" && host != "::1" {
			return fmt.Errorf("plaintext permify transport is permitted on loopback only, got %q", host)
		}
		return nil
	default:
		return fmt.Errorf("unsupported permify scheme %q", parsed.Scheme)
	}
}

// Client performs permission checks.
type Client struct {
	config Config
	http   *http.Client
}

// NewClient validates the configuration before returning a usable client, so a
// misconfiguration surfaces at construction rather than at the first check.
func NewClient(config Config) (*Client, error) {
	if err := config.validate(); err != nil {
		return nil, err
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &Client{config: config, http: &http.Client{Timeout: timeout}}, nil
}

// Request identifies the subject, the resource, and the action.
type Request struct {
	SubjectType string
	SubjectID   string
	EntityType  string
	EntityID    string
	Permission  string
}

func (r Request) validate() error {
	if strings.TrimSpace(r.SubjectID) == "" || strings.TrimSpace(r.EntityID) == "" || strings.TrimSpace(r.Permission) == "" {
		return errors.New("subject, entity, and permission are all required")
	}
	return nil
}

type checkPayload struct {
	Metadata struct {
		Depth int `json:"depth"`
	} `json:"metadata"`
	Entity struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	} `json:"entity"`
	Permission string `json:"permission"`
	Subject    struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	} `json:"subject"`
}

type checkResponse struct {
	Can string `json:"can"`
}

// Check asks Permify whether the subject holds the permission on the entity.
//
// Every path that is not an explicit ALLOWED returns Denied. That includes a
// non-2xx status, an unparseable body, a transport error, and a response whose
// `can` value the client does not recognise — a future Permify release adding
// a new result must not be silently treated as permission.
func (c *Client) Check(ctx context.Context, request Request) Result {
	if err := request.validate(); err != nil {
		return Result{Decision: Denied, Reason: err.Error()}
	}

	subjectType := request.SubjectType
	if subjectType == "" {
		subjectType = "user"
	}

	var payload checkPayload
	payload.Metadata.Depth = 20
	payload.Entity.Type = request.EntityType
	payload.Entity.ID = request.EntityID
	payload.Permission = request.Permission
	payload.Subject.Type = subjectType
	payload.Subject.ID = request.SubjectID

	body, err := json.Marshal(payload)
	if err != nil {
		return Result{Decision: Denied, Reason: "could not encode the authorization request", Indeterminate: true}
	}

	endpoint := fmt.Sprintf("%s/v1/tenants/%s/permissions/check",
		strings.TrimRight(c.config.BaseURL, "/"), url.PathEscape(c.config.TenantID))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Result{Decision: Denied, Reason: "could not build the authorization request", Indeterminate: true}
	}
	req.Header.Set("Content-Type", "application/json")

	response, err := c.http.Do(req)
	if err != nil {
		return Result{
			Decision:      Denied,
			Reason:        fmt.Sprintf("authorization service unreachable: %v", err),
			Indeterminate: true,
		}
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Result{
			Decision:      Denied,
			Reason:        fmt.Sprintf("authorization service returned status %d", response.StatusCode),
			Indeterminate: true,
		}
	}

	var decoded checkResponse
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return Result{
			Decision:      Denied,
			Reason:        "authorization response was not readable",
			Indeterminate: true,
		}
	}

	switch decoded.Can {
	case "CHECK_RESULT_ALLOWED":
		return Result{Decision: Allowed}
	case "CHECK_RESULT_DENIED":
		return Result{Decision: Denied, Reason: "the authorization policy does not grant this permission"}
	default:
		// An unrecognised result is not a grant.
		return Result{
			Decision:      Denied,
			Reason:        fmt.Sprintf("unrecognised authorization result %q", decoded.Can),
			Indeterminate: true,
		}
	}
}
