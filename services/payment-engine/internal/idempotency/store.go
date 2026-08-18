package idempotency

import (
	"context"
	"errors"
)

type Store interface {
	Reserve(context.Context, string) (bool, error)
}
type DisabledStore struct{}

func (DisabledStore) Reserve(context.Context, string) (bool, error) {
	return false, errors.New("distributed idempotency is disabled until Redis is deployed and configured")
}

func RequireReservation(ctx context.Context, store Store, key string) error {
	if key == "" {
		return errors.New("idempotency key is required")
	}
	reserved, err := store.Reserve(ctx, key)
	if err != nil {
		return err
	}
	if !reserved {
		return errors.New("idempotency key already reserved")
	}
	return nil
}
