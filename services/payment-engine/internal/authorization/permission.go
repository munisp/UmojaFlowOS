package authorization

import (
	"context"
	"errors"
)

type CheckRequest struct{ Subject, Resource, Permission string }
type Checker interface {
	Check(context.Context, CheckRequest) (bool, error)
}

type DisabledChecker struct{}

func (DisabledChecker) Check(context.Context, CheckRequest) (bool, error) {
	return false, errors.New("fine-grained authorization is disabled until Permify is deployed and configured")
}

func Require(ctx context.Context, checker Checker, request CheckRequest) error {
	if request.Subject == "" || request.Resource == "" || request.Permission == "" {
		return errors.New("authorization subject, resource, and permission are required")
	}
	allowed, err := checker.Check(ctx, request)
	if err != nil {
		return err
	}
	if !allowed {
		return errors.New("authorization denied")
	}
	return nil
}
