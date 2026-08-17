#!/bin/sh
# native-ai-tester installer
#
#   curl -fsSL https://raw.githubusercontent.com/danielehrhardt/native-ai-tester/main/install.sh | sh
#
# Options (environment variables):
#   NAT_VERSION=0.2.0   install a specific version instead of the latest
#   NAT_NO_SKILL=1      skip installing the agent skill
#   NAT_NO_DOCTOR=1     skip the toolchain check at the end
#
# The script installs one npm package globally and nothing else. To remove it:
#   npm uninstall -g native-ai-tester && rm -rf ~/.native-ai-tester

set -eu

PACKAGE="native-ai-tester"
VERSION="${NAT_VERSION:-latest}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
warn() { printf '%s!%s   %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '%serror%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- platform

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macOS" ;;
  Linux)  PLATFORM="Linux" ;;
  *)      die "Unsupported platform: $OS. macOS and Linux are supported (Windows via WSL)." ;;
esac

# ---------------------------------------------------------------- node

if ! command -v node >/dev/null 2>&1; then
  say ""
  die "$(cat <<EOF
Node.js 20.10 or newer is required and was not found.

Install it, then re-run this script:
  macOS   brew install node
  Linux   curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts
  or grab an installer from https://nodejs.org
EOF
)"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 10 ]; }; then
  die "Node.js 20.10 or newer is required (found $(node -v)). Upgrade Node and re-run this script."
fi

command -v npm >/dev/null 2>&1 || die "npm was not found alongside Node.js. Reinstall Node.js and try again."

step "Installing $PACKAGE@$VERSION on $PLATFORM (Node $(node -v))"

# ---------------------------------------------------------------- install

# A global install fails with EACCES when the npm prefix is root-owned. Rather
# than silently running sudo, say exactly what to do — an installer that
# escalates privileges without asking is not one you should pipe into a shell.
if ! npm install -g "$PACKAGE@$VERSION" >/tmp/nat-install.$$.log 2>&1; then
  if grep -qi 'EACCES\|permission denied' /tmp/nat-install.$$.log; then
    say ""
    warn "npm cannot write to its global directory ($(npm prefix -g 2>/dev/null || echo 'unknown'))."
    say ""
    say "  Point npm somewhere you own (recommended):"
    say "    mkdir -p ~/.npm-global"
    say "    npm config set prefix ~/.npm-global"
    say "    export PATH=\"\$HOME/.npm-global/bin:\$PATH\"   # add this to your shell profile"
    say ""
    say "  …then re-run this installer. Or install with elevated privileges:"
    say "    sudo npm install -g $PACKAGE@$VERSION"
    say ""
    rm -f /tmp/nat-install.$$.log
    exit 1
  fi
  say ""
  say "$DIM$(tail -20 /tmp/nat-install.$$.log)$RESET"
  rm -f /tmp/nat-install.$$.log
  die "npm install failed. The last lines of its output are above."
fi
rm -f /tmp/nat-install.$$.log

# ---------------------------------------------------------------- PATH

NPM_BIN="$(npm prefix -g 2>/dev/null)/bin"
if ! command -v nat >/dev/null 2>&1; then
  say ""
  warn "$PACKAGE is installed, but \`nat\` is not on your PATH yet."
  say ""
  say "  Add this to your shell profile (~/.zshrc, ~/.bashrc):"
  say "    export PATH=\"$NPM_BIN:\$PATH\""
  say ""
  say "  Then open a new terminal and run: nat doctor"
  exit 0
fi

INSTALLED="$(nat version 2>/dev/null || echo unknown)"
printf '%sInstalled%s %s %s\n' "$GREEN" "$RESET" "$PACKAGE" "$INSTALLED"

# ---------------------------------------------------------------- skill

if [ -z "${NAT_NO_SKILL:-}" ]; then
  if nat skill install --global >/dev/null 2>&1; then
    say "${GREEN}Installed${RESET} the mobile-testing skill for your coding agent (~/.claude/skills)"
  else
    warn "Could not install the agent skill. Run \`nat skill install --global\` yourself if you want it."
  fi
fi

# ---------------------------------------------------------------- doctor

say ""
if [ -z "${NAT_NO_DOCTOR:-}" ]; then
  step "Checking your toolchain"
  nat doctor || true
fi

cat <<EOF

${BOLD}Next steps${RESET}
  nat devices                       list phones, simulators and emulators
  nat devices connect <device-id>   connect (first iOS connect builds the agent)
  nat screen                        read the UI
  nat action tap --x 500 --y 320    act on coordinates from \`nat screen\`

Point your coding agent at the CLI and it drives the device for you.
Docs: https://github.com/danielehrhardt/native-ai-tester
EOF
