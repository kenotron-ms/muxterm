package service

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const replacementCompletionTimeout = 10 * time.Second

func controlledReplacement(
	ctx context.Context,
	client ReplacementClient,
	supervisor Supervisor,
	probe SessiondProbe,
	socketPath string,
	incumbent DaemonIdentity,
) (ReplacementResult, error) {
	if incumbent.PID <= 0 {
		return preauthorizationFailure(
			"plan",
			errors.New("incumbent sessiond preserved; incumbent identity is invalid"),
		)
	}

	plan, err := client.Plan(ctx)
	if err != nil {
		return replacementFailureResult(err, "plan")
	}
	switch plan.Disposition {
	case ReplacementCurrent:
		if plan.PlanID != "" {
			return preauthorizationFailure(
				"plan",
				errors.New("incumbent sessiond preserved; current plan unexpectedly included an identifier"),
			)
		}
		return ReplacementResult{Disposition: ReplacementCurrent}, nil
	case ReplacementReady:
		if err := validatePlanID(plan.PlanID); err != nil {
			return preauthorizationFailure(
				"plan",
				errors.New("incumbent sessiond preserved; ready plan identifier is invalid"),
			)
		}
	case ReplacementDeferred, ReplacementLegacyDeferred, ReplacementFailed:
		return preauthorizationDispositionFailure(
			plan.Disposition,
			"plan",
			fmt.Errorf("incumbent sessiond preserved; replacement plan was %s", plan.Disposition),
		)
	default:
		return preauthorizationFailure(
			"plan",
			errors.New("incumbent sessiond preserved; replacement plan disposition is invalid"),
		)
	}

	if err := ctx.Err(); err != nil {
		return preauthorizationFailure(
			"commit",
			fmt.Errorf("incumbent sessiond preserved; replacement canceled before commit: %w", err),
		)
	}
	result, err := client.Commit(ctx, plan.PlanID)
	if err != nil {
		return replacementFailureResult(err, "commit")
	}
	switch result.Disposition {
	case ReplacementCurrent:
		return ReplacementResult{Disposition: ReplacementCurrent}, nil
	case ReplacementCommitted:
	case ReplacementDeferred, ReplacementLegacyDeferred, ReplacementFailed:
		return preauthorizationDispositionFailure(
			result.Disposition,
			"commit",
			fmt.Errorf("incumbent sessiond preserved; replacement commit was %s", result.Disposition),
		)
	default:
		return preauthorizationFailure(
			"commit",
			errors.New("incumbent sessiond preserved; replacement commit disposition is invalid"),
		)
	}

	completionCtx, cancel := context.WithTimeout(ctx, replacementCompletionTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return postcommitFailure(
			"restart",
			fmt.Errorf("replacement canceled after commit before restart: %w", err),
		)
	}
	if err := supervisor.RestartSessiond(completionCtx); err != nil {
		return postcommitFailure("restart", err)
	}
	if _, err := waitForSessiond(
		completionCtx,
		supervisor,
		probe,
		socketPath,
		&incumbent,
		SessiondRecoveryCompatible,
	); err != nil {
		return postcommitFailure("readiness", err)
	}
	return ReplacementResult{Disposition: ReplacementCommitted}, nil
}

func replacementFailureResult(err error, phase string) (ReplacementResult, error) {
	var replacementErr *ReplacementError
	if errors.As(err, &replacementErr) {
		switch replacementErr.Disposition {
		case ReplacementDeferred, ReplacementLegacyDeferred, ReplacementFailed:
			return ReplacementResult{Disposition: replacementErr.Disposition}, replacementErr
		}
	}
	return preauthorizationFailure(
		phase,
		fmt.Errorf("incumbent sessiond preserved; replacement request failed: %w", err),
	)
}

func preauthorizationFailure(phase string, err error) (ReplacementResult, error) {
	return preauthorizationDispositionFailure(ReplacementFailed, phase, err)
}

func preauthorizationDispositionFailure(
	disposition ReplacementDisposition,
	phase string,
	err error,
) (ReplacementResult, error) {
	replacementErr := &ReplacementError{
		Disposition: disposition,
		Phase:       phase,
		Err:         err,
	}
	return ReplacementResult{Disposition: disposition}, replacementErr
}

func postcommitFailure(phase string, err error) (ReplacementResult, error) {
	replacementErr := &ReplacementError{
		Disposition: ReplacementFailed,
		Phase:       phase,
		Err: fmt.Errorf(
			"replacement completion is unknown; success was not reported: %w",
			err,
		),
	}
	return ReplacementResult{Disposition: ReplacementFailed}, replacementErr
}
