//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#include <stdlib.h>

static char* bundleVersion(void) {
    NSString* version = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    return strdup(version == nil ? "dev" : version.UTF8String);
}
*/
import "C"

import "unsafe"

func desktopBundleVersion() string {
	value := C.bundleVersion()
	defer C.free(unsafe.Pointer(value))
	return C.GoString(value)
}
