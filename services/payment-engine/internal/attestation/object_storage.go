package attestation

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

var ErrObjectStorageEvidence = errors.New("object-storage evidence is not available")

type ObjectStorageEvidenceLoader struct {
	Client   *minio.Client
	Bucket   string
	MaxBytes int64
}

func NewObjectStorageEvidenceLoader(endpoint, accessKey, secretKey, region, bucket string, useSSL bool) (*ObjectStorageEvidenceLoader, error) {
	endpoint = strings.TrimSpace(endpoint)
	bucket = strings.TrimSpace(bucket)
	if endpoint == "" || accessKey == "" || secretKey == "" || bucket == "" {
		return nil, errors.New("object-storage endpoint, credentials, and bucket are required")
	}
	endpoint = strings.TrimPrefix(strings.TrimPrefix(endpoint, "https://"), "http://")
	client, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(accessKey, secretKey, ""), Secure: useSSL, Region: strings.TrimSpace(region)})
	if err != nil {
		return nil, fmt.Errorf("create object-storage client: %w", err)
	}
	return &ObjectStorageEvidenceLoader{Client: client, Bucket: bucket, MaxBytes: 16 << 20}, nil
}

func (l *ObjectStorageEvidenceLoader) Load(ctx context.Context, evidenceURI string) ([]byte, error) {
	if l == nil || l.Client == nil || l.Bucket == "" {
		return nil, fmt.Errorf("%w: loader is not configured", ErrObjectStorageEvidence)
	}
	bucket, object, err := parseEvidenceObjectURI(evidenceURI, l.Bucket)
	if err != nil {
		return nil, err
	}
	maxBytes := l.MaxBytes
	if maxBytes <= 0 {
		maxBytes = 16 << 20
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	reader, err := l.Client.GetObject(ctx, bucket, object, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("%w: get object: %v", ErrObjectStorageEvidence, err)
	}
	defer reader.Close()
	if _, err := reader.Stat(); err != nil {
		return nil, fmt.Errorf("%w: stat object: %v", ErrObjectStorageEvidence, err)
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: read object: %v", ErrObjectStorageEvidence, err)
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("%w: object exceeds %d bytes", ErrObjectStorageEvidence, maxBytes)
	}
	return data, nil
}

func parseEvidenceObjectURI(raw, expectedBucket string) (string, string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "s3" && u.Scheme != "gs") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return "", "", fmt.Errorf("%w: URI must be s3:// or gs:// without query/fragment", ErrObjectStorageEvidence)
	}
	if u.Host != expectedBucket {
		return "", "", fmt.Errorf("%w: URI bucket is not the configured evidence bucket", ErrObjectStorageEvidence)
	}
	object := strings.TrimPrefix(u.Path, "/")
	clean := path.Clean(object)
	if object == "" || clean != object || strings.HasPrefix(object, "../") || strings.Contains(object, "\\") {
		return "", "", fmt.Errorf("%w: invalid object key", ErrObjectStorageEvidence)
	}
	return u.Host, object, nil
}
