package attestation

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/minio/minio-go/v7"
)

func TestVaultKV2CredentialProviderRefresh(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Vault-Token") != "token" || r.URL.Path != "/v1/secret/data/umoja/evidence" {
			t.Fatalf("unexpected Vault request: %s token=%q", r.URL.Path, r.Header.Get("X-Vault-Token"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"data": map[string]string{"access_key_id": "ak-2", "secret_access_key": "sk-2"}, "metadata": map[string]int{"version": 2}}})
	}))
	defer srv.Close()
	provider := &VaultKV2CredentialProvider{Address: srv.URL, Token: "token", SecretPath: "umoja/evidence", HTTPClient: srv.Client()}
	creds, err := provider.Refresh(context.Background())
	if err != nil || creds.AccessKeyID != "ak-2" || creds.SecretAccessKey != "sk-2" || creds.Version != "2" {
		t.Fatalf("creds=%+v err=%v", creds, err)
	}
}

func TestVaultProviderRejectsUnauthorizedAndIncompleteResponses(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusInternalServerError} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) }))
		provider := &VaultKV2CredentialProvider{Address: srv.URL, Token: "token", SecretPath: "x", HTTPClient: srv.Client()}
		if _, err := provider.Refresh(context.Background()); err == nil {
			t.Fatalf("accepted Vault status %d", status)
		}
		srv.Close()
	}
}

func TestStorageAuthErrorClassification(t *testing.T) {
	if !isStorageAuthError(minio.ErrorResponse{StatusCode: http.StatusForbidden}) {
		t.Fatal("403 not classified as auth error")
	}
	if !isStorageAuthError(minio.ErrorResponse{Code: "InvalidAccessKeyId"}) {
		t.Fatal("invalid access key not classified")
	}
	if isStorageAuthError(minio.ErrorResponse{StatusCode: http.StatusNotFound}) {
		t.Fatal("404 incorrectly classified as auth error")
	}
}
