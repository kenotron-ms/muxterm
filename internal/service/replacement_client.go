package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"
	"unicode/utf8"
)

const (
	replacementCommandTimeout = 5 * time.Second
	replacementOutputLimit    = 4096
	replacementPlanIDLimit    = 64
)

type replacementCommandClient struct {
	binaryPath string
	command    Commander
}

type replacementCommandResponse struct {
	State  string          `json:"state"`
	PlanID json.RawMessage `json:"planId"`
}

func newReplacementClient(config ServiceConfig, command Commander) (ReplacementClient, error) {
	if command == nil {
		return nil, fmt.Errorf("replacement commander must not be nil")
	}
	normalized, err := normalizeServiceConfig(config)
	if err != nil {
		return nil, fmt.Errorf("normalize replacement service config: %w", err)
	}
	return &replacementCommandClient{
		binaryPath: normalized.BinaryPath,
		command:    command,
	}, nil
}

func (client *replacementCommandClient) Plan(ctx context.Context) (ReplacementPlan, error) {
	output, replacementErr := client.run(
		ctx,
		"plan",
		false,
		"recovery",
		"replacement",
		"plan",
		"--json",
	)
	if replacementErr != nil {
		return ReplacementPlan{Disposition: replacementErr.Disposition}, replacementErr
	}

	response, err := decodeReplacementCommandResponse(output)
	if err != nil {
		replacementErr := preauthorizationReplacementError(
			ReplacementFailed,
			"plan",
			errors.New("incumbent sessiond preserved; plan response did not match the required schema"),
		)
		return ReplacementPlan{Disposition: ReplacementFailed}, replacementErr
	}

	switch response.State {
	case string(ReplacementCurrent):
		if response.PlanID != nil {
			replacementErr := invalidPlanResponseError()
			return ReplacementPlan{Disposition: ReplacementFailed}, replacementErr
		}
		return ReplacementPlan{Disposition: ReplacementCurrent}, nil
	case string(ReplacementReady):
		planID, err := decodePlanID(response.PlanID)
		if err != nil {
			replacementErr := invalidPlanResponseError()
			return ReplacementPlan{Disposition: ReplacementFailed}, replacementErr
		}
		return ReplacementPlan{
			Disposition: ReplacementReady,
			PlanID:      planID,
		}, nil
	default:
		replacementErr := invalidPlanResponseError()
		return ReplacementPlan{Disposition: ReplacementFailed}, replacementErr
	}
}

func (client *replacementCommandClient) Commit(
	ctx context.Context,
	planID string,
) (ReplacementResult, error) {
	if err := validatePlanID(planID); err != nil {
		replacementErr := preauthorizationReplacementError(
			ReplacementFailed,
			"commit",
			errors.New("incumbent sessiond preserved; plan identifier is invalid"),
		)
		return ReplacementResult{Disposition: ReplacementFailed}, replacementErr
	}

	output, replacementErr := client.run(
		ctx,
		"commit",
		true,
		"recovery",
		"replacement",
		"commit",
		"--plan",
		planID,
		"--json",
	)
	if replacementErr != nil {
		return ReplacementResult{Disposition: replacementErr.Disposition}, replacementErr
	}

	response, err := decodeReplacementCommandResponse(output)
	if err != nil || response.PlanID != nil {
		replacementErr := invalidCommitResponseError()
		return ReplacementResult{Disposition: ReplacementFailed}, replacementErr
	}
	switch response.State {
	case string(ReplacementCommitted):
		return ReplacementResult{Disposition: ReplacementCommitted}, nil
	case string(ReplacementCurrent):
		return ReplacementResult{Disposition: ReplacementCurrent}, nil
	default:
		replacementErr := invalidCommitResponseError()
		return ReplacementResult{Disposition: ReplacementFailed}, replacementErr
	}
}

func (client *replacementCommandClient) run(
	ctx context.Context,
	phase string,
	allowCompletedCancellation bool,
	args ...string,
) ([]byte, *ReplacementError) {
	commandCtx, cancel := context.WithTimeout(ctx, replacementCommandTimeout)
	defer cancel()

	result, runErr := client.command.Run(commandCtx, client.binaryPath, args...)
	completed := runErr == nil && result.ExitCode == 0
	callerErr := ctx.Err()
	if callerErr != nil && !(allowCompletedCancellation && completed) {
		return nil, preauthorizationReplacementError(
			ReplacementFailed,
			phase,
			fmt.Errorf("incumbent sessiond preserved; replacement command canceled: %w", callerErr),
		)
	}
	if commandErr := commandCtx.Err(); commandErr != nil &&
		!(allowCompletedCancellation && completed && callerErr != nil) {
		return nil, preauthorizationReplacementError(
			ReplacementFailed,
			phase,
			fmt.Errorf("incumbent sessiond preserved; replacement command timed out: %w", commandErr),
		)
	}
	if result.StdoutTruncated ||
		result.StderrTruncated ||
		len(result.Stdout) > replacementOutputLimit ||
		len(result.Stderr) > replacementOutputLimit {
		return nil, preauthorizationReplacementError(
			ReplacementFailed,
			phase,
			errors.New("incumbent sessiond preserved; replacement command output exceeded the safety limit"),
		)
	}

	switch result.ExitCode {
	case 0:
		if runErr != nil {
			return nil, preauthorizationReplacementError(
				ReplacementFailed,
				phase,
				errors.New("incumbent sessiond preserved; replacement command failed without a usable status"),
			)
		}
		return result.Stdout, nil
	case 10:
		return nil, preauthorizationReplacementError(
			ReplacementDeferred,
			phase,
			errors.New("incumbent sessiond preserved; daemon deferred replacement"),
		)
	case 11:
		return nil, preauthorizationReplacementError(
			ReplacementLegacyDeferred,
			phase,
			errors.New("incumbent sessiond preserved; replacement command is unavailable"),
		)
	case -1:
		if runErr != nil {
			var exitErr *exec.ExitError
			if errors.As(runErr, &exitErr) || errors.Is(runErr, exec.ErrWaitDelay) {
				return nil, preauthorizationReplacementError(
					ReplacementFailed,
					phase,
					errors.New("incumbent sessiond preserved; replacement command failed without a usable status"),
				)
			}
			return nil, preauthorizationReplacementError(
				ReplacementLegacyDeferred,
				phase,
				errors.New("incumbent sessiond preserved; replacement command could not start"),
			)
		}
		return nil, preauthorizationReplacementError(
			ReplacementFailed,
			phase,
			errors.New("incumbent sessiond preserved; replacement command returned no exit status"),
		)
	default:
		return nil, preauthorizationReplacementError(
			ReplacementFailed,
			phase,
			fmt.Errorf(
				"incumbent sessiond preserved; replacement command exited with status %d",
				result.ExitCode,
			),
		)
	}
}

func decodeReplacementCommandResponse(output []byte) (replacementCommandResponse, error) {
	if len(output) == 0 || len(output) > replacementOutputLimit || !utf8.Valid(output) {
		return replacementCommandResponse{}, errors.New("invalid replacement response encoding")
	}

	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.DisallowUnknownFields()
	var response replacementCommandResponse
	if err := decoder.Decode(&response); err != nil {
		return replacementCommandResponse{}, errors.New("invalid replacement response object")
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return replacementCommandResponse{}, errors.New("replacement response contains trailing data")
	}
	if err := rejectDuplicateReplacementFields(output); err != nil {
		return replacementCommandResponse{}, err
	}
	return response, nil
}

func rejectDuplicateReplacementFields(output []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(output))
	token, err := decoder.Token()
	if err != nil {
		return errors.New("invalid replacement response object")
	}
	open, ok := token.(json.Delim)
	if !ok || open != '{' {
		return errors.New("replacement response is not an object")
	}

	seen := make(map[string]struct{}, 2)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return errors.New("invalid replacement response field")
		}
		name, ok := token.(string)
		if !ok {
			return errors.New("invalid replacement response field name")
		}
		if _, exists := seen[name]; exists {
			return errors.New("replacement response contains a duplicate field")
		}
		seen[name] = struct{}{}

		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return errors.New("invalid replacement response field value")
		}
	}
	if _, err := decoder.Token(); err != nil {
		return errors.New("invalid replacement response object")
	}
	return nil
}

func decodePlanID(raw json.RawMessage) (string, error) {
	if raw == nil {
		return "", errors.New("missing plan identifier")
	}
	var planID *string
	if err := json.Unmarshal(raw, &planID); err != nil || planID == nil {
		return "", errors.New("invalid plan identifier")
	}
	if err := validatePlanID(*planID); err != nil {
		return "", err
	}
	return *planID, nil
}

func validatePlanID(planID string) error {
	if !utf8.ValidString(planID) || len(planID) == 0 || len(planID) > replacementPlanIDLimit {
		return errors.New("invalid plan identifier")
	}
	for index := 0; index < len(planID); index++ {
		if planID[index] <= 0x20 || planID[index] == 0x7f {
			return errors.New("invalid plan identifier")
		}
	}
	return nil
}

func invalidPlanResponseError() *ReplacementError {
	return preauthorizationReplacementError(
		ReplacementFailed,
		"plan",
		errors.New("incumbent sessiond preserved; plan response did not match the required schema"),
	)
}

func invalidCommitResponseError() *ReplacementError {
	return preauthorizationReplacementError(
		ReplacementFailed,
		"commit",
		errors.New("incumbent sessiond preserved; commit response did not match the required schema"),
	)
}

func preauthorizationReplacementError(
	disposition ReplacementDisposition,
	phase string,
	err error,
) *ReplacementError {
	return &ReplacementError{
		Disposition: disposition,
		Phase:       phase,
		Err:         err,
	}
}
