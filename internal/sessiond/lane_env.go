package sessiond

import (
	"log"
	"sync"

	"github.com/kenotron-ms/muxterm/internal/ai"
)

// THE CREDENTIAL BOUNDARY, IN ONE FILE.
//
// muxterm keeps its own credentials and hands them to the agent processes it
// starts, through their ENVIRONMENT. It does not write into ~/.amplifier/ or
// any other tool's configuration. Three reasons, in order of weight:
//
//  1. It touches no foreign file. keys.env belongs to amplifier, is
//     hand-edited, and is rewritten by amplifier's own writer; a second
//     writer is how a user's file loses its comments or gains a second
//     opinion about the same variable.
//  2. It actually overrides a stale credential. amplifier's KeyManager sets
//     a variable from keys.env only when it is ABSENT from the process
//     environment -- the environment wins. So an injected key repairs the
//     exact failure this feature exists for (a stale keys.env entry that
//     kills every lane at its first turn) from outside, without editing the
//     file that contains the stale entry.
//  3. It survives amplifier changing its configuration format. The env var
//     names are the vendor's contract, not amplifier's.
//
// THE GAP THIS LEAVES, NAMED RATHER THAN HIDDEN: a shell a human opens by
// hand gets NOTHING from here. Injection is applied to panes launched into a
// recognised coding-agent CLI, so `amplifier` typed at a plain muxterm prompt
// sees only what the machine itself provides -- the daemon's inherited
// environment and amplifier's own keys.env. That is deliberate (a credential
// in every interactive shell's environment is a wider exposure than this
// feature needs), it is reported honestly by the onboarding surface, and it
// is the one case where muxterm's stored key does not apply.
//
// It also applies to LOCAL panes only. A lane on a remote machine is started
// by that machine's own daemon from that machine's own environment; nothing
// is forwarded over SSH. See ai.RemoteGapNotice.

// laneCredentials is the process-wide Manager the daemon injects from.
//
// The daemon reads the store at spawn time rather than being handed values by
// the server, because they are separate processes: sessiond outlives any
// particular server run, and a credential saved in the browser must reach the
// very next lane without a daemon restart.
var (
	laneCredentialsOnce sync.Once
	laneCredentials     *ai.Manager
)

func credentialManager() *ai.Manager {
	laneCredentialsOnce.Do(func() {
		laneCredentials = ai.NewManager(ai.DefaultKeyPath())
	})
	return laneCredentials
}

// agentCredentialEnv returns the environment assignments to add for argv.
//
// It returns nil for anything that is not a recognised coding-agent CLI, and
// nil when muxterm has stored no credentials -- on a machine that has never
// been onboarded this function changes nothing about how a pane starts.
func agentCredentialEnv(argv []string) []string {
	if len(argv) == 0 {
		return nil
	}
	name, matched := matchAgent(argv, defaultAgentCatalog())
	if !matched {
		return nil
	}
	env := credentialManager().LaneEnv()
	if len(env) == 0 {
		return nil
	}
	// Variable NAMES only. A value never reaches a log line, here or anywhere
	// else on this path.
	names := make([]string, 0, len(env))
	for _, assignment := range env {
		for i := 0; i < len(assignment); i++ {
			if assignment[i] == '=' {
				names = append(names, assignment[:i])
				break
			}
		}
	}
	log.Printf("sessiond: %s pane starts with muxterm-stored credentials: %v", name, names)
	return env
}
