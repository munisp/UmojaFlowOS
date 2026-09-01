package attestation

import "testing"

func TestParseEvidenceObjectURI(t *testing.T) {
	bucket, key, err := parseEvidenceObjectURI("s3://evidence-bucket/releases/r1/E-01.json", "evidence-bucket")
	if err != nil || bucket != "evidence-bucket" || key != "releases/r1/E-01.json" {
		t.Fatalf("bucket=%q key=%q err=%v", bucket, key, err)
	}
	for _, raw := range []string{
		"s3://other-bucket/evidence.json",
		"s3://evidence-bucket/../secret",
		"s3://evidence-bucket/evidence.json?versionId=x",
		"https://evidence-bucket/evidence.json",
		"s3://evidence-bucket/",
	} {
		if _, _, err := parseEvidenceObjectURI(raw, "evidence-bucket"); err == nil {
			t.Fatalf("accepted unsafe URI %q", raw)
		}
	}
}

func TestNewObjectStorageEvidenceLoaderRejectsMissingConfiguration(t *testing.T) {
	if _, err := NewObjectStorageEvidenceLoader("", "key", "secret", "us-east-1", "bucket", true); err == nil {
		t.Fatal("accepted missing endpoint")
	}
	if _, err := NewObjectStorageEvidenceLoader("https://minio:9000", "", "secret", "us-east-1", "bucket", true); err == nil {
		t.Fatal("accepted missing access key")
	}
}
