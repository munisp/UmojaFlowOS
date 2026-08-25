package provider

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrWebhookReplay           = errors.New("provider webhook has already been accepted")
	ErrWebhookEvidenceConflict = errors.New("provider webhook event id conflicts with recorded evidence")
	ErrWebhookSourceNotAllowed = errors.New("provider webhook source is not allowed")
	ErrWebhookTimestampInvalid = errors.New("provider webhook timestamp is invalid")
	ErrWebhookTimestampExpired = errors.New("provider webhook timestamp is outside the accepted window")
	ErrWebhookConfiguration    = errors.New("provider webhook configuration is invalid")
	ErrWebhookDependency       = errors.New("provider webhook dependency is unavailable")
)

// SecretMaterial is a resolved secret with a non-sensitive version identifier.
// Version is a secret-manager object version or reference name, never a secret value.
type SecretMaterial struct {
	Version string
	Value   []byte
}

// SecretResolver resolves a deployment reference only inside the trusted runtime.
// Implementations must never log or serialize SecretMaterial.Value.
type SecretResolver interface {
	Resolve(context.Context, string) (SecretMaterial, error)
}

// FileSecretResolver supports secret-manager sidecar or CSI injection. References
// must use file:///absolute/path and resolve beneath Root after symlink evaluation.
type FileSecretResolver struct {
	Root string
}

func (r FileSecretResolver) Resolve(_ context.Context, reference string) (SecretMaterial, error) {
	root := r.Root
	if strings.TrimSpace(root) == "" {
		root = "/run/umoja-secrets"
	}
	rootResolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return SecretMaterial{}, fmt.Errorf("resolve secret root: %w", err)
	}
	rootResolved, err = filepath.Abs(rootResolved)
	if err != nil {
		return SecretMaterial{}, fmt.Errorf("normalize secret root: %w", err)
	}
	parsed, err := url.Parse(reference)
	if err != nil || parsed.Scheme != "file" || parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return SecretMaterial{}, errors.New("secret reference must be a file:/// path")
	}
	if !filepath.IsAbs(parsed.Path) {
		return SecretMaterial{}, errors.New("secret reference path must be absolute")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(parsed.Path))
	if err != nil {
		return SecretMaterial{}, fmt.Errorf("resolve secret reference: %w", err)
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return SecretMaterial{}, fmt.Errorf("normalize secret reference: %w", err)
	}
	relative, err := filepath.Rel(rootResolved, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return SecretMaterial{}, errors.New("secret reference escapes approved secret root")
	}
	value, err := os.ReadFile(resolved)
	if err != nil {
		return SecretMaterial{}, fmt.Errorf("read secret reference: %w", err)
	}
	if len(value) < 16 {
		return SecretMaterial{}, errors.New("resolved secret is too short")
	}
	// Sidecar-injected secret files are required to contain the exact secret bytes;
	// do not trim whitespace because it could change an HMAC key.
	return SecretMaterial{Version: reference, Value: value}, nil
}

// YellowCardWebhookConfig is the non-secret receiver contract. The edge proxy
// must overwrite SourceHeader from the actual peer address before forwarding.
type YellowCardWebhookConfig struct {
	SignatureHeader string
	TimestampHeader string
	SourceHeader    string
	MaxAge          time.Duration
	MaxBodyBytes    int64
	AllowedCIDRs    []netip.Prefix
	CurrentSecret   string
	PreviousSecret  string
}

func (c YellowCardWebhookConfig) Validate() error {
	if strings.TrimSpace(c.SignatureHeader) == "" || strings.TrimSpace(c.TimestampHeader) == "" || strings.TrimSpace(c.SourceHeader) == "" {
		return fmt.Errorf("%w: required headers are blank", ErrWebhookConfiguration)
	}
	if c.MaxAge <= 0 || c.MaxAge > 24*time.Hour {
		return fmt.Errorf("%w: timestamp window is invalid", ErrWebhookConfiguration)
	}
	if c.MaxBodyBytes < 1 || c.MaxBodyBytes > 1024*1024 {
		return fmt.Errorf("%w: body limit is invalid", ErrWebhookConfiguration)
	}
	if len(c.AllowedCIDRs) == 0 {
		return fmt.Errorf("%w: provider source CIDRs are required", ErrWebhookConfiguration)
	}
	if strings.TrimSpace(c.CurrentSecret) == "" {
		return fmt.Errorf("%w: current webhook secret reference is required", ErrWebhookConfiguration)
	}
	return nil
}

// ParseCIDRAllowlist parses only explicitly supplied prefixes. A blank entry and
// a catch-all prefix are rejected so a deployment cannot silently open the route.
func ParseCIDRAllowlist(value string) ([]netip.Prefix, error) {
	parts := strings.Split(value, ",")
	prefixes := make([]netip.Prefix, 0, len(parts))
	for _, raw := range parts {
		item := strings.TrimSpace(raw)
		if item == "" {
			return nil, errors.New("provider CIDR allowlist contains a blank entry")
		}
		prefix, err := netip.ParsePrefix(item)
		if err != nil || !prefix.IsValid() || prefix == netip.PrefixFrom(netip.IPv4Unspecified(), 0) || prefix == netip.PrefixFrom(netip.IPv6Unspecified(), 0) {
			return nil, errors.New("provider CIDR allowlist contains an invalid or catch-all prefix")
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	if len(prefixes) == 0 {
		return nil, errors.New("provider CIDR allowlist is empty")
	}
	return prefixes, nil
}

// ReplayStore atomically reserves a verified event digest until its TTL expires.
// Reserve returning false means a prior request already reserved the event.
type ReplayStore interface {
	Reserve(context.Context, string, time.Duration) (bool, error)
}

// InMemoryReplayStore is appropriate only for tests and single-process local
// development. Production must use the TLS Redis implementation below.
type InMemoryReplayStore struct {
	mu      sync.Mutex
	entries map[string]time.Time
	now     func() time.Time
}

func NewInMemoryReplayStore(now func() time.Time) *InMemoryReplayStore {
	if now == nil {
		now = time.Now
	}
	return &InMemoryReplayStore{entries: make(map[string]time.Time), now: now}
}

func (s *InMemoryReplayStore) Reserve(_ context.Context, key string, ttl time.Duration) (bool, error) {
	if s == nil || ttl <= 0 || strings.TrimSpace(key) == "" {
		return false, ErrWebhookDependency
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC()
	for existingKey, expiry := range s.entries {
		if !expiry.After(now) {
			delete(s.entries, existingKey)
		}
	}
	if expiry, exists := s.entries[key]; exists && expiry.After(now) {
		return false, nil
	}
	s.entries[key] = now.Add(ttl)
	return true, nil
}

// RedisReplayStore issues SET key value NX EX over a TLS-only Redis connection.
// It uses a new short-lived connection per request to avoid retaining credentials
// across forks or connection-pool state changes during a secret rotation.
type RedisReplayStore struct {
	Address   string
	Password  []byte
	KeyPrefix string
	TLSConfig *tls.Config
	Timeout   time.Duration
}

func (s *RedisReplayStore) Reserve(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	if s == nil || s.TLSConfig == nil || strings.TrimSpace(s.Address) == "" || strings.TrimSpace(key) == "" || ttl <= 0 {
		return false, ErrWebhookDependency
	}
	if _, _, err := net.SplitHostPort(s.Address); err != nil {
		return false, fmt.Errorf("invalid replay Redis address: %w", err)
	}
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	dialer := &net.Dialer{Timeout: timeout}
	connection, err := tls.DialWithDialer(dialer, "tcp", s.Address, s.TLSConfig.Clone())
	if err != nil {
		return false, fmt.Errorf("connect replay Redis: %w", err)
	}
	defer connection.Close()
	deadline := time.Now().Add(timeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := connection.SetDeadline(deadline); err != nil {
		return false, fmt.Errorf("set replay Redis deadline: %w", err)
	}
	reader := bufio.NewReader(connection)
	if len(s.Password) > 0 {
		if err := writeRESP(connection, "AUTH", string(s.Password)); err != nil {
			return false, err
		}
		if reply, err := readRESP(reader); err != nil || reply != "OK" {
			if err != nil {
				return false, err
			}
			return false, errors.New("replay Redis authentication failed")
		}
	}
	seconds := int64(ttl.Seconds())
	if seconds < 1 {
		seconds = 1
	}
	if err := writeRESP(connection, "SET", s.KeyPrefix+key, "1", "NX", "EX", strconv.FormatInt(seconds, 10)); err != nil {
		return false, err
	}
	reply, err := readRESP(reader)
	if err != nil {
		return false, err
	}
	switch reply {
	case "OK":
		return true, nil
	case "":
		return false, nil // Redis null bulk reply: key already exists.
	default:
		return false, errors.New("unexpected replay Redis response")
	}
}

func writeRESP(writer io.Writer, parts ...string) error {
	if _, err := fmt.Fprintf(writer, "*%d\r\n", len(parts)); err != nil {
		return err
	}
	for _, part := range parts {
		if _, err := fmt.Fprintf(writer, "$%d\r\n%s\r\n", len(part), part); err != nil {
			return err
		}
	}
	return nil
}

func readRESP(reader *bufio.Reader) (string, error) {
	prefix, err := reader.ReadByte()
	if err != nil {
		return "", err
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
	switch prefix {
	case '+':
		return line, nil
	case '-':
		return "", errors.New("replay Redis returned an error")
	case '$':
		length, err := strconv.Atoi(line)
		if err != nil {
			return "", err
		}
		if length == -1 {
			return "", nil
		}
		if length < 0 || length > 4096 {
			return "", errors.New("unexpected replay Redis bulk response length")
		}
		value := make([]byte, length+2)
		if _, err := io.ReadFull(reader, value); err != nil {
			return "", err
		}
		return string(value[:length]), nil
	default:
		return "", errors.New("unexpected replay Redis response type")
	}
}

// WebhookEvidence is immutable minimal evidence. It deliberately contains only
// a payload digest and no provider secret, raw HMAC, or settlement instruction.
type WebhookEvidence struct {
	Provider          string    `json:"provider"`
	EventID           string    `json:"event_id"`
	SequenceID        string    `json:"sequence_id"`
	Status            string    `json:"status"`
	Event             string    `json:"event"`
	ExecutedAt        time.Time `json:"executed_at"`
	ReceivedAt        time.Time `json:"received_at"`
	PayloadSHA256     string    `json:"payload_sha256"`
	SecretVersion     string    `json:"secret_version"`
	SourceAddress     string    `json:"source_address"`
	Reconciliation    string    `json:"reconciliation_state"`
	SettlementAllowed bool      `json:"settlement_allowed"`
}

type EvidenceStore interface {
	Record(context.Context, WebhookEvidence) (created bool, err error)
}

type ReconciliationQueue interface {
	Enqueue(context.Context, WebhookEvidence) (created bool, err error)
}

// FileEvidenceStore and FileReconciliationQueue are production-safe only when
// their directory is a durable, access-controlled mounted volume. They give the
// receiver an append-only durable boundary without granting settlement authority.
type FileEvidenceStore struct{ Directory string }
type FileReconciliationQueue struct{ Directory string }

func evidenceFilename(evidence WebhookEvidence) string {
	digest := sha256.Sum256([]byte(evidence.Provider + "\x00" + evidence.EventID + "\x00" + evidence.SequenceID))
	return hex.EncodeToString(digest[:]) + ".json"
}

func writeEvidenceFile(directory string, evidence WebhookEvidence) (bool, error) {
	if strings.TrimSpace(directory) == "" {
		return false, ErrWebhookDependency
	}
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return false, fmt.Errorf("create webhook evidence directory: %w", err)
	}
	body, err := json.Marshal(evidence)
	if err != nil {
		return false, fmt.Errorf("encode webhook evidence: %w", err)
	}
	path := filepath.Join(directory, evidenceFilename(evidence))
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err == nil {
		_, writeErr := file.Write(append(body, '\n'))
		syncErr := file.Sync()
		closeErr := file.Close()
		if writeErr != nil || syncErr != nil || closeErr != nil {
			_ = os.Remove(path)
			return false, errors.New("write webhook evidence")
		}
		return true, nil
	}
	if !errors.Is(err, os.ErrExist) {
		return false, fmt.Errorf("create webhook evidence: %w", err)
	}
	existing, readErr := os.ReadFile(path)
	if readErr != nil {
		return false, fmt.Errorf("read existing webhook evidence: %w", readErr)
	}
	var prior WebhookEvidence
	if json.Unmarshal(existing, &prior) != nil || prior.PayloadSHA256 != evidence.PayloadSHA256 || prior.EventID != evidence.EventID || prior.SequenceID != evidence.SequenceID {
		return false, ErrWebhookEvidenceConflict
	}
	return false, nil
}

func (s FileEvidenceStore) Record(_ context.Context, evidence WebhookEvidence) (bool, error) {
	return writeEvidenceFile(s.Directory, evidence)
}

func (q FileReconciliationQueue) Enqueue(_ context.Context, evidence WebhookEvidence) (bool, error) {
	return writeEvidenceFile(q.Directory, evidence)
}

// YellowCardWebhookReceiver is deliberately evidence-only. Its accepted result
// means "queued for independent reconciliation", never "provider payment settled".
type YellowCardWebhookReceiver struct {
	Config   YellowCardWebhookConfig
	Resolver SecretResolver
	Replay   ReplayStore
	Evidence EvidenceStore
	Queue    ReconciliationQueue
	Now      func() time.Time
}

func (receiver YellowCardWebhookReceiver) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	defer request.Body.Close()
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := receiver.Config.Validate(); err != nil || receiver.Resolver == nil || receiver.Replay == nil || receiver.Evidence == nil || receiver.Queue == nil {
		http.Error(response, "webhook receiver unavailable", http.StatusServiceUnavailable)
		return
	}
	source, err := netip.ParseAddr(strings.TrimSpace(request.Header.Get(receiver.Config.SourceHeader)))
	if err != nil || !addressAllowed(source, receiver.Config.AllowedCIDRs) {
		http.Error(response, "webhook source forbidden", http.StatusForbidden)
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, receiver.Config.MaxBodyBytes)
	body, err := io.ReadAll(request.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(response, "webhook body too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(response, "webhook body unavailable", http.StatusBadRequest)
		return
	}
	if len(body) == 0 {
		http.Error(response, "webhook body unavailable", http.StatusBadRequest)
		return
	}
	timestamp, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(request.Header.Get(receiver.Config.TimestampHeader)))
	if err != nil {
		http.Error(response, "webhook timestamp invalid", http.StatusUnauthorized)
		return
	}
	now := time.Now
	if receiver.Now != nil {
		now = receiver.Now
	}
	delta := now().UTC().Sub(timestamp.UTC())
	if delta > receiver.Config.MaxAge || delta < -receiver.Config.MaxAge {
		http.Error(response, "webhook timestamp expired", http.StatusUnauthorized)
		return
	}
	secrets, err := receiver.loadSecrets(request.Context())
	if err != nil {
		http.Error(response, "webhook receiver unavailable", http.StatusServiceUnavailable)
		return
	}
	event, version, err := verifyYellowCardWebhookWithSecrets(secrets, request.Header.Get(receiver.Config.SignatureHeader), body)
	if err != nil {
		http.Error(response, "webhook signature invalid", http.StatusUnauthorized)
		return
	}
	executedAt, err := time.Parse(time.RFC3339Nano, event.ExecutedAt)
	if err != nil {
		http.Error(response, "webhook payload invalid", http.StatusBadRequest)
		return
	}
	payloadDigest := sha256.Sum256(body)
	evidence := WebhookEvidence{
		Provider:          "yellowcard",
		EventID:           event.ID,
		SequenceID:        event.SequenceID,
		Status:            event.Status,
		Event:             event.Event,
		ExecutedAt:        executedAt.UTC(),
		ReceivedAt:        now().UTC(),
		PayloadSHA256:     hex.EncodeToString(payloadDigest[:]),
		SecretVersion:     version,
		SourceAddress:     source.String(),
		Reconciliation:    "pending_independent_provider_and_ledger_reconciliation",
		SettlementAllowed: false,
	}
	createdEvidence, err := receiver.Evidence.Record(request.Context(), evidence)
	if err != nil {
		if errors.Is(err, ErrWebhookEvidenceConflict) {
			http.Error(response, "webhook event conflict", http.StatusConflict)
			return
		}
		http.Error(response, "webhook evidence unavailable", http.StatusServiceUnavailable)
		return
	}
	if _, err := receiver.Queue.Enqueue(request.Context(), evidence); err != nil {
		http.Error(response, "webhook reconciliation unavailable", http.StatusServiceUnavailable)
		return
	}
	replayKey := webhookReplayKey(evidence)
	reserved, err := receiver.Replay.Reserve(request.Context(), replayKey, receiver.Config.MaxAge*2)
	if err != nil {
		http.Error(response, "webhook replay protection unavailable", http.StatusServiceUnavailable)
		return
	}
	if !reserved && !createdEvidence {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if !reserved {
		http.Error(response, "webhook replay conflict", http.StatusConflict)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(http.StatusAccepted)
	_, _ = response.Write([]byte(`{"status":"accepted_for_reconciliation","settlement":"disabled"}`))
}

func (receiver YellowCardWebhookReceiver) loadSecrets(ctx context.Context) ([]SecretMaterial, error) {
	current, err := receiver.Resolver.Resolve(ctx, receiver.Config.CurrentSecret)
	if err != nil {
		return nil, err
	}
	secrets := []SecretMaterial{current}
	if strings.TrimSpace(receiver.Config.PreviousSecret) != "" && receiver.Config.PreviousSecret != receiver.Config.CurrentSecret {
		previous, err := receiver.Resolver.Resolve(ctx, receiver.Config.PreviousSecret)
		if err != nil {
			return nil, err
		}
		secrets = append(secrets, previous)
	}
	return secrets, nil
}

func addressAllowed(address netip.Addr, prefixes []netip.Prefix) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func webhookReplayKey(evidence WebhookEvidence) string {
	digest := sha256.Sum256([]byte(evidence.Provider + "\x00" + evidence.EventID + "\x00" + evidence.SequenceID + "\x00" + evidence.PayloadSHA256))
	return "yellowcard:webhook:" + hex.EncodeToString(digest[:])
}

func verifyYellowCardWebhookWithSecrets(secrets []SecretMaterial, signature string, body []byte) (YellowCardWebhook, string, error) {
	if strings.TrimSpace(signature) == "" || len(body) == 0 {
		return YellowCardWebhook{}, "", errors.New("missing webhook signature")
	}
	for _, secret := range secrets {
		event, err := VerifyYellowCardWebhook(secret.Value, signature, body)
		if err == nil {
			return event, secret.Version, nil
		}
	}
	return YellowCardWebhook{}, "", errors.New("webhook signature did not match an active secret")
}

// WebhookRuntimeFromEnvironment constructs the enabled receiver from a
// secret-manager injected file root. It refuses to enable a path that can settle.
func WebhookRuntimeFromEnvironment(getenv func(string) string) (http.Handler, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if strings.ToLower(strings.TrimSpace(getenv("UMOJA_YELLOWCARD_WEBHOOK_ENABLED"))) != "true" {
		return nil, nil
	}
	if strings.ToLower(strings.TrimSpace(getenv("UMOJA_YELLOWCARD_ENABLED"))) != "true" || strings.ToLower(strings.TrimSpace(getenv("UMOJA_YELLOWCARD_FAIL_CLOSED"))) != "true" || strings.ToLower(strings.TrimSpace(getenv("UMOJA_YELLOWCARD_WEBHOOK_FAIL_CLOSED"))) != "true" || strings.ToLower(strings.TrimSpace(getenv("UMOJA_YELLOWCARD_WEBHOOK_CAN_SETTLE"))) != "false" {
		return nil, errors.New("Yellow Card webhook enablement requires provider enabled, fail-closed controls, and settlement disabled")
	}
	if strings.ToLower(strings.TrimSpace(getenv("UMOJA_YELLOWCARD_ENVIRONMENT"))) != "production" || strings.ToLower(strings.TrimSpace(getenv("UMOJA_YELLOWCARD_TLS_REQUIRED"))) != "true" || strings.ToLower(strings.TrimSpace(getenv("UMOJA_YELLOWCARD_WEBHOOK_TLS_REQUIRED"))) != "true" || strings.ToLower(strings.TrimSpace(getenv("UMOJA_YELLOWCARD_ALLOW_INSECURE_LOOPBACK"))) != "false" {
		return nil, errors.New("Yellow Card webhook enablement requires production HTTPS-only transport")
	}
	webhookURL, err := url.Parse(getenv("UMOJA_YELLOWCARD_WEBHOOK_PUBLIC_URL"))
	if err != nil || webhookURL.Scheme != "https" || webhookURL.Hostname() == "" || webhookURL.User != nil || webhookURL.RawQuery != "" || webhookURL.Fragment != "" || webhookURL.Path != "/webhooks/yellowcard" {
		return nil, errors.New("Yellow Card webhook public URL must be an exact HTTPS webhook endpoint")
	}
	maxAgeSeconds, err := strconv.Atoi(getenv("UMOJA_YELLOWCARD_WEBHOOK_MAX_AGE_SECONDS"))
	if err != nil {
		return nil, errors.New("webhook max age must be an integer number of seconds")
	}
	maxBodyBytes, err := strconv.ParseInt(getenv("UMOJA_YELLOWCARD_WEBHOOK_BODY_MAX_BYTES"), 10, 64)
	if err != nil {
		return nil, errors.New("webhook body limit must be an integer number of bytes")
	}
	prefixes, err := ParseCIDRAllowlist(getenv("UMOJA_YELLOWCARD_WEBHOOK_ALLOWED_CIDRS"))
	if err != nil {
		return nil, err
	}
	config := YellowCardWebhookConfig{
		SignatureHeader: getenv("UMOJA_YELLOWCARD_WEBHOOK_SIGNATURE_HEADER"),
		TimestampHeader: getenv("UMOJA_YELLOWCARD_WEBHOOK_TIMESTAMP_HEADER"),
		SourceHeader:    "X-Umoja-Provider-Source",
		MaxAge:          time.Duration(maxAgeSeconds) * time.Second,
		MaxBodyBytes:    maxBodyBytes,
		AllowedCIDRs:    prefixes,
		CurrentSecret:   getenv("UMOJA_YELLOWCARD_WEBHOOK_SECRET_REFERENCE"),
		PreviousSecret:  getenv("UMOJA_YELLOWCARD_WEBHOOK_PREVIOUS_SECRET_REFERENCE"),
	}
	if err := config.Validate(); err != nil {
		return nil, err
	}
	resolver := FileSecretResolver{Root: getenv("UMOJA_PROVIDER_MATERIAL_ROOT")}
	redisPassword, err := resolver.Resolve(context.Background(), getenv("UMOJA_YELLOWCARD_REPLAY_REDIS_PASSWORD_SECRET_REFERENCE"))
	if err != nil {
		return nil, fmt.Errorf("resolve replay Redis password: %w", err)
	}
	caBundle, err := os.ReadFile(getenv("UMOJA_YELLOWCARD_REPLAY_REDIS_CA_BUNDLE_PATH"))
	if err != nil || len(caBundle) == 0 {
		return nil, errors.New("replay Redis CA bundle is unavailable")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caBundle) {
		return nil, errors.New("replay Redis CA bundle contains no certificate")
	}
	address := getenv("UMOJA_YELLOWCARD_REPLAY_REDIS_ADDRESS")
	host, _, err := net.SplitHostPort(address)
	if err != nil || strings.TrimSpace(host) == "" {
		return nil, errors.New("replay Redis address must be host:port")
	}
	redis := &RedisReplayStore{
		Address:   address,
		Password:  redisPassword.Value,
		KeyPrefix: defaultString(getenv("UMOJA_YELLOWCARD_REPLAY_KEY_PREFIX"), "yellowcard:webhook:"),
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: host},
		Timeout:   3 * time.Second,
	}
	evidenceDirectory := getenv("UMOJA_YELLOWCARD_WEBHOOK_EVIDENCE_DIRECTORY")
	queueDirectory := getenv("UMOJA_YELLOWCARD_WEBHOOK_RECONCILIATION_QUEUE_DIRECTORY")
	if strings.TrimSpace(evidenceDirectory) == "" || strings.TrimSpace(queueDirectory) == "" {
		return nil, errors.New("durable evidence and reconciliation queue directories are required")
	}
	return YellowCardWebhookReceiver{
		Config:   config,
		Resolver: resolver,
		Replay:   redis,
		Evidence: FileEvidenceStore{Directory: evidenceDirectory},
		Queue:    FileReconciliationQueue{Directory: queueDirectory},
		Now:      time.Now,
	}, nil
}

func defaultString(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// YellowCardSigningMaterial identifies the currently approved outbound signing
// secret without exposing its contents outside the trusted runtime boundary.
type YellowCardSigningMaterial struct {
	APIKeyVersion string
	HMACVersion   string
	Signer        YellowCardSigner
}

// YellowCardSigningMaterialFromEnvironment resolves the outbound API key and
// HMAC secret from file-injected secret-manager references. The caller receives
// a signer only; it must not serialize, log, or persist the underlying values.
// This factory does not enable a provider workflow or grant payment authority.
func YellowCardSigningMaterialFromEnvironment(ctx context.Context, getenv func(string) string) (YellowCardSigningMaterial, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	resolver := FileSecretResolver{Root: getenv("UMOJA_PROVIDER_MATERIAL_ROOT")}
	apiKey, err := resolver.Resolve(ctx, getenv("UMOJA_YELLOWCARD_API_KEY_SECRET_REFERENCE"))
	if err != nil {
		return YellowCardSigningMaterial{}, fmt.Errorf("resolve Yellow Card API key: %w", err)
	}
	hmacSecret, err := resolver.Resolve(ctx, getenv("UMOJA_YELLOWCARD_HMAC_SECRET_REFERENCE"))
	if err != nil {
		return YellowCardSigningMaterial{}, fmt.Errorf("resolve Yellow Card outbound HMAC secret: %w", err)
	}
	signer, err := NewHMACYellowCardSigner(string(apiKey.Value), hmacSecret.Value)
	if err != nil {
		return YellowCardSigningMaterial{}, err
	}
	return YellowCardSigningMaterial{APIKeyVersion: apiKey.Version, HMACVersion: hmacSecret.Version, Signer: signer}, nil
}
