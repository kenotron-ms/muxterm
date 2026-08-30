package service

import (
	"context"
	"fmt"
)

type ReplacementDisposition string

const (
	ReplacementReady          ReplacementDisposition = "ready"
	ReplacementCurrent        ReplacementDisposition = "current"
	ReplacementCommitted      ReplacementDisposition = "committed"
	ReplacementDeferred       ReplacementDisposition = "deferred"
	ReplacementLegacyDeferred ReplacementDisposition = "legacy-deferred"
	ReplacementFailed         ReplacementDisposition = "failed"
)

type ReplacementPlan struct {
	Disposition ReplacementDisposition
	PlanID      string
}

type ReplacementResult struct {
	Disposition ReplacementDisposition
}

type ReplacementClient interface {
	Plan(context.Context) (ReplacementPlan, error)
	Commit(context.Context, string) (ReplacementResult, error)
}

type ReplacementError struct {
	Disposition ReplacementDisposition
	Phase       string
	Err         error
}

func (replacementErr *ReplacementError) Error() string {
	disposition := replacementErr.Disposition
	switch disposition {
	case ReplacementDeferred, ReplacementLegacyDeferred, ReplacementFailed:
	default:
		disposition = ReplacementFailed
	}

	if replacementErr.Phase == "" {
		return fmt.Sprintf("replacement %s: %v", disposition, replacementErr.Err)
	}
	return fmt.Sprintf("replacement %s: %s: %v", disposition, replacementErr.Phase, replacementErr.Err)
}

func (replacementErr *ReplacementError) Unwrap() error {
	return replacementErr.Err
}
