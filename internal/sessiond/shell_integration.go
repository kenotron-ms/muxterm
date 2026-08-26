package sessiond

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type paneLaunch struct {
	argv    []string
	env     []string
	source  shellLifecycleSource
	token   string
	cleanup func()
}

func preparePaneLaunch(argv []string) (paneLaunch, error) {
	if len(argv) != 0 {
		return paneLaunch{
			argv:   argv,
			source: shellLifecycleCustom,
		}, nil
	}

	resolved := resolveArgv(nil)
	shell := resolved[0]
	switch filepath.Base(shell) {
	case "bash":
		launch, err := prepareBashLaunch(shell)
		if err != nil {
			// Shell integration is optional instrumentation. Preserve normal
			// pane startup and let missing authenticated evidence classify
			// conservatively instead of making the shell unusable.
			return paneLaunch{argv: resolved, source: shellLifecycleBash}, nil
		}
		return launch, nil
	case "zsh":
		launch, err := prepareZshLaunch(shell)
		if err != nil {
			return paneLaunch{argv: resolved, source: shellLifecycleZsh}, nil
		}
		return launch, nil
	default:
		return paneLaunch{
			argv:   resolved,
			source: shellLifecycleUnsupported,
		}, nil
	}
}

func prepareBashLaunch(shell string) (paneLaunch, error) {
	token, err := newLifecycleToken()
	if err != nil {
		return paneLaunch{}, err
	}
	dir, err := os.MkdirTemp("", "muxterm-bash-integration-*")
	if err != nil {
		return paneLaunch{}, fmt.Errorf("sessiond: create bash integration directory: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(dir) }

	rcPath := filepath.Join(dir, "bashrc")
	if err := os.WriteFile(rcPath, []byte(bashIntegrationScript(token)), 0o600); err != nil {
		cleanup()
		return paneLaunch{}, fmt.Errorf("sessiond: write bash integration: %w", err)
	}

	// Preserve the existing login-then-interactive behavior: the outer login
	// shell sources the normal profile chain and execs an interactive shell. The
	// generated rcfile sources the user's ordinary .bashrc before adding hooks.
	return paneLaunch{
		argv: []string{
			shell,
			"-l",
			"-c",
			"exec " + shellSingleQuote(shell) + " --rcfile " + shellSingleQuote(rcPath) + " -i",
		},
		source:  shellLifecycleBash,
		token:   token,
		cleanup: cleanup,
	}, nil
}

func bashIntegrationScript(token string) string {
	const script = `# Generated per pane by muxterm; the user's dotfiles are not modified.
if [[ -r "${HOME}/.bashrc" ]]; then
	builtin source "${HOME}/.bashrc"
fi

# A pre-existing DEBUG trap is user-owned. Do not replace it: without a safe
# preexec hook this pane remains lifecycle-unknown instead.
__muxterm_prompt_decl_{{TOKEN}}="$(builtin declare -p PROMPT_COMMAND 2>/dev/null || :)"
if [[ -z "$(builtin trap -p DEBUG)" ]] &&
	[[ ! ${__muxterm_prompt_decl_{{TOKEN}}} =~ ^declare[[:space:]]+-[^[:space:]]*r ]]; then
	__muxterm_in_prompt_{{TOKEN}}=0
	__muxterm_prompt_active_{{TOKEN}}=0
	__muxterm_prompt_guard_{{TOKEN}}=0
	__muxterm_status_{{TOKEN}}=0

	__muxterm_capture_status_{{TOKEN}}() {
		__muxterm_status_{{TOKEN}}=$?
		__muxterm_in_prompt_{{TOKEN}}=1
		builtin return "${__muxterm_status_{{TOKEN}}}"
	}

	__muxterm_prompt_ready_{{TOKEN}}() {
		builtin printf '\033]133;D;%d\007' "${__muxterm_status_{{TOKEN}}}"
		if [[ ${__muxterm_prompt_guard_{{TOKEN}}:-0} -eq 1 ]]; then
			builtin printf '\033]133;A;{{TOKEN}}\007'
			__muxterm_prompt_active_{{TOKEN}}=1
		else
			# The command-start hook is no longer ours. Authenticate a malformed
			# lifecycle marker so sessiond fails closed as conflicting evidence.
			builtin printf '\033]133;X;{{TOKEN}}\007'
			__muxterm_prompt_active_{{TOKEN}}=0
		fi
		__muxterm_prompt_guard_{{TOKEN}}=0
		__muxterm_in_prompt_{{TOKEN}}=0
	}

	__muxterm_preexec_{{TOKEN}}() {
		if [[ ${__muxterm_in_prompt_{{TOKEN}}:-0} -eq 1 ]]; then
			if [[ ${BASH_COMMAND} == __muxterm_prompt_ready_{{TOKEN}} ]]; then
				# Reaching the final prompt hook through this DEBUG trap proves
				# command-start ownership is still installed.
				__muxterm_prompt_guard_{{TOKEN}}=1
			fi
			builtin return 0
		fi
		if [[ ${__muxterm_in_prompt_{{TOKEN}}:-0} -eq 0 &&
			${__muxterm_prompt_active_{{TOKEN}}:-0} -eq 1 ]]; then
			__muxterm_prompt_active_{{TOKEN}}=0
			builtin printf '\033]133;C;{{TOKEN}}\007'
		fi
	}

	if [[ ${__muxterm_prompt_decl_{{TOKEN}}} =~ ^declare[[:space:]]+-[^[:space:]]*a ]]; then
		PROMPT_COMMAND=(
			__muxterm_capture_status_{{TOKEN}}
			"${PROMPT_COMMAND[@]}"
			__muxterm_prompt_ready_{{TOKEN}}
		)
	else
		PROMPT_COMMAND='__muxterm_capture_status_{{TOKEN}}'$'\n'"${PROMPT_COMMAND-}"$'\n''__muxterm_prompt_ready_{{TOKEN}}'
	fi
	builtin trap '__muxterm_preexec_{{TOKEN}}' DEBUG
fi
`
	return strings.ReplaceAll(script, "{{TOKEN}}", token)
}

func prepareZshLaunch(shell string) (paneLaunch, error) {
	token, err := newLifecycleToken()
	if err != nil {
		return paneLaunch{}, err
	}
	dir, err := os.MkdirTemp("", "muxterm-zsh-integration-*")
	if err != nil {
		return paneLaunch{}, fmt.Errorf("sessiond: create zsh integration directory: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(dir) }

	userZDOTDIR, userZDOTDIRSet := os.LookupEnv("ZDOTDIR")

	files := map[string]string{
		".zshenv":   zshFirstStartupWrapper(token, dir, userZDOTDIR, userZDOTDIRSet, ".zshenv"),
		".zprofile": zshStartupWrapper(token, dir, ".zprofile", false),
		".zshrc":    zshStartupWrapper(token, dir, ".zshrc", false),
		".zlogin":   zshStartupWrapper(token, dir, ".zlogin", true),
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			cleanup()
			return paneLaunch{}, fmt.Errorf("sessiond: write zsh integration %s: %w", name, err)
		}
	}

	// ZDOTDIR redirects only this child shell's startup lookup. Each generated
	// file sources the user's corresponding file and carries forward any
	// user-selected ZDOTDIR before the final wrapper installs lifecycle hooks.
	return paneLaunch{
		argv:    []string{shell, "-l"},
		env:     []string{"ZDOTDIR=" + dir},
		source:  shellLifecycleZsh,
		token:   token,
		cleanup: cleanup,
	}, nil
}

func zshFirstStartupWrapper(token, integrationDir, userZDOTDIR string, userZDOTDIRSet bool, filename string) string {
	stateSetVar := "__muxterm_user_zdotdir_set_" + token
	stateValueVar := "__muxterm_user_zdotdir_value_" + token
	userDirVar := "__muxterm_user_dir_" + token
	restoreFunc := "__muxterm_restore_zdotdir_" + token
	captureFunc := "__muxterm_capture_zdotdir_" + token
	stateSet := 0
	if userZDOTDIRSet {
		stateSet = 1
	}
	return fmt.Sprintf(`# Generated per pane by muxterm; the user's dotfiles are not modified.
builtin typeset -gi %s=%d
builtin typeset -g %s=%s

%s() {
	if (( %s )); then
		export ZDOTDIR="${%s}"
	else
		unset ZDOTDIR
	fi
}

%s() {
	if (( ${+ZDOTDIR} )); then
		%s=1
		%s="${ZDOTDIR}"
	else
		%s=0
		%s=''
	fi
}

%s
if (( %s )); then
	builtin typeset -g %s="${%s}"
else
	builtin typeset -g %s="${HOME}"
fi
if [[ -r "${%s}/%s" ]]; then
	builtin source "${%s}/%s"
fi
%s
if [[ -o RCS ]]; then
	export ZDOTDIR=%s
else
	%s
fi
`,
		stateSetVar, stateSet,
		stateValueVar, shellSingleQuote(userZDOTDIR),
		restoreFunc, stateSetVar, stateValueVar,
		captureFunc, stateSetVar, stateValueVar, stateSetVar, stateValueVar,
		restoreFunc,
		stateSetVar, userDirVar, stateValueVar, userDirVar,
		userDirVar, filename, userDirVar, filename,
		captureFunc,
		shellSingleQuote(integrationDir),
		restoreFunc,
	)
}

func zshStartupWrapper(token, integrationDir, filename string, final bool) string {
	stateSetVar := "__muxterm_user_zdotdir_set_" + token
	stateValueVar := "__muxterm_user_zdotdir_value_" + token
	userDirVar := "__muxterm_user_dir_" + token
	restoreFunc := "__muxterm_restore_zdotdir_" + token
	captureFunc := "__muxterm_capture_zdotdir_" + token
	var tail string
	if final {
		tail = restoreFunc + "\n" + zshIntegrationScript(token)
	} else {
		tail = fmt.Sprintf(`if [[ -o RCS ]]; then
	export ZDOTDIR=%s
else
	%s
fi
`, shellSingleQuote(integrationDir), restoreFunc)
	}
	return fmt.Sprintf(`# Generated per pane by muxterm; the user's dotfiles are not modified.
%s
if (( %s )); then
	builtin typeset -g %s="${%s}"
else
	builtin typeset -g %s="${HOME}"
fi
if [[ -r "${%s}/%s" ]]; then
	builtin source "${%s}/%s"
fi
%s
%s`,
		restoreFunc,
		stateSetVar, userDirVar, stateValueVar, userDirVar,
		userDirVar, filename, userDirVar, filename,
		captureFunc,
		tail,
	)
}

func zshIntegrationScript(token string) string {
	const script = `
__muxterm_capture_status_{{TOKEN}}() {
	builtin typeset -g __muxterm_status_{{TOKEN}}=$?
	builtin return "${__muxterm_status_{{TOKEN}}}"
}

__muxterm_prompt_ready_{{TOKEN}}() {
	builtin printf '\033]133;D;%d\007' "${__muxterm_status_{{TOKEN}}:-0}"
	if (( ${preexec_functions[(Ie)__muxterm_preexec_{{TOKEN}}]} )) &&
		(( ${+functions[__muxterm_preexec_{{TOKEN}}]} )); then
		builtin printf '\033]133;A;{{TOKEN}}\007'
	else
		builtin printf '\033]133;X;{{TOKEN}}\007'
	fi
}

__muxterm_preexec_{{TOKEN}}() {
	builtin printf '\033]133;C;{{TOKEN}}\007'
}

__muxterm_precmd_type_{{TOKEN}}="${(t)precmd_functions}"
__muxterm_preexec_type_{{TOKEN}}="${(t)preexec_functions}"
if [[ "${__muxterm_precmd_type_{{TOKEN}}}" != *readonly* &&
	"${__muxterm_preexec_type_{{TOKEN}}}" != *readonly* ]]; then
	builtin typeset -ga precmd_functions
	builtin typeset -ga preexec_functions

	# Install and verify command-start ownership before enabling prompt-ready
	# markers. Partial hook installation can therefore never classify idle.
	preexec_functions=(
		__muxterm_preexec_{{TOKEN}}
		"${preexec_functions[@]}"
	)
	if (( ${preexec_functions[(Ie)__muxterm_preexec_{{TOKEN}}]} )); then
		precmd_functions=(
			__muxterm_capture_status_{{TOKEN}}
			"${precmd_functions[@]}"
			__muxterm_prompt_ready_{{TOKEN}}
		)
	fi
fi
`
	return strings.ReplaceAll(script, "{{TOKEN}}", token)
}

func newLifecycleToken() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("sessiond: generate shell lifecycle token: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
