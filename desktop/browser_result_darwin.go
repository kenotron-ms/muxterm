//go:build darwin

package main

/*
#include <stdint.h>
*/
import "C"

import (
	"errors"
	"sync"
	"sync/atomic"
)

type browserResult struct {
	value string
	err   error
}

var browserResults = struct {
	sync.Mutex
	next    atomic.Uint64
	waiters map[uint64]chan browserResult
}{waiters: make(map[uint64]chan browserResult)}

func browserResultSubscribe() (uint64, <-chan browserResult) {
	id := browserResults.next.Add(1)
	response := make(chan browserResult, 1)
	browserResults.Lock()
	browserResults.waiters[id] = response
	browserResults.Unlock()
	return id, response
}

func browserResultCancel(id uint64) {
	browserResults.Lock()
	delete(browserResults.waiters, id)
	browserResults.Unlock()
}

//export muxtermBrowserResult
func muxtermBrowserResult(requestID C.uint64_t, value *C.char, failure *C.char) {
	id := uint64(requestID)
	browserResults.Lock()
	response := browserResults.waiters[id]
	delete(browserResults.waiters, id)
	browserResults.Unlock()
	if response == nil {
		return
	}
	result := browserResult{}
	if value != nil {
		result.value = C.GoString(value)
	}
	if failure != nil {
		result.err = errors.New(C.GoString(failure))
	}
	response <- result
}
