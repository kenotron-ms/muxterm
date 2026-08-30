//go:build unix

package sessiond

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"path/filepath"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	recoverySocketDialTimeout = 200 * time.Millisecond
	recoveryRequestDeadline   = 750 * time.Millisecond
	recoveryJSONMaxDepth      = 64
)

// ErrRecoveryUnavailable reports that the dedicated owner-local recovery
// endpoint is absent or unsupported. Failures after a connection is established
// never wrap this error.
var ErrRecoveryUnavailable = errors.New("recovery socket unavailable")

// RecoverySocketClient is a sequential, connection-scoped client for privileged
// owner-local recovery requests. A protocol or I/O fault permanently poisons
// and closes the connection.
type RecoverySocketClient struct {
	conn     net.Conn
	nextCID  uint64
	poisoned bool
	closed   bool
}

// DialRecoverySocket opens only the dedicated owner-local recovery endpoint.
func DialRecoverySocket() (*RecoverySocketClient, error) {
	sessionSocket, err := SocketPath()
	if err != nil {
		return nil, errors.New("recovery socket path resolution failed")
	}
	path, err := RecoverySocketPath(sessionSocket)
	if err != nil {
		return nil, errors.New("recovery socket path resolution failed")
	}
	return dialRecoverySocket(path)
}

func dialRecoverySocket(path string) (*RecoverySocketClient, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("recovery socket path is invalid")
	}

	conn, err := net.DialTimeout("unix", path, recoverySocketDialTimeout)
	if err != nil {
		if recoveryEndpointUnavailable(err) {
			return nil, fmt.Errorf("recovery socket dial: %w", ErrRecoveryUnavailable)
		}
		return nil, errors.New("recovery socket dial failed")
	}
	return &RecoverySocketClient{conn: conn, nextCID: 1}, nil
}

func recoveryEndpointUnavailable(err error) bool {
	return errors.Is(err, syscall.ENOENT) ||
		errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ENOTSOCK)
}

// Close closes the dedicated connection. It is safe to call more than once.
func (c *RecoverySocketClient) Close() error {
	if c == nil || c.closed {
		return nil
	}
	c.closed = true
	conn := c.conn
	c.conn = nil
	if conn != nil {
		if err := conn.Close(); err != nil {
			return errors.New("recovery socket close failed")
		}
	}
	return nil
}

// BootstrapLifecycle obtains one daemon-issued lifecycle lease on this
// connection.
func (c *RecoverySocketClient) BootstrapLifecycle(
	request RecoveryLifecycleBootstrapRequest,
) (RecoveryLifecycleBootstrapResult, error) {
	if err := c.validateRequest(request); err != nil {
		return RecoveryLifecycleBootstrapResult{}, err
	}
	cid, err := c.mintCID()
	if err != nil {
		return RecoveryLifecycleBootstrapResult{}, err
	}

	reply, err := c.ownerLocalReply(&OwnerLocalRecoveryMessage{
		Type:               TypeLifecycleBootstrap,
		CID:                cid,
		LifecycleBootstrap: &request,
	}, TypeLifecycleBootstrapResult, cid)
	if err != nil {
		return RecoveryLifecycleBootstrapResult{}, err
	}
	if reply.LifecycleBootstrapResult == nil {
		return RecoveryLifecycleBootstrapResult{}, c.poison("reply payload invalid")
	}
	result := *reply.LifecycleBootstrapResult
	if err := ValidateRecoveryContract(result); err != nil {
		return RecoveryLifecycleBootstrapResult{}, c.poison("result validation failed")
	}
	return result, nil
}

// CaptureLifecycle submits one lifecycle capture using a lease obtained on this
// same live connection.
func (c *RecoverySocketClient) CaptureLifecycle(
	request PrivilegedLifecycleCaptureRequest,
) (PrivilegedLifecycleCaptureOutcome, error) {
	if err := c.validateRequest(request); err != nil {
		return PrivilegedLifecycleCaptureOutcome{}, err
	}
	cid, err := c.mintCID()
	if err != nil {
		return PrivilegedLifecycleCaptureOutcome{}, err
	}

	reply, err := c.ownerLocalReply(&OwnerLocalRecoveryMessage{
		Type:             TypeLifecycleCapture,
		CID:              cid,
		LifecycleCapture: &request,
	}, TypeLifecycleCaptureOutcome, cid)
	if err != nil {
		return PrivilegedLifecycleCaptureOutcome{}, err
	}
	if reply.LifecycleOutcome == nil {
		return PrivilegedLifecycleCaptureOutcome{}, c.poison("reply payload invalid")
	}
	result := *reply.LifecycleOutcome
	if err := ValidateRecoveryContract(result); err != nil {
		return PrivilegedLifecycleCaptureOutcome{}, c.poison("result validation failed")
	}
	return result, nil
}

// BindSession submits an exact owner-local session binding for daemon
// validation.
func (c *RecoverySocketClient) BindSession(
	request RecoveryExplicitBindRequest,
) (RecoveryExplicitBindResult, error) {
	if err := c.validateRequest(request); err != nil {
		return RecoveryExplicitBindResult{}, err
	}
	cid, err := c.mintCID()
	if err != nil {
		return RecoveryExplicitBindResult{}, err
	}

	reply, err := c.ownerLocalReply(&OwnerLocalRecoveryMessage{
		Type:         TypeExplicitBind,
		CID:          cid,
		ExplicitBind: &request,
	}, TypeExplicitBindResult, cid)
	if err != nil {
		return RecoveryExplicitBindResult{}, err
	}
	if reply.ExplicitBindResult == nil {
		return RecoveryExplicitBindResult{}, c.poison("reply payload invalid")
	}
	result := *reply.ExplicitBindResult
	if err := ValidateRecoveryContract(result); err != nil {
		return RecoveryExplicitBindResult{}, c.poison("result validation failed")
	}
	return result, nil
}

// PlanReplacement asks sessiond to create one bounded controlled-replacement
// plan.
func (c *RecoverySocketClient) PlanReplacement(
	request PrivilegedReplacementPlanRequest,
) (PrivilegedReplacementPlanResult, error) {
	if err := c.validateRequest(request); err != nil {
		return PrivilegedReplacementPlanResult{}, err
	}
	cid, err := c.mintCID()
	if err != nil {
		return PrivilegedReplacementPlanResult{}, err
	}

	reply, err := c.ownerLocalReply(&OwnerLocalRecoveryMessage{
		Type:            TypeReplacementPlan,
		CID:             cid,
		ReplacementPlan: &request,
	}, TypeReplacementPlanResult, cid)
	if err != nil {
		return PrivilegedReplacementPlanResult{}, err
	}
	if reply.ReplacementResult == nil {
		return PrivilegedReplacementPlanResult{}, c.poison("reply payload invalid")
	}
	result := *reply.ReplacementResult
	if err := ValidateRecoveryContract(result); err != nil {
		return PrivilegedReplacementPlanResult{}, c.poison("result validation failed")
	}
	return result, nil
}

// CommitReplacement consumes one replacement plan. Its result is deliberately
// decoded through the browser-safe redacted recovery decoder.
func (c *RecoverySocketClient) CommitReplacement(
	request PrivilegedReplacementCommitRequest,
) (RecoveryReplacementOutcome, error) {
	if err := c.validateRequest(request); err != nil {
		return RecoveryReplacementOutcome{}, err
	}
	cid, err := c.mintCID()
	if err != nil {
		return RecoveryReplacementOutcome{}, err
	}

	payload, err := c.exchange(&OwnerLocalRecoveryMessage{
		Type:              TypeReplacementCommit,
		CID:               cid,
		ReplacementCommit: &request,
	})
	if err != nil {
		return RecoveryReplacementOutcome{}, err
	}
	reply, err := DecodeBrowserRecoveryMessage(payload)
	if err != nil {
		return RecoveryReplacementOutcome{}, c.poison("reply decoding failed")
	}
	if reply == nil || reply.CID == 0 || reply.CID != cid ||
		reply.Type != TypeReplacementOutcome || reply.ReplacementOutcome == nil {
		return RecoveryReplacementOutcome{}, c.poison("reply correlation failed")
	}
	result := *reply.ReplacementOutcome
	if err := ValidateRecoveryContract(result); err != nil {
		return RecoveryReplacementOutcome{}, c.poison("result validation failed")
	}
	return result, nil
}

func (c *RecoverySocketClient) validateRequest(request any) error {
	if err := ValidateRecoveryContract(request); err != nil {
		return c.poison("request validation failed")
	}
	return nil
}

func (c *RecoverySocketClient) mintCID() (uint64, error) {
	if err := c.usable(); err != nil {
		return 0, err
	}
	if c.nextCID == 0 || c.nextCID == math.MaxUint64 {
		return 0, c.poison("correlation exhausted")
	}
	cid := c.nextCID
	c.nextCID++
	return cid, nil
}

func (c *RecoverySocketClient) usable() error {
	switch {
	case c == nil:
		return errors.New("recovery socket client is nil")
	case c.poisoned:
		return errors.New("recovery socket client is poisoned")
	case c.closed || c.conn == nil:
		return errors.New("recovery socket client is closed")
	default:
		return nil
	}
}

func (c *RecoverySocketClient) poison(category string) error {
	if c != nil {
		c.poisoned = true
		c.closed = true
		if c.conn != nil {
			_ = c.conn.Close()
			c.conn = nil
		}
	}
	return errors.New("recovery socket " + category)
}

func (c *RecoverySocketClient) ownerLocalReply(
	request *OwnerLocalRecoveryMessage,
	expectedType string,
	expectedCID uint64,
) (*OwnerLocalRecoveryMessage, error) {
	payload, err := c.exchange(request)
	if err != nil {
		return nil, err
	}
	reply, err := DecodeOwnerLocalRecoveryControl(payload)
	if err != nil {
		return nil, c.poison("reply decoding failed")
	}
	if reply == nil || reply.CID == 0 || reply.CID != expectedCID || reply.Type != expectedType {
		return nil, c.poison("reply correlation failed")
	}
	return reply, nil
}

func (c *RecoverySocketClient) exchange(request *OwnerLocalRecoveryMessage) ([]byte, error) {
	if err := c.usable(); err != nil {
		return nil, err
	}
	if err := ValidateRecoveryContract(request); err != nil {
		return nil, c.poison("request envelope invalid")
	}
	if err := c.conn.SetDeadline(time.Now().Add(recoveryRequestDeadline)); err != nil {
		return nil, c.poison("deadline failed")
	}
	if err := WriteOwnerLocalRecoveryControl(fullWriter{writer: c.conn}, request); err != nil {
		return nil, c.poison("write failed")
	}
	payload, err := readRecoveryFrame(c.conn)
	if err != nil {
		return nil, c.poison("read failed")
	}
	if err := validateRecoveryReplyJSON(payload); err != nil {
		return nil, c.poison("reply JSON invalid")
	}
	return payload, nil
}

type fullWriter struct {
	writer io.Writer
}

func (w fullWriter) Write(data []byte) (int, error) {
	written := 0
	for written < len(data) {
		n, err := w.writer.Write(data[written:])
		if n < 0 || n > len(data)-written {
			return written, io.ErrShortWrite
		}
		written += n
		if err != nil {
			return written, err
		}
		if n == 0 {
			return written, io.ErrNoProgress
		}
	}
	return written, nil
}

func readRecoveryFrame(reader io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	total := binary.BigEndian.Uint32(header[:])
	if total < 1 || total > uint32(1+RecoveryMaxContractBytes) {
		return nil, errors.New("recovery frame length invalid")
	}

	var kind [1]byte
	if _, err := io.ReadFull(reader, kind[:]); err != nil {
		return nil, err
	}
	if kind[0] != FrameControl {
		return nil, errors.New("recovery frame kind invalid")
	}

	payload := make([]byte, int(total)-1)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func validateRecoveryReplyJSON(data []byte) error {
	if !utf8.Valid(data) {
		return errors.New("recovery reply is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := scanRecoveryJSONValue(decoder, 0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return errors.New("recovery reply has trailing JSON value")
		}
		return errors.New("recovery reply has malformed trailing data")
	}
	return nil
}

func scanRecoveryJSONValue(decoder *json.Decoder, depth int) error {
	token, err := decoder.Token()
	if err != nil {
		return errors.New("recovery reply JSON is malformed")
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	if delimiter != '{' && delimiter != '[' {
		return errors.New("recovery reply JSON has unexpected delimiter")
	}
	if depth >= recoveryJSONMaxDepth {
		return errors.New("recovery reply JSON exceeds nesting limit")
	}

	switch delimiter {
	case '{':
		keys := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return errors.New("recovery reply object is malformed")
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("recovery reply object key is invalid")
			}
			if _, duplicate := keys[key]; duplicate {
				return errors.New("recovery reply contains duplicate object key")
			}
			keys[key] = struct{}{}
			if err := scanRecoveryJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		token, err = decoder.Token()
		if err != nil || token != json.Delim('}') {
			return errors.New("recovery reply object is unterminated")
		}
	case '[':
		for decoder.More() {
			if err := scanRecoveryJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		token, err = decoder.Token()
		if err != nil || token != json.Delim(']') {
			return errors.New("recovery reply array is unterminated")
		}
	}
	return nil
}
