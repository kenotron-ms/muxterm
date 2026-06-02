package sessiond

// esc is the ASCII escape byte (0x1b) as a string, used to build CSI/OSC escape
// sequences. It lives in production code (not a _test.go file) because both the
// buffer implementations (e.g. serializeGrid in vt.go) and the golden tests
// construct escape sequences from it; keeping a single production-side
// declaration prevents test/production symbol drift.
const esc = "\x1b"
