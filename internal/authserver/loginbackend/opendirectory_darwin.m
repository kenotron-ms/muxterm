//go:build darwin && cgo

#import <Foundation/Foundation.h>
#import <OpenDirectory/OpenDirectory.h>

// Restrict the lookup to the local directory. The caller supplies the account
// running muxterm, so a similarly named network account must never match.
int muxtermVerifyLocalPassword(const char *username, const char *password) {
    @autoreleasepool {
        NSString *name = [NSString stringWithUTF8String:username];
        NSString *secret = [NSString stringWithUTF8String:password];
        if (name == nil || secret == nil) {
            return 0;
        }

        NSError *error = nil;
        ODNode *node = [ODNode nodeWithSession:[ODSession defaultSession]
                                            type:kODNodeTypeLocalNodes
                                           error:&error];
        if (node == nil) {
            return 0;
        }
        ODRecord *record = [node recordWithRecordType:kODRecordTypeUsers
                                                name:name
                                          attributes:nil
                                               error:&error];
        if (record == nil) {
            return 0;
        }
        return [record verifyPassword:secret error:&error] ? 1 : 0;
    }
}
