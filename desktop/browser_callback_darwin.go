//go:build darwin

package main

/*
#include <stdint.h>
*/
import "C"

//export goBrowserEvalDone
func goBrowserEvalDone(requestID C.ulonglong, value, failure *C.char) {
	browserCallbacks.Lock()
	ch := browserCallbacks.pending[uint64(requestID)]
	delete(browserCallbacks.pending, uint64(requestID))
	browserCallbacks.Unlock()
	if ch != nil {
		ch <- browserEvalResult{value: C.GoString(value), failure: C.GoString(failure)}
	}
}
