package sessiond

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// SanitizeRecoveryHistoryLine returns bounded literal display text suitable for
// owner-local recovery history. It accepts a Go string rather than raw PTY
// bytes: invalid UTF-8 is therefore converted incrementally to U+FFFD.
// Callers must render the returned text as text, never feed it into an ANSI/VT
// parser. Removing every control and format code makes OSC, CSI, DCS, APC, PM,
// SOS, clipboard, hyperlink, image, and query sequences inert even if their
// printable suffix remains visible.
func SanitizeRecoveryHistoryLine(line string) string {
	return sanitizeRecoveryHistoryLine(line, DefaultRecoveryStoreOptions().MaxHistoryLineBytes)
}

// NewRecoveryHistorySegment constructs an immutable, bounded newest suffix of
// literal display lines using the default retention limits. Store-specific
// FlushHistory applies the same construction with that store's validated
// options.
func NewRecoveryHistorySegment(pane RecoveryPaneRef, lines []string) (RecoveryHistorySegment, error) {
	return newRecoveryHistorySegment(pane, lines, DefaultRecoveryStoreOptions())
}

func sanitizeRecoveryHistoryLine(line string, maximum int) string {
	if maximum <= 0 {
		return ""
	}
	var output strings.Builder
	output.Grow(minimumInt(len(line), maximum))
	scanned := 0
	for len(line) > 0 && scanned < RecoveryStoreMaxHistoryScanBytes {
		value, consumed := utf8.DecodeRuneInString(line)
		if scanned+consumed > RecoveryStoreMaxHistoryScanBytes {
			break
		}
		line = line[consumed:]
		scanned += consumed
		if value == '\t' {
			if output.Len()+4 > maximum {
				break
			}
			output.WriteString("    ")
			continue
		}
		if value == 0x1b || value == 0x7f ||
			(value >= 0 && value <= 0x1f) ||
			(value >= 0x80 && value <= 0x9f) ||
			unicode.IsControl(value) ||
			unicode.Is(unicode.Cf, value) {
			continue
		}
		width := utf8.RuneLen(value)
		if width < 0 || output.Len()+width > maximum {
			break
		}
		output.WriteRune(value)
	}
	return output.String()
}

func newRecoveryHistorySegment(
	pane RecoveryPaneRef,
	lines []string,
	options RecoveryStoreOptions,
) (RecoveryHistorySegment, error) {
	if err := pane.validateRecoveryContract(); err != nil {
		return RecoveryHistorySegment{}, invalidRecoveryStoreValue("history pane", err)
	}
	options, err := normalizedRecoveryStoreOptions(options)
	if err != nil {
		return RecoveryHistorySegment{}, err
	}

	// Iterate backwards so a bounded segment preserves the newest useful
	// suffix, then reverse into display order. A tab is either four spaces or
	// absent; no rune or tab expansion is split at a byte boundary.
	reversed := make([]string, 0, minimumInt(len(lines), options.MaxHistoryLinesPerSegment))
	bytesUsed := 0
	hasVisibleText := false
	for index := len(lines) - 1; index >= 0 && len(reversed) < options.MaxHistoryLinesPerSegment; index-- {
		line := sanitizeRecoveryHistoryLine(lines[index], options.MaxHistoryLineBytes)
		if len(line)+bytesUsed > options.MaxHistorySegmentBytes {
			break
		}
		reversed = append(reversed, line)
		bytesUsed += len(line)
		hasVisibleText = hasVisibleText || line != ""
	}
	out := RecoveryHistorySegment{
		Pane:  pane,
		Lines: make([]string, len(reversed)),
	}
	for index := range reversed {
		out.Lines[len(reversed)-1-index] = reversed[index]
	}
	if !hasVisibleText {
		out.Lines = make([]string, 0)
	}
	if err := validateRecoveryHistorySegment(out, options); err != nil {
		return RecoveryHistorySegment{}, err
	}
	return out, nil
}

// validateRecoveryHistorySegment validates caller-owned literal content only.
// Its deliberate omission of ID permits construction of a zero-ID candidate;
// the file store is the sole issuer and must use
// validateAssignedRecoveryHistorySegment after assignment.
func validateRecoveryHistorySegment(segment RecoveryHistorySegment, options RecoveryStoreOptions) error {
	if err := segment.Pane.validateRecoveryContract(); err != nil {
		return invalidRecoveryStoreValue("history pane", err)
	}
	if segment.Lines == nil {
		return fmt.Errorf("%w: history segment lines must be an array", ErrRecoveryStoreInvalid)
	}
	if len(segment.Lines) > options.MaxHistoryLinesPerSegment {
		return fmt.Errorf("%w: history segment has too many lines", ErrRecoveryStoreInvalid)
	}
	bytesUsed := 0
	for _, line := range segment.Lines {
		if len(line) > options.MaxHistoryLineBytes || !utf8.ValidString(line) {
			return fmt.Errorf("%w: history line exceeds its UTF-8 bound", ErrRecoveryStoreInvalid)
		}
		if sanitizeRecoveryHistoryLine(line, options.MaxHistoryLineBytes) != line {
			return fmt.Errorf("%w: history line contains active control data", ErrRecoveryStoreInvalid)
		}
		bytesUsed += len(line)
		if bytesUsed > options.MaxHistorySegmentBytes {
			return fmt.Errorf("%w: history segment exceeds its byte bound", ErrRecoveryStoreInvalid)
		}
	}
	return nil
}

func validateAssignedRecoveryHistorySegment(segment RecoveryHistorySegment, options RecoveryStoreOptions) error {
	if err := validateRecoveryHistorySegment(segment, options); err != nil {
		return err
	}
	if err := validateRecoveryHistorySegmentID(segment.ID); err != nil {
		return err
	}
	return nil
}

func cloneRecoveryHistorySegment(segment RecoveryHistorySegment) RecoveryHistorySegment {
	out := segment
	if segment.Lines != nil {
		out.Lines = append(make([]string, 0, len(segment.Lines)), segment.Lines...)
	}
	return out
}

type recoveryStoredHistorySegment struct {
	segment    RecoveryHistorySegment
	frameBytes int64
}

func minimumInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
