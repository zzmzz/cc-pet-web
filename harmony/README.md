# cc-pet HarmonyOS client

HarmonyOS client for cc-pet, targeting API 26 (HarmonyOS NEXT).
**The server is not modified for this client**, at any point, for any reason.

## What this app is now: a WebView shell

The app is a shell around the existing `packages/web` React app, which
`packages/server` already serves at `/` (`packages/server/src/index.ts:138`). The entry
point is `entry/src/main/ets/pages/Shell.ets`: one `Web` component plus the handful of
things a web page physically cannot do for itself. See
`docs/superpowers/specs/2026-09-16-harmony-webview-shell-design.md`.

The earlier native ArkTS port (`entry/src/main/ets/components|store|gateway|logic|model`,
227 unit tests) **is still in the tree and still compiles and tests**, but nothing routes to
it: `EntryAbility` loads `pages/Shell`, and `pages/Index` is now unreachable. It is kept for
reference in case a hybrid approach is ever wanted. Do not treat it as live code, and do not
"fix" the shell by copying from it — every capability the shell duplicates is a place the
two implementations can drift, and removing drift is the only reason the shell exists.

The shell owns exactly: the server-address screen, the back key, the file picker, downloads,
and a load-failure screen. Everything else — login, sessions, messages, the WebSocket,
notifications-in-page — belongs to `packages/web`.

**No background notifications.** The app suspends when backgrounded and the page's WebSocket
drops with it. That was accepted when this direction was chosen.

## Toolchain

This project is built and tested entirely from the command line using the CLI tools bundled
inside DevEco Studio — no DevEco GUI project actions are required for build/test. Verified
versions: node v24.14.1, ohpm 26.0.0.630, hvigor 6.26.4.

Every command below needs these environment variables set first:

```bash
export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
export PATH="/Applications/DevEco-Studio.app/Contents/tools/node/bin:/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin:$PATH"
HVIGORW="node /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw.js"
```

`$HVIGORW` holds a two-word command (`node <path>`). In zsh (the default shell on macOS, and
this repo's verified shell), unquoted variable expansion does **not** word-split like bash
does, so a bare `$HVIGORW test ...` fails with `command not found: node <path>`. Invoke it
through `eval` instead, which re-parses the reconstructed line correctly in both bash and zsh:

```bash
eval "$HVIGORW test -p module=entry@default -p product=default --no-daemon"
```

All commands below use this `eval "$HVIGORW ..."` form.

### One-time: `@ohos` scope registry for hvigor's own tool provisioning

`hvigorw` resolves the `@ohos/hvigor` / `@ohos/hvigor-ohos-plugin` versions declared in
`hvigor/hvigor-config.json5` via `pnpm`/npm (this is separate from `ohpm install`, which only
resolves `oh-package.json5` dependencies like `@ohos/hypium`). If your `~/.npmrc` default
registry doesn't serve `@ohos/*` packages (e.g. it points at a generic npm mirror), add:

```
@ohos:registry=https://repo.harmonyos.com/npm/
```

to `~/.npmrc` (append — do not replace your existing default `registry=` line or other scoped
entries). Without this, `hvigorw` fails with `ERR_PNPM_FETCH_404` while installing its own
`@ohos/hvigor-ohos-plugin` tool dependency.

`harmony/hvigor/hvigor-config.json5` also pins `"@ohos/hvigor": "6.26.4"` explicitly,
alongside `@ohos/hvigor-ohos-plugin`. This isn't redundant: without it, `hvigorw`'s pnpm-based
tool provisioning reports a missing peer dependency and the `entry` module's task list comes
back truncated (no `UnitTestArkTS`/`assembleHap`/etc.) — pinning both lets pnpm link straight
to the copy already bundled inside DevEco Studio.

## Setup

```bash
cd harmony
ohpm install --all
```

Expected: exit code 0, `oh_modules/` created at both `harmony/` and `harmony/entry/`.

`harmony/build-profile.json5` is gitignored (it's machine-local) and must exist before running
any hvigor command. **Running the unit tests needs no signing at all** — create it with an
empty `signingConfigs` array:

```bash
cat > build-profile.json5 <<'EOF'
{
  "app": {
    "signingConfigs": [],
    "products": [
      {
        "name": "default",
        "compatibleSdkVersion": "26.0.0",
        "targetSdkVersion": "26.0.0",
        "runtimeOS": "HarmonyOS",
        "buildOption": {
          "strictMode": {
            "caseSensitiveCheck": true,
            "useNormalizedOHMUrl": true
          }
        }
      }
    ],
    "buildModeSet": [
      { "name": "debug" },
      { "name": "release" }
    ]
  },
  "modules": [
    {
      "name": "entry",
      "srcPath": "./entry"
    }
  ]
}
EOF
```

This is exactly what the "本地单测" command below was verified against. **Installing on a real
device is a separate path that does need signing** — see "Signing" below; do not copy
`build-profile.example.json5` for the unit-test path, its `signingConfigs` entry points at
placeholder certificate paths that don't exist on your machine.

## 命令

- 本地单测：
  ```bash
  cd harmony
  eval "$HVIGORW test -p module=entry@default -p product=default --no-daemon"
  ```
  Verified output ends with `BUILD SUCCESSFUL`, and
  `entry/.test/default/intermediates/test/coverage_data/test_result.txt` ends with:
  ```
  Tests run: 237, Failure: 0, Error: 0, Pass: 237, Ignore: 0
  ```
  227 of those cover the native port; the shell adds 10, all of them for
  `ets/shell/normalizeBaseUrl.ets`. That is the shell's entire unit-testable surface — every
  other file in `ets/shell` touches preferences, the network, or an `@Entry` struct, none of
  which `hvigorw test` can reach. Add `describe`/`it` blocks to `entry/src/test/` (wired into
  `List.test.ets`) and verify with this same command.

- 构建 HAP（需先配置签名，见下）：
  ```bash
  cd harmony
  eval "$HVIGORW assembleHap -p module=entry@default -p product=default --no-daemon"
  ```

## Signing

The `build-profile.json5` you created above (with `signingConfigs: []`) is enough to run unit
tests, but `assembleHap`/installing on a real device needs real signing material tied to a
Huawei developer account. `harmony/build-profile.example.json5` is a template for that case,
with `"<fill-me>"` placeholders — it is **not** what you should copy for the unit-test path
above.

To generate a real signing config:

1. Open `harmony/` in DevEco Studio and log in with a Huawei developer account.
2. Go to **File → Project Structure → Signing Configs**, enable "Automatically generate
   signature" for the `default` product.
3. DevEco writes a real `signingConfigs` block into the project's `build-profile.json5` (you
   can use `build-profile.example.json5` as a reference for the shape, replacing the
   `"<fill-me>"` placeholders with the values DevEco generated, including `"signingConfig":
   "default"` on the product entry).
4. Keep that file locally (it's gitignored) — do not commit it, since it contains
   machine/account-specific paths and secrets.

Until this is done, `assembleHap` will fail (there is no valid signing config), but
`ohpm install` and the local unit test command above both work without signing.

Alternatively, `harmony/scripts/build.sh` wraps the `assembleHap` invocation above (same
env vars, same command) and fails loudly with a clear message if `build-profile.json5` is
missing or the resulting `.hap` doesn't appear where expected.

## Device probes

`harmony/scripts/device-*.sh` are operational checks you can run against a live emulator
(or a real device, see below) to confirm the app still actually works end to end, not just
that it compiles and unit-tests pass. Each one prints an explicit `PASS: [...]` or
`FAIL: [...]` line and exits non-zero on failure — never rely on the exit code alone, and
never assume silence means success.

### The one probe that applies to the shell

```bash
export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
cd harmony
bash scripts/device-shell-probe.sh
```

`device-shell-probe.sh` wipes the target's app data, launches the shell, types a server
address into the shell's **native** setup screen, then — inside the WebView — logs in with
the fixture token and round-trips a message, asserting the transcript shows both the sent
text and the bridge fixture's reply. Two consecutive green runs on the emulator.

**This probe was expected to be impossible.** §8 of the design doc, following the
feasibility spike, said WebView content is invisible to `uitest` (the layout dump has zero
text nodes) and that coordinate taps cannot focus a web `<input>`. Measured against this
shell on the emulator, **both claims are false**:

- `uitest dumpLayout` returns a full accessibility tree for the page — `rootWebArea`,
  `heading`, `paragraph`, `textField`, `button`, each with `text`/`hint` and real `bounds`.
- `uitest uiInput click` on a web `<input>`'s bounds focuses it and raises the soft keyboard.
- `uitest uiInput text` commits into the focused web field verbatim.

Two gotchas that cost real time and are now encoded in the probe:

- **Use `ui_query_exact`, not `ui_query`, against web content.** ArkWeb exposes an entire
  paragraph as one node's `text`. This login screen's body copy is
  `认证通过后才可进入会话界面。`, which *contains* `进入` — the button's label. A substring
  query returns the paragraph's bounds and the probe taps the middle of a sentence forever
  while the button sits 360px lower, which looks exactly like a timing bug. Three failed
  runs went into that.
- **Let the IME attach before typing into a web field.** `ui_type_at` clicks and types back
  to back, which is fine for a native `TextInput` but drops characters into an ArkWeb
  `<input>`; the probe's local `web_type_at` sleeps 1s between the two.

One more trap, not shell-specific: `start_fixture_stack` only waits for the port to *open*,
not for the listener to be the server it just started. A stale server left over from an
earlier run answering on the same port will pass that check and then reject every token,
which presents as "the login screen just sits there". Check `lsof -nP -iTCP:19411 -sTCP:LISTEN`
before believing the app is at fault.

### The eight native-port probes are dead under this architecture

`device-login-probe.sh`, `device-chat-probe.sh`, `device-reconnect-probe.sh`,
`device-notification-probe.sh`, `device-relogin-probe.sh`, `device-slash-palette-probe.sh`,
`device-session-panel-probe.sh` and `device-session-switch-probe.sh` all drive `pages/Index`
and the native components under it. Nothing routes to that page any more, so **they will
fail against the shipped app** — not because the app is broken, but because the UI they
assert on is no longer on screen. They are kept, unchanged, alongside the native code they
test. Do not run them expecting green, and do not "fix" them by pointing them at the
WebView; `device-shell-probe.sh` is the shell's probe.

Their descriptions below are retained for whoever revisits the native port:

- `device-login-probe.sh` — launches the app and asserts it reaches either the login gate or
  a logged-in chat screen; if it's at the login gate, drives a real login through it.
- `device-chat-probe.sh` — sends a message through the real `MessageInput` UI and asserts
  both it and a genuine assistant reply show up in the transcript.
- `device-reconnect-probe.sh` — kills the server out from under a connected app, asserts the
  connection badge leaves `已连接`, brings the server back, and asserts it recovers.
- `device-notification-probe.sh` — backgrounds the app, waits for a delayed reply, and
  asserts a real system notification appears in the notification shade.
- `device-relogin-probe.sh` — round-trips a message, forces a real 401 (it swaps a throwaway
  401-only server in on the same port), asserts the app falls back to the login gate, then logs
  in again and asserts a second message round-trips. Covers the bug where `gatewayStarted`
  latched `true` forever, so logging back in left a fully-rendered chat screen over a dead
  socket; it additionally asserts the first session's transcript did **not** survive the logout.

- `device-slash-palette-probe.sh` — types `/`, then narrows to `/cl`, then clears the input,
  asserting the palette opens above the input, filters down to exactly `/clear`, and closes.
- `device-session-panel-probe.sh` — opens the session sheet, creates two sessions through the
  real 新建会话 entry, and asserts the panel lists **both of them under one connection**
  (当前会话 + 最近会话), that tapping a 最近会话 row switches to it, that a first ✕ tap only arms
  「确认删除」, that closing and reopening the panel disarms it, and that confirming deletes the
  row. It saves two screenshots (the two-session panel, and the armed row) — pass
  `CCPET_PROBE_SHOT` to choose where. Only the COMPACT shell (`SessionSheet`) is exercised;
  `SessionSidebar` renders the same rows through the same `SessionRow.ets` helpers but has
  never been reachable on this emulator (see the breakpoint honesty note below).
- `device-session-switch-probe.sh` — asserts what only a device can show about session
  switching: a session created and talked in **renames itself** to its first message
  (truncated to 15 chars + `…`, the same rule `packages/server` uses); a session created
  after it opens with an **empty** transcript; that a full app force-stop and relaunch
  **comes back into the session it was left in** (Task 9b — the real `preferences` round trip
  has no unit coverage, `hvigorw test` having no `UIAbilityContext`); and that **tapping the
  OTHER session's row pulls that session's history off the server**. That restart is the
  load-bearing part twice over: it empties `ChatStore`, so the other session's messages
  cannot still be in memory, and only the restored session is backfilled. Saves a
  screenshot (`CCPET_PROBE_SHOT` to choose where). COMPACT shell only, same caveat as above.

All of them (the shell probe included) target the **emulator** (`127.0.0.1:5555`) by default via `CCPET_DEVICE_TARGET` —
this project has been verified against the emulator since Task 10, not a physical phone, and
these probes follow that same convention. Set `CCPET_DEVICE_TARGET` to point at a real device
instead if you need to, but nothing here assumes one is attached, and by default nothing
touches one.

The chat/reconnect/notification/relogin/session-panel/session-switch probes clear the target's app data (`bm clean -n
com.ccpet.client -d`) and log in fresh against a **throwaway local server + bridge fixture
each probe starts and tears down itself** (a real, unmodified `packages/server` process on a
scratch port, plus a minimal external-bridge stand-in that answers with a canned
`reply_stream`) — never the operator's real server address or a real token. The login probe
only drives a login if it finds the app already sitting at the login gate; if the app is
already logged in (its own data, its own server), it only observes that and does not touch it.

Two environment quirks these probes work around, discovered while building them:

- **`hdc rport` (the reverse port forward letting the emulator reach a local server) has been
  observed to silently die mid-session** (see the Task 17 report). The probes verify the
  tunnel is actually registered before depending on it and re-establish it rather than hanging
  on a dead one.
- **`uitest uiInput inputText <x> <y> <text>` prepends a space to whatever you ask it to
  type.** `ui_type_at` in `scripts/lib/common.sh` therefore taps the field and commits through
  `uitest uiInput text` instead, which delivers the string verbatim. This corrupted every
  string every probe typed for most of the project and stayed invisible because both places it
  could have failed loudly absorbed it — `LoginGate` trims the URL and token, and the chat
  probes assert on a substring of the echo. It surfaced only when it made the slash palette
  look permanently dead (`isSlashInput` requires a strict leading slash), costing a day of
  debugging a component that was working the whole time.
- **The emulator can idle into a locked/screen-off state between runs**, and `aa start` alone
  does not dismiss a lock screen. The probes detect this (no app UI visible after launch) and
  wake + swipe past it before doing anything else.

Screenshots, if you need one for debugging a probe by hand, come from `snapshot_display`
(`hdc shell snapshot_display`), not `snapshot`.

**Honesty note on responsive breakpoints:** only the COMPACT breakpoint has ever been
observed on a device/emulator. The MEDIUM and EXPANDED breakpoints are implemented and
unit-tested but have never been exercised on-device — the wider-format emulator instances
(a foldable and a tablet) would not come up as `hdc` targets during this project (process
alive, never reachable; see the Task 16 report for what was ruled out). None of these probes
claim otherwise, and neither should anything you add here.

## What ArkWeb actually does with `packages/web` (measured, emulator, API 26)

§7 of the design doc listed six things that had to be measured rather than assumed. Five were
measured; one could not be. Screenshots for every line below are in
`.superpowers/sdd/2026-09-16-harmony-webview-shell/screenshots/` (gitignored — they are
evidence for the report, not artifacts of the build).

1. **`env(safe-area-inset-*)` — irrelevant here, because ArkUI never lets the page into the
   unsafe area.** The `Web` component's own bounds on this device are `[0,137][1256,2662]` on
   a `1256×2760` screen: ArkUI has already inset it below the status bar (137px) and above the
   gesture bar (98px). Inside the page the insets evaluate to ~0 — `packages/web`'s header is
   `pt-[max(0.5rem,env(safe-area-inset-top))]` and measures 8 CSS px of top padding, i.e. the
   `0.5rem` branch won. Nothing is occluded and nothing is double-padded. This holds only as
   long as the shell does not call `expandSafeArea()` on the `Web`; if you ever do, the page
   will need real insets and there is no evidence ArkWeb supplies them.
2. **The soft keyboard does not occlude anything.** ArkWeb's default
   `WebKeyboardAvoidMode.RESIZE_CONTENT` shrinks the component to `[0,137][1256,1661]` when the
   IME opens, so the composer, the 文件 button and 发送 all stay fully visible above the
   keyboard. Verified on both the web login field and the chat composer.
3. **Scrolling works; painting does not always keep up.** Fling and inertia are fine, and the
   web app's own scroll logic works inside ArkWeb (its 回到最新 pill appears and behaves).
   **But after scrolling, the right-aligned user message bubbles frequently fail to repaint
   their background**: `bg-indigo-500` collapses to a thin bar at the bubble's bottom edge and
   the `text-white` label is left on a near-white page, effectively unreadable. It persists
   (still wrong 5s later, and through further slow scrolling) and only clears on a full
   relayout — opening the keyboard repaints them correctly. Assistant bubbles and the file
   attachment bubble are never affected. Not fixable from the shell: setting
   `renderMode: RenderMode.SYNC_RENDER` was tried and changed nothing (reverted). Whether
   this is ArkWeb or the emulator's software renderer cannot be told apart without a physical
   device, which this project does not use.
4. **`<input type="file">` works end to end.** `onShowFileSelector` → `DocumentViewPicker` →
   `handleFileList` puts a real `File` in the page: the system picker opens, the chosen file
   shows up as `📎 pickme.txt` in the composer, and sending it round-trips through the real
   server and the bridge fixture. Note the attachment travels over the WebSocket, not a REST
   upload — no `/api/files` request appears in the server log.
5. **The spike's mystery 404s are all benign and none are the shell's.** Full list from a
   logged-in session against the fixture stack: `/favicon.ico` (the WebView asks for `.ico`;
   `packages/web/dist` only ships `favicon.png`), `/api/pet-images/happy`,
   `/api/pet-images/idle` (no custom pet images configured in the throwaway data dir — the
   page falls back to its bundled `/assets/*.png`, which return 200), and
   `/api/workspaces/<bridge>` (the fixture bridge implements no workspaces). The shell logs
   every one of them to hilog via `onHttpErrorReceive` — that logging is the only window into
   the page's network activity and should be kept.
6. **Foldable reflow: NOT TESTED.** Unchanged from the native port's Task 16 finding — the
   wider-format emulator instances will not come up as `hdc` targets on this machine, and
   this project does not use a physical device. Nobody has seen this app reflow.

Three further things measured while doing the above, all of which change how the app behaves
from what the design assumed:

- **`GET /api/health` is NOT unauthenticated.** §4 of the design says to validate a typed
  server address with it. `packages/server/src/index.ts:155` installs `authGuard` as a global
  `onRequest` hook, which runs for every route regardless of registration order, and its
  exempt list (`packages/server/src/middleware/auth.ts:23`) is exactly `/`, `/favicon.ico`,
  `/assets/*` and `/api/auth/verify`. `curl http://<server>/api/health` returns
  `401 {"error":"Unauthorized"}`. Worse, that guard locks a client IP out with HTTP 429 for
  five minutes after five failures in a minute — a shell that pinged `/api/health` on every
  "连接" tap would lock the user out of their own server after five typos. The shell therefore
  validates with `GET /` (exempt, and the exact URL it is about to load) and checks the body
  for the web app's `<title>`, `CC Pet`. See `ets/shell/probeServer.ets`.
- **The back key always exits.** `packages/web` has no router and never pushes a history
  entry (`grep -r "pushState\|react-router" packages/web/src` — nothing), so
  `controller.accessBackward()` is always false and §5's "go back if you can, otherwise hand
  it to the system" always takes the second branch. The handling is implemented and correct;
  it is simply inert against the current web app. If `packages/web` ever gains routing it will
  start working with no shell change.
- **The load-failure screen is hard to reach, because the page is a PWA.** `packages/web`
  registers a service worker (`/sw.js`, workbox). With the app already configured and the
  server killed, a relaunch still rendered the cached app shell rather than any network
  error, so the shell's error page never appeared. It only appears on a genuinely uncached
  main-frame failure (first run, or after cache eviction) — verified by pointing the shell at
  a throwaway server that answers the validation probe and then 503s, which produced the
  native error page with 重试 and 更换服务器.

## Manual device checklist (no automation covers these)

`device-shell-probe.sh` covers cold start → address → login → send/receive. The rest of §9's
acceptance list is human-eye work. Run it on the emulator after any change to `ets/shell` or
`pages/Shell.ets`:

1. Force-stop and relaunch a configured app: it should go straight to the chat, with neither
   the address screen nor the web login. (Address lives in `preferences`, token in the page's
   `localStorage`; the shell never sees the token.)
2. Press back on the chat screen: the app exits. That is correct — see the back-key note
   above — but confirm it is an exit and not a crash.
3. Tap 文件, pick a file, send it: the chip appears in the composer and the message lands in
   the transcript.
4. Scroll a long transcript up and down and look at the user bubbles. The repaint defect in
   item 3 above is the thing to watch for regressions against.
5. From the error page (only reachable per the PWA note above), 更换服务器 → the address is
   prefilled and a 取消 button appears; entering a different valid address reloads the page
   there, and the new address survives a restart.

## Constraints

- **服务端零改动 (zero server changes).** This client only consumes the existing WebSocket
  bridge protocol already used by `packages/web`; no code under `packages/` in this repo is
  modified to support it, at any point in this project — not even for test fixtures. The
  probes above start a real, unmodified `packages/server` process against a scratch data
  directory for exactly this reason, rather than special-casing anything inside `packages/`
  for HarmonyOS.
The two bullets below are about the **native port**, which is no longer the entry point.
They are kept because the code they describe is still in the tree, and because the
permission rule in the first one still binds the HAP the shell ships in.

- `entry/src/main/module.json5` declares exactly two permissions: `ohos.permission.INTERNET`
  and `ohos.permission.GET_NETWORK_INFO`, both added by Task 10. **There is no notification
  permission.** An earlier version of this line said one was "added by Task 14" — Ruling 26
  removed it entirely, because `ohos.permission.NOTIFICATION_CONTROLLER` is `system_core` and
  declaring it makes the HAP refuse to install. Local notifications still work:
  `NotificationGateway` asks for the runtime *enable* via `notificationManager.requestEnableNotification`,
  which needs no declared permission. The shell does not use `NotificationGateway` at all —
  it has no socket to be notified from — so under the current entry point the app requests no
  runtime permission either, and the file picker works without one because
  `DocumentViewPicker` grants per-file access on selection.

- **图片接收与预览不在首版范围内.** There is no `bridge:file-received` handling and no
  `/api/files/:fileId` call; the spec's §2 previously listed image receive/preview as shipped
  and has been corrected. A markdown image in a reply degrades to its alt text
  (`[图片: …]`, see `entry/src/main/ets/logic/markdownImage.ets`) rather than rendering as the
  zero pixels `ImageSpan` produces on a failed load. Adding it later means: dispatch
  `bridge:file-received`, fetch the bytes over the same token-authenticated binary path
  `PetImageCache` already uses (`RestClient.getBinary`), and hand a `PixelMap` back to the UI.
