package attestation

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var ErrEvidenceNotAvailable = errors.New("evidence is not available for safe Fabric submission")

type EvidenceLoader interface {
	Load(context.Context, string) ([]byte, error)
}

type FileEvidenceLoader struct{}

func (FileEvidenceLoader) Load(ctx context.Context, evidenceURI string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	u, err := url.Parse(strings.TrimSpace(evidenceURI))
	if err != nil || u.Scheme != "file" {
		return nil, fmt.Errorf("%w: only file:// evidence is enabled for this worker", ErrEvidenceNotAvailable)
	}
	path, err := filepath.Abs(filepath.Clean(u.Path))
	if err != nil {
		return nil, fmt.Errorf("resolve evidence path: %w", err)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open evidence: %w", err)
	}
	defer f.Close()
	const maxEvidenceBytes = 16 << 20
	data, err := io.ReadAll(io.LimitReader(f, maxEvidenceBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read evidence: %w", err)
	}
	if len(data) > maxEvidenceBytes {
		return nil, fmt.Errorf("%w: evidence exceeds 16 MiB", ErrEvidenceNotAvailable)
	}
	return data, nil
}

type Worker struct {
	Queue        *PostgreSQLQueue
	Attestor     *Client
	Evidence     EvidenceLoader
	Admission    *AdmissionController
	PollInterval time.Duration
	RetryDelay   time.Duration
	Now          func() time.Time
	Logger       *log.Logger
}

func (w *Worker) validate() error {
	if w == nil || w.Queue == nil || w.Attestor == nil || w.Evidence == nil || w.Admission == nil {
		return errors.New("Fabric queue worker dependencies are required")
	}
	if w.Now == nil {
		return errors.New("Fabric queue worker clock is required")
	}
	if w.PollInterval <= 0 {
		return errors.New("Fabric queue worker poll interval must be positive")
	}
	if w.RetryDelay <= 0 {
		return errors.New("Fabric queue worker retry delay must be positive")
	}
	return nil
}

func (w *Worker) Run(ctx context.Context) error {
	if err := w.validate(); err != nil {
		return err
	}
	for {
		processed, err := w.ProcessOne(ctx)
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			if w.Logger != nil {
				w.Logger.Printf("Fabric queue worker item held: %v", err)
			}
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if processed {
			continue
		}
		timer := time.NewTimer(w.PollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (w *Worker) ProcessOne(ctx context.Context) (bool, error) {
	item, err := w.Queue.Claim(ctx, w.Now().UTC())
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := w.Admission.Acquire(ctx); err != nil {
		_ = w.Queue.MarkUnknown(context.Background(), item, w.Now().UTC().Add(w.RetryDelay), err.Error())
		return true, err
	}
	defer w.Admission.Release()
	if item.State == "unknown" {
		return true, w.reconcile(ctx, item)
	}
	return true, w.submit(ctx, item)
}

func (w *Worker) submit(ctx context.Context, item QueueItem) error {
	data, err := w.Evidence.Load(ctx, item.EvidenceURI)
	if err != nil {
		return w.hold(item, err)
	}
	if got := EvidenceDigest(data); got != item.PayloadDigest {
		return w.hold(item, fmt.Errorf("evidence digest mismatch: got %s expected %s", got, item.PayloadDigest))
	}
	req, err := NewRequest(item.ReleaseSHA, item.EvidenceID, item.EvidenceURI, item.EndorsementScope, data)
	if err != nil {
		return w.hold(item, err)
	}
	record, err := w.Attestor.Attest(ctx, req)
	if err != nil {
		return w.hold(item, err)
	}
	if err := w.Queue.MarkComplete(ctx, item, record.AttestationID); err != nil {
		return err
	}
	return nil
}

func (w *Worker) reconcile(ctx context.Context, item QueueItem) error {
	id := DeterministicAttestationID(item.ReleaseSHA, item.EvidenceID, item.PayloadDigest)
	record, err := w.Attestor.VerifyRecord(ctx, id)
	if err != nil {
		return w.hold(item, err)
	}
	if record.ReleaseSHA != item.ReleaseSHA || record.EvidenceID != item.EvidenceID || record.EvidenceSHA256 != item.PayloadDigest {
		return w.hold(item, errors.New("Fabric reconciliation binding mismatch"))
	}
	return w.Queue.MarkComplete(ctx, item, record.AttestationID)
}

func (w *Worker) hold(item QueueItem, reason error) error {
	return w.Queue.MarkUnknown(context.Background(), item, w.Now().UTC().Add(w.RetryDelay), reason.Error())
}

func DeterministicAttestationID(releaseSHA, evidenceID, evidenceSHA256 string) string {
	sum := sha256.Sum256([]byte(releaseSHA + "\x00" + evidenceID + "\x00" + evidenceSHA256))
	return hex.EncodeToString(sum[:])
}
