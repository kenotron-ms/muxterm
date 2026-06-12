package sessiond

import (
	"testing"
)

func TestScanOSC133(t *testing.T) {
	bel := "\x07"
	esc := "\x1b"
	st := "\x1b\\"

	tests := []struct {
		name     string
		data     string
		wantCode int
		wantOK   bool
	}{
		{
			name:     "BEL terminator no exit code",
			data:     esc + "]133;D" + bel,
			wantCode: 0,
			wantOK:   true,
		},
		{
			name:     "ST terminator no exit code",
			data:     esc + "]133;D" + st,
			wantCode: 0,
			wantOK:   true,
		},
		{
			name:     "BEL exit code 0",
			data:     esc + "]133;D;0" + bel,
			wantCode: 0,
			wantOK:   true,
		},
		{
			name:     "BEL exit code 1",
			data:     esc + "]133;D;1" + bel,
			wantCode: 1,
			wantOK:   true,
		},
		{
			name:     "BEL exit code 127",
			data:     esc + "]133;D;127" + bel,
			wantCode: 127,
			wantOK:   true,
		},
		{
			name:     "ST exit code 2",
			data:     esc + "]133;D;2" + st,
			wantCode: 2,
			wantOK:   true,
		},
		{
			name:     "mid-buffer sequence with surrounding output",
			data:     "output\r\n" + esc + "]133;D;1" + bel + "next",
			wantCode: 1,
			wantOK:   true,
		},
		{
			name:     "no OSC 133",
			data:     "just some terminal output\r\n",
			wantCode: 0,
			wantOK:   false,
		},
		{
			name:     "other marker A",
			data:     esc + "]133;A" + bel,
			wantCode: 0,
			wantOK:   false,
		},
		{
			name:     "partial sequence at end no terminator",
			data:     esc + "]133;D;1",
			wantCode: 0,
			wantOK:   false,
		},
		{
			name:     "empty input",
			data:     "",
			wantCode: 0,
			wantOK:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			code, ok := scanOSC133([]byte(tt.data))
			if ok != tt.wantOK {
				t.Errorf("scanOSC133(%q) found=%v, want %v", tt.data, ok, tt.wantOK)
			}
			if code != tt.wantCode {
				t.Errorf("scanOSC133(%q) code=%d, want %d", tt.data, code, tt.wantCode)
			}
		})
	}
}
