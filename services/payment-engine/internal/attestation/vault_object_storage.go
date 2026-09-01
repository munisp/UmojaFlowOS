package attestation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type StorageCredentials struct {
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
	Version         string `json:"version"`
}
type StorageCredentialProvider interface {
	Refresh(context.Context) (StorageCredentials, error)
}

type VaultKV2CredentialProvider struct {
	HTTPClient                                       *http.Client
	Address, Token, TokenFile, SecretPath, Namespace string
}

func (p *VaultKV2CredentialProvider) Refresh(ctx context.Context) (StorageCredentials, error) {
	if p == nil || strings.TrimSpace(p.Address) == "" || strings.TrimSpace(p.SecretPath) == "" {
		return StorageCredentials{}, errors.New("Vault credential provider is not configured")
	}
	token := p.Token
	if token == "" && p.TokenFile != "" {
		b, err := os.ReadFile(p.TokenFile)
		if err != nil {
			return StorageCredentials{}, fmt.Errorf("read Vault token file: %w", err)
		}
		token = strings.TrimSpace(string(b))
	}
	if token == "" {
		return StorageCredentials{}, errors.New("Vault token is not configured")
	}
	base, err := url.Parse(strings.TrimRight(p.Address, "/"))
	if err != nil {
		return StorageCredentials{}, fmt.Errorf("invalid Vault address: %w", err)
	}
	base.Path = path.Join(base.Path, "/v1/secret/data/"+strings.TrimPrefix(p.SecretPath, "/"))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return StorageCredentials{}, err
	}
	req.Header.Set("X-Vault-Token", token)
	if p.Namespace != "" {
		req.Header.Set("X-Vault-Namespace", p.Namespace)
	}
	client := p.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return StorageCredentials{}, fmt.Errorf("Vault credential read: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return StorageCredentials{}, fmt.Errorf("Vault credential read returned HTTP %d", resp.StatusCode)
	}
	var envelope struct {
		Data struct {
			Data     StorageCredentials `json:"data"`
			Metadata struct {
				Version int `json:"version"`
			} `json:"metadata"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return StorageCredentials{}, fmt.Errorf("decode Vault credential response: %w", err)
	}
	creds := envelope.Data.Data
	if creds.Version == "" {
		creds.Version = fmt.Sprintf("%d", envelope.Data.Metadata.Version)
	}
	if creds.AccessKeyID == "" || creds.SecretAccessKey == "" || creds.Version == "" {
		return StorageCredentials{}, errors.New("Vault response lacks versioned object-storage credentials")
	}
	return creds, nil
}

type VersionAwareObjectStorageEvidenceLoader struct {
	Provider                            StorageCredentialProvider
	Endpoint, Bucket, Region, CanaryKey string
	Secure                              bool
	MaxBytes                            int64
	mu                                  sync.RWMutex
	version                             string
	client                              *minio.Client
}

func NewVersionAwareObjectStorageEvidenceLoader(provider StorageCredentialProvider, endpoint, bucket, region, canaryKey string, secure bool) (*VersionAwareObjectStorageEvidenceLoader, error) {
	if provider == nil || strings.TrimSpace(endpoint) == "" || strings.TrimSpace(bucket) == "" || strings.TrimSpace(canaryKey) == "" {
		return nil, errors.New("version-aware storage provider, endpoint, bucket, and canary key are required")
	}
	return &VersionAwareObjectStorageEvidenceLoader{Provider: provider, Endpoint: endpoint, Bucket: bucket, Region: region, CanaryKey: canaryKey, Secure: secure, MaxBytes: 16 << 20}, nil
}
func (l *VersionAwareObjectStorageEvidenceLoader) refreshAndCanary(ctx context.Context) error {
	creds, err := l.Provider.Refresh(ctx)
	if err != nil {
		return fmt.Errorf("credential refresh: %w", err)
	}
	endpoint := strings.TrimPrefix(strings.TrimPrefix(l.Endpoint, "https://"), "http://")
	client, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(creds.AccessKeyID, creds.SecretAccessKey, ""), Secure: l.Secure, Region: l.Region})
	if err != nil {
		return fmt.Errorf("create refreshed object-storage client: %w", err)
	}
	if _, err := client.StatObject(ctx, l.Bucket, l.CanaryKey, minio.StatObjectOptions{}); err != nil {
		if isStorageAuthError(err) {
			return fmt.Errorf("credential canary rejected with 401/403: %w", err)
		}
		return fmt.Errorf("credential canary failed: %w", err)
	}
	l.mu.Lock()
	l.client, l.version = client, creds.Version
	l.mu.Unlock()
	return nil
}
func (l *VersionAwareObjectStorageEvidenceLoader) Load(ctx context.Context, evidenceURI string) ([]byte, error) {
	bucket, object, err := parseEvidenceObjectURI(evidenceURI, l.Bucket)
	if err != nil {
		return nil, err
	}
	l.mu.RLock()
	client, version := l.client, l.version
	l.mu.RUnlock()
	if client == nil {
		if err := l.refreshAndCanary(ctx); err != nil {
			return nil, err
		}
		l.mu.RLock()
		client, version = l.client, l.version
		l.mu.RUnlock()
	}
	data, err := readObject(ctx, client, bucket, object, l.MaxBytes)
	if err == nil {
		return data, nil
	}
	if !isStorageAuthError(err) {
		return nil, err
	}
	if err := l.refreshAndCanary(ctx); err != nil {
		return nil, fmt.Errorf("%w: refreshed canary failed after credential rejection: %v", ErrObjectStorageEvidence, err)
	}
	l.mu.RLock()
	refreshedClient, refreshedVersion := l.client, l.version
	l.mu.RUnlock()
	if refreshedVersion == version {
		return nil, fmt.Errorf("%w: credential version did not change after 401/403", ErrObjectStorageEvidence)
	}
	return readObject(ctx, refreshedClient, bucket, object, l.MaxBytes)
}
func readObject(ctx context.Context, client *minio.Client, bucket, object string, maxBytes int64) ([]byte, error) {
	if client == nil {
		return nil, errors.New("object-storage client is unavailable")
	}
	if maxBytes <= 0 {
		maxBytes = 16 << 20
	}
	reader, err := client.GetObject(ctx, bucket, object, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	if _, err := reader.Stat(); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("object exceeds %d bytes", maxBytes)
	}
	return data, nil
}
func isStorageAuthError(err error) bool {
	r := minio.ToErrorResponse(err)
	return r.Code == "AccessDenied" || r.Code == "InvalidAccessKeyId" || r.StatusCode == http.StatusUnauthorized || r.StatusCode == http.StatusForbidden
}
