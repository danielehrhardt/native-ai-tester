# native-ai-tester

**Automated mobile testing for apps and games.** Drive a real iOS or Android device from
your terminal — or let your coding agent drive it for you. No locators, no page objects,
no SDK in your app.

```bash
nat screen                              # inspect: read the UI as an element tree
nat action tap --x 500 --y 320          # act: one gesture
nat screen                              # verify: confirm the state changed
```

That loop is the whole tool. It is small enough for Claude Code, Codex or Cursor to run on
every step of a test, and explicit enough that a failing run can be replayed by hand.

---

## Why this exists

Locator-based tools (Appium, Maestro, XCUITest) need something in the app to point at. That
breaks down exactly where mobile gets hard:

| | Locator-based | native-ai-tester |
|---|:---:|:---:|
| Native iOS & Android (Swift, Kotlin) | ✅ | ✅ |
| React Native, Flutter, KMP | partial | ✅ |
| WebViews, canvases, maps, ads | ❌ | ✅ |
| Games — Unity, Unreal, Godot | ❌ | ✅ |
| Permission dialogs & system alerts | flaky | ✅ |
| Plain-English steps, no code | ❌ | ✅ |
| Real devices, not just simulators | partial | ✅ |

It works from the accessibility tree where there is one, and from the screen itself where
there isn't. Nothing is added to your app.

**No account, no server, no vendor.** The device CLI, the element tree and description
matching all run locally and cost nothing. A model is optional, and it is *your* model —
Anthropic, OpenAI, or something on localhost.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/native-ai-tester/native-ai-tester/main/install.sh | sh
```

Or with npm directly:

```bash
npm install -g native-ai-tester
```

Requires Node 20.10+. Then:

```bash
nat doctor          # checks your toolchain and says exactly what is missing
```

`nat update` upgrades in place; a background check tells you when a release is out (turn
it off with `nat config set update.autoCheck false`).

### What you need

**iOS** — macOS with Xcode 16+ and its command line tools. For a real device: iOS 15+,
trusted and unlocked, Developer Mode on, and an Apple Developer account for signing.
Simulators need no account. Run `nat setup ios` once and it downloads WebDriverAgent and
picks up your team id.

**Android** — the platform tools (`brew install --cask android-platform-tools`) and a
device with USB debugging on, or an emulator. Nothing else; adb does all of it.

---

## Quick start

```bash
nat devices                                     # phones, simulators, emulators
nat devices connect 00008140-000958E91160801C   # connect once — later commands reuse it

nat install ./build/MyApp.app                   # or .ipa / .apk
nat action activate-app --bundle-id com.example.app

nat screen
```

`nat screen` prints one line per element:

```
ios · 00008140-…801C · com.example.app · 402x874pt · 34/211 elements
coordinates are relative 0-1000 (x,y = tap point)
[0] other "Sign in" @500,500 1000x1000
  [0.0] field placeholder="Email" #login.email @500,420 760x44
  [0.1] secure-field placeholder="Password" @500,490 760x44
  [0.2] button "Sign in" @500,806 760x52
```

`@500,806` is where to tap. **Coordinates are relative — 0 to 1000 on both axes**, so the
same step works on an iPhone SE, an iPhone 17 Pro Max and an iPad.

The header says `34/211`: the raw platform tree had 211 nodes, 34 survived cleaning. Since
an agent reads the screen on every step, that reduction is most of what a test run costs.

| Screen read | Tokens | vs `nat screen` |
|---|---:|---:|
| `nat screen` | ~800 | 1× |
| `nat screenshot` | ~1,500 | ~2× |
| `nat screen --full` | ~5,600 | ~7× |

---

## Driving the device

Act on coordinates from `nat screen` — exact, instant, free:

```bash
nat action tap --x 500 --y 320
nat action swipe --x1 500 --y1 800 --x2 500 --y2 200
nat action swipe --direction up
nat action drag --x1 300 --y1 500 --x2 700 --y2 500
nat action input --x 500 --y 640 --text "hi@example.com"
```

When the tree has nothing to aim at — a game, a canvas, a WebView, an ad overlay —
describe the target instead:

```bash
nat action tap -d "Blue login button at the bottom"
nat action tap -d "Settings icon" --double
nat action tap -d "message bubble" --duration 2      # long press
nat action swipe -d "photo carousel, swipe left"
nat action input -d "email field" --text "hi@example.com" --clear
```

Descriptions resolve from the accessibility tree first — free and deterministic. Only when
the tree genuinely cannot answer does it fall back to a vision model, and only if you have
configured one. Ambiguous descriptions are reported, never guessed:

```
error "Delete" matches 2 elements equally well
hint  Describe it more precisely, or pick one with --index:
  --index 1  button "Delete" @200,322
  --index 2  button "Delete" @700,322
```

App and system control take no target:

```bash
nat action restart-app --bundle-id com.example.app   # back to a known state
nat action background-app
nat action open-url --url "https://example.com/deep/link"
nat action alert --action accept                     # permission dialogs
nat action key back                                  # home, enter, escape, volumeup…
```

---

## Use it from a coding agent

This is the main way to use the tool. Install the skill and your agent knows the commands:

```bash
nat skill install --global      # ~/.claude/skills — Claude Code and compatible agents
nat skill install --agents-md   # also writes a section into AGENTS.md, for Codex/Cursor
```

Then ask for what you want in plain language — *"check the login flow on my phone"* — and
the agent runs the loop itself: reads the screen, taps, re-reads, reports what it saw. No
API key beyond the one your agent already uses.

### MCP

For hosts that prefer typed tools over shell access:

```bash
nat mcp config --client claude   # prints the snippet; also: cursor, vscode, codex
nat mcp serve                    # what the client launches
```

The MCP tools and the CLI share one device session, so you can mix them freely.

---

## Test cases

A test case is a title, some tags, and flows written in plain English. They live in your
repo under `.nat/cases/` as JSON — reviewed in pull requests, versioned with the code they
test:

```bash
nat cases create '{
  "title": "Login",
  "tags": ["smoke"],
  "app": "com.example.app",
  "flows": [
    {"instructions": "tap Sign in, enter valid credentials, submit",
     "result": "the home tab is selected and the header greets the user by name"}
  ]
}'

nat cases                  # list
nat cases get login        # show one
```

Write the expected result as something observable. *"the cart badge shows 2"* is
checkable; *"the cart state updates"* is not.

### Running them without a human

```bash
export ANTHROPIC_API_KEY=…
nat run login
nat run --tag smoke --report ./report.json
nat run -i "sign in as a@b.com and open settings" --expect "the settings screen shows"
```

`nat run` executes each flow autonomously and reports per-step pass/fail with the evidence
it saw. It exits non-zero on failure, so it drops straight into CI.

```
Login (login)
  flow 1  tap Sign in, enter valid credentials, submit
    · read_screen     ios · … · 34/211 elements
    · tap             tapped 500,806
    · type_text       typed "a@b.com"
    · read_screen     ios · … · 41/198 elements
    PASS the home tab is selected and the header reads "Welcome, Alice"

PASS Login — 1/1 flows in 12.4s
```

This is the only part that needs a model of its own. Everything else runs without one.

---

## Vision grounding (optional)

For screens with no accessibility tree at all — Unity, Unreal, canvases, video — point the
tool at a multimodal model and descriptions resolve from pixels:

```bash
export ANTHROPIC_API_KEY=…                              # or OPENAI_API_KEY
nat config set grounding.provider anthropic             # default: auto-detect
nat config set grounding.model claude-opus-5

# …or something local, with no key at all:
nat config set grounding.provider openai-compatible
nat config set grounding.baseUrl http://localhost:11434/v1
nat config set grounding.model qwen2.5-vl
```

`nat config set grounding.provider tree` turns it off entirely — descriptions then resolve
from the accessibility tree or fail loudly, never silently costing a model call.

---

## For scripts and CI

Every command takes `--json` and prints one object on stdout. Diagnostics go to stderr, so
`nat screen --json | jq` and `nat screenshot - > shot.png` both stay clean.

Exit codes are part of the contract:

| Code | Meaning |
|---:|---|
| 0 | success |
| 2 | invalid argument |
| 3 | no device / not connected |
| 4 | missing prerequisite (Xcode, adb, agent) |
| 5 | the driver failed |
| 6 | element not found, or the description was ambiguous |
| 7 | grounding unavailable |
| 8 | app not found |
| 9 | timeout |
| 10 | unsupported on this platform |

---

## Configuration

Layered, lowest to highest: built-in defaults → `~/.native-ai-tester/config.json` →
`<project>/.nat/config.json` → `NAT_*` environment variables.

```bash
nat config                                   # effective config and where it comes from
nat config set ios.teamId ABCDE12345 --project   # commit this one
nat config set app com.example.app --project
```

| Key | What it does |
|---|---|
| `defaultDevice` | device used when `--device` is omitted |
| `app` | bundle id / package name under test |
| `ios.teamId` | Apple Developer team used to sign WebDriverAgent |
| `ios.wdaPort`, `ios.wdaBundleId`, `ios.wdaVersion` | agent tuning |
| `android.adbPath` | adb, when it is not on PATH |
| `grounding.*` | vision provider, model, base URL |
| `update.autoCheck`, `update.channel` | update behaviour |

---

## How it works

```
        nat CLI  ·  MCP server  ·  nat run agent
                        │
                  driver interface
                   ┌────┴────┐
                 iOS       Android
        ┌──────────┴────────┐    │
   WebDriverAgent   simctl/devicectl   adb
    (tree, gestures)  (boot, install)  (everything)
```

**iOS** — WebDriverAgent is Apple's own XCUITest runner; the tool builds it, keeps it
alive, and talks to it over HTTP. `simctl` and `devicectl` handle boot, install and app
lifecycle. There is no Appium server in the middle.

**Android** — adb alone: `screencap` for pixels, `uiautomator` for the tree, `input` for
gestures. Nothing to install on the device.

Both produce the same normalized element shape and the same relative coordinate space, so
a step written against one platform reads identically on the other.

`nat devices connect` does the expensive, stateful work once and records it. Every later
command is a short-lived process that makes one HTTP or adb call — which is what makes it
cheap enough to run on every step.

---

## Development

```bash
npm install
npm run build
npm test              # 122 tests, no device required
npm run typecheck
node dist/cli.js --help
```

The test suite covers the pure logic — coordinate conversion, tree cleaning, description
matching, both platforms' tree parsers, case storage — so it runs anywhere. Device
behaviour is verified by hand against a simulator and a real phone.

Contributions welcome. Please keep the two invariants: **relative coordinates everywhere on
the public surface**, and **failures that say what to do next**.

---

## License

MIT
