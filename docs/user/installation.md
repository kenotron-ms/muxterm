# Set up Muxterm

Set up Muxterm on the computer where you keep your projects. You’ll also need access to one supported AI agent to start a chat. If you already use Codex or Claude Code, start there.

## Install on macOS

On an Apple silicon Mac, open [the latest release](https://github.com/kenotron-ms/muxterm/releases/latest), expand **Assets** if needed, and download the file ending in `macos-arm64.dmg`. Open the disk image, move Muxterm to Applications, and open it from there.

If you use Homebrew, you can install and open Muxterm from Terminal:

```sh
brew install kenotron-ms/tap/muxterm
muxterm
```

## Install on Linux

Open Terminal and run the following. Muxterm installs under your home directory. The final command opens the app in your browser.

```sh
curl -fsSL https://raw.githubusercontent.com/kenotron-ms/muxterm/main/install.sh | bash
muxterm
```

You can [read the installer](../../install.sh) before running it. For version upgrades, running Muxterm in the background, or other installation options, see [installation and updates](../guides/installation-and-updates.md).

## Connect your first agent
Codex and Claude Code chats also require Node.js 22 or later and npm. If they’re missing, follow the prompts in agent settings. You’ll need to install the agent itself and sign in with your account.

1. Open **New chat**. If no agent is available, select **Open agent settings**. If the picker shows an agent already, choose it to get started or use **Add or manage agents…** to see other options.
2. Choose the agent you use and follow its setup and sign-in instructions. Your agent account supplies access to its models.
3. Return to **New chat**. If you just installed an agent and it isn’t listed, choose **Refresh installed agents**.

Once you see an agent in the picker, [start your first chat](first-chat.md).
