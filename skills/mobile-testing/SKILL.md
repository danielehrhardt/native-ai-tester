---
name: mobile-testing
description: Drive a real iOS or Android device (or a simulator/emulator) from the terminal to test a mobile app or game — read the screen, tap, swipe, type, verify. Use when asked to test, debug, reproduce, or check a change in a mobile app; when a task mentions a device, simulator, emulator, iOS, Android, React Native, Flutter, KMP, Unity, or a mobile build; or when you need to see what an app actually does rather than what the code says it does.
---

# Testing mobile apps on a device

`nat` drives a real phone (or a simulator) from the shell. You read the screen, take one
action, read it again to check the result, and repeat. There are no locators, no page
objects and no SDK in the app — it works from the accessibility tree and, where there
isn't one, from pixels.

## The loop

```bash
nat screen                              # inspect: what is on screen right now
nat action tap --x 500 --y 320          # act: exactly one thing
nat screen                              # verify: did it do what you expected
```

Do not batch actions. Take one step, confirm it landed, then decide the next one. Most
flaky mobile tests come from assuming the previous tap worked.

## Getting a device

```bash
nat devices                             # everything attached: phones, simulators, emulators
nat devices connect <device-id>         # connect once; every later command uses it
nat devices current                     # what am I connected to, is it still alive
```

The first iOS connect builds WebDriverAgent and can take a few minutes. Later connects
reuse it and are instant. `nat doctor` explains anything that is missing.

Get the app under test in front of you:

```bash
nat apps                                        # what's installed
nat action activate-app --bundle-id com.example.app
nat install ./build/MyApp.app                   # or .ipa / .apk
```

## Reading the screen

```bash
nat screen                     # cleaned element tree — this is what you want
nat screen --full              # raw platform tree, when the cleaned one hid something
nat screenshot ./shot.png      # a picture, for visual checks
```

`nat screen` returns one line per element:

```
[0.1.4] button "Sign in" @500,812 760x52
[0.1.2] field placeholder="Email" @500,420 760x44
```

`@500,812` is the tap point. **Coordinates are relative: 0–1000 on both axes**, origin
top-left, independent of the device's resolution. The same numbers work on an iPhone SE
and an iPad.

Read cost dominates a test run, because you read the screen on every step. The cleaned
tree is roughly half the tokens of a screenshot and a fraction of the raw tree — reach
for `nat screen` by default, `nat screenshot` only when you need to *see* something
(a game, a chart, a canvas, a layout bug).

## Acting

Act on coordinates from `nat screen` whenever the tree describes the target — it is
exact and costs nothing to resolve:

```bash
nat action tap --x 500 --y 320
nat action swipe --x1 500 --y1 800 --x2 500 --y2 200
nat action swipe --direction up                        # across the middle of the screen
nat action drag --x1 300 --y1 500 --x2 700 --y2 500
nat action input --x 500 --y 640 --text "hi@example.com"
```

When the tree gives you nothing to aim at — a Unity or Unreal game, a canvas, a WebView,
an ad overlay, or coordinates that just didn't work — describe the target instead and
let the tool resolve it:

```bash
nat action tap -d "Blue login button at the bottom"
nat action tap -d "Settings icon" --double
nat action tap -d "message bubble" --duration 2        # long press, in seconds
nat action swipe -d "photo carousel, swipe left"
nat action input -d "email field" --text "hi@example.com" --clear
```

Descriptions resolve from the accessibility tree first (free, instant). If the tree
can't answer and a vision model is configured, it falls back to looking at the
screenshot. If a description is ambiguous the command says so and lists the candidates —
re-run with `--index 2` or describe it more precisely.

App and system control take no target:

```bash
nat action restart-app --bundle-id com.example.app     # back to a known state
nat action terminate-app --bundle-id com.example.app
nat action background-app
nat action open-url --url "https://example.com/deep/link"
nat action alert --action accept                       # permission dialogs, sign-in sheets
nat action key back                                    # home, back, enter, escape, volumeup…
```

## Working effectively

**Start from a known state.** `nat action restart-app --bundle-id …` before a flow beats
guessing which screen you're on.

**Expect interruptions.** Permission dialogs, rating prompts, cookie banners and ads show
up mid-flow on real devices. Handle them (`nat action alert --action accept`) and carry
on — don't treat them as failures.

**When an action seems to do nothing**, don't repeat it. Run `nat screen` and look: the
element may be disabled, covered by an overlay, or below the fold. Scroll with
`nat action swipe --direction up` and read again.

**Typing** goes to the focused field. `nat action input` taps first, then types; add
`--clear` to replace existing text and `--submit` to press enter.

**Long text or a slow screen**: read the screen again rather than sleeping. If you must
wait, keep it short and verify afterwards.

## Machine-readable output

Every command takes `--json` and prints a single object on stdout. Diagnostics go to
stderr, so `nat screen --json | jq` and `nat screenshot - > shot.png` both stay clean.

Exit codes are part of the contract: `0` success, `3` no device connected, `4` a missing
prerequisite, `6` element not found or ambiguous, `9` timeout. `--verbose` adds a trace.

## Recording what you tested

Test cases live in the repo as JSON under `.nat/cases/`, so they are reviewed and
versioned like code:

```bash
nat cases create '{"title": "Login", "tags": ["smoke"], "flows": [
  {"instructions": "tap Sign in, enter valid credentials, submit",
   "result": "the home tab is selected and the header greets the user by name"}
]}'
nat cases                                 # list
nat run login                             # run it autonomously (needs ANTHROPIC_API_KEY)
nat run --tag smoke --report ./report.json
```

You do not need `nat run` — driving the CLI yourself is the free path and needs no API
key at all. Reach for `nat run` when someone wants the suite executed without a human or
an agent in the loop.

Write flows as observable behaviour, not implementation. "the cart badge shows 2" is
checkable; "the cart state updates" is not.
