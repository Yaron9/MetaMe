#!/usr/bin/env bash
set -e

# MetaMe Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.sh | bash

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
CYAN='\033[36m'
RESET='\033[0m'

MIN_NODE_VERSION=18

info()  { echo -e "${CYAN}▸${RESET} $1"; }
ok()    { echo -e "${GREEN}✓${RESET} $1"; }
warn()  { echo -e "${YELLOW}⚠${RESET} $1"; }
fail()  { echo -e "${RED}✗${RESET} $1"; exit 1; }

echo ""
echo -e "${BOLD}  MetaMe — Your AI Shadow${RESET}"
echo -e "${DIM}  One command to install everything.${RESET}"
echo ""

# -----------------------------------------------------------
# 1. Detect OS
# -----------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
info "System: $OS $ARCH"

# -----------------------------------------------------------
# 2. Check / Install Node.js
# -----------------------------------------------------------
install_node() {
  info "Installing Node.js..."
  if [ "$OS" = "Darwin" ]; then
    if command -v brew &>/dev/null; then
      info "Installing via Homebrew..."
      brew install node
    else
      info "Installing Homebrew first..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      # Add brew to PATH for Apple Silicon
      if [ "$ARCH" = "arm64" ] && [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
      fi
      brew install node
    fi
  elif [ "$OS" = "Linux" ]; then
    if command -v apt-get &>/dev/null; then
      info "Installing via apt (NodeSource)..."
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
      info "Installing via dnf (NodeSource)..."
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo dnf install -y nodejs
    elif command -v pacman &>/dev/null; then
      info "Installing via pacman..."
      sudo pacman -Sy --noconfirm nodejs npm
    else
      fail "Unsupported Linux distro. Install Node.js >= $MIN_NODE_VERSION manually: https://nodejs.org"
    fi
  else
    fail "Unsupported OS: $OS. Install Node.js >= $MIN_NODE_VERSION manually: https://nodejs.org"
  fi
}

if command -v node &>/dev/null; then
  NODE_VER="$(node -v | sed 's/v//' | cut -d. -f1)"
  if [ "$NODE_VER" -ge "$MIN_NODE_VERSION" ]; then
    ok "Node.js $(node -v) found"
  else
    warn "Node.js $(node -v) is too old (need >= $MIN_NODE_VERSION)"
    install_node
  fi
else
  warn "Node.js not found"
  install_node
fi

# Verify node is available now
command -v node &>/dev/null || fail "Node.js installation failed. Install manually: https://nodejs.org"
ok "Node.js $(node -v) ready"

# -----------------------------------------------------------
# 3. Install Claude Code
# -----------------------------------------------------------
if command -v claude &>/dev/null; then
  ok "Claude Code already installed ($(claude -v 2>/dev/null || echo 'unknown version'))"
else
  info "Installing Claude Code..."
  npm install -g @anthropic-ai/claude-code
  command -v claude &>/dev/null || fail "Claude Code installation failed"
  ok "Claude Code installed"
fi

# -----------------------------------------------------------
# 4. Install MetaMe
# -----------------------------------------------------------
if command -v metame &>/dev/null; then
  CURRENT_VER="$(metame -v 2>/dev/null || echo '')"
  info "MetaMe already installed${CURRENT_VER:+ ($CURRENT_VER)}, upgrading..."
fi

npm install -g metame-cli
command -v metame &>/dev/null || fail "MetaMe installation failed"
ok "MetaMe $(metame -v 2>/dev/null || echo '') installed"

# -----------------------------------------------------------
# 5. Done
# -----------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}  ✅ Installation complete!${RESET}"
echo ""
echo -e "  Run ${CYAN}metame${RESET} to start."
echo -e "  First launch will guide you through setup."
echo ""
