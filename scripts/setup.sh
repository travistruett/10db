#!/usr/bin/env bash
# Installs the pinned tools and the dependencies on a new machine. Safe to rerun.
# INSTALL_RUST=yes installs the pinned Rust toolchain without asking, INSTALL_RUST=no skips it.
# Unset, it asks when stdin is a terminal and skips otherwise. The question comes first, before the
# long installs. Runs on macOS /bin/bash 3.2.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" == "Darwin" ]] && ! xcode-select -p > /dev/null 2>&1; then
  echo "The Xcode Command Line Tools are missing (git, clang and the linker come with them)."
  echo "Install them with: xcode-select --install"
  echo "Then rerun make setup."
  exit 1
fi

if ! command -v mise > /dev/null 2>&1; then
  echo "Install mise first (brew install mise), then activate it in your shell."
  exit 1
fi

# Settle the Rust question first, so the long unattended installs below can run without a prompt.
skip_message="Skipping Rust: the desktop shell won't build and make gate reports rust skipped.
Install it later with: INSTALL_RUST=yes make setup   (or: mise install rust)"

case "${INSTALL_RUST:-}" in
  yes | no | "") ;;
  *)
    echo "INSTALL_RUST must be yes or no, not '${INSTALL_RUST}'."
    exit 1
    ;;
esac

want_rust=no
# Only the mise-managed toolchain counts: a cargo from Homebrew or rustup ignores
# rust-toolchain.toml, so it can't build the pinned shell.
if mise which cargo > /dev/null 2>&1; then
  echo "Rust is already installed."
else
  case "${INSTALL_RUST:-}" in
    yes) want_rust=yes ;;
    no) echo "$skip_message" ;;
    "")
      if [[ -t 0 ]]; then
        read -r -p "The pinned Rust toolchain is not installed (about 1 GB). Install it with mise? [y/N] " answer
        if [[ "$answer" == "y" ]]; then want_rust=yes; else echo "$skip_message"; fi
      else
        echo "INSTALL_RUST is not set and there is no terminal to ask."
        echo "$skip_message"
      fi
      ;;
  esac
fi

mise install node pnpm gitleaks actionlint zizmor cargo-deny
if [[ "$want_rust" == "yes" ]]; then
  mise install rust
fi
# mise exec puts the pinned pnpm first on PATH, so a Homebrew pnpm is never used.
mise exec -- pnpm install --frozen-lockfile
# The e2e gate step drives the UI in Playwright's WebKit; the browser lives in Playwright's own cache.
mise exec -- pnpm --filter @10db/desktop exec playwright install webkit
