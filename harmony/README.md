# cc-pet HarmonyOS client

Native ArkTS/ArkUI client for cc-pet, targeting API 26 (HarmonyOS NEXT). This project talks
to the existing cc-pet server over its existing WebSocket bridge protocol —
**the server is not modified for this client** (see `entry/src/main/ets/model/Protocol.ets`
for the shared message shapes).

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
  `entry/.test/default/intermediates/test/coverage_data/test_result.txt` contains:
  ```
  class=localUnitTest
  test=hypium_is_wired
  result=Success
  Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0
  ```
  All downstream tasks should add their `describe`/`it` blocks to `entry/src/test/` (wired
  into `List.test.ets`) and verify with this same command.

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

```bash
export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
cd harmony
bash scripts/device-login-probe.sh
bash scripts/device-chat-probe.sh
bash scripts/device-reconnect-probe.sh
bash scripts/device-notification-probe.sh
bash scripts/device-relogin-probe.sh
bash scripts/device-slash-palette-probe.sh
bash scripts/device-session-panel-probe.sh
bash scripts/device-session-switch-probe.sh
```

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
  after it opens with an **empty** transcript; and — after a full app force-stop, which
  empties `ChatStore` and lands the app on a blank `default` chat — **tapping a session's row
  pulls that session's history off the server**. That restart is the load-bearing part:
  without it, seeing the messages proves only that they were still in memory. Saves a
  screenshot (`CCPET_PROBE_SHOT` to choose where). COMPACT shell only, same caveat as above.

All eight target the **emulator** (`127.0.0.1:5555`) by default via `CCPET_DEVICE_TARGET` —
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

## Constraints

- **服务端零改动 (zero server changes).** This client only consumes the existing WebSocket
  bridge protocol already used by `packages/web`; no code under `packages/` in this repo is
  modified to support it, at any point in this project — not even for test fixtures. The
  probes above start a real, unmodified `packages/server` process against a scratch data
  directory for exactly this reason, rather than special-casing anything inside `packages/`
  for HarmonyOS.
- `entry/src/main/module.json5` declares exactly two permissions: `ohos.permission.INTERNET`
  and `ohos.permission.GET_NETWORK_INFO`, both added by Task 10. **There is no notification
  permission.** An earlier version of this line said one was "added by Task 14" — Ruling 26
  removed it entirely, because `ohos.permission.NOTIFICATION_CONTROLLER` is `system_core` and
  declaring it makes the HAP refuse to install. Local notifications still work:
  `NotificationGateway` asks for the runtime *enable* via `notificationManager.requestEnableNotification`,
  which needs no declared permission.

- **图片接收与预览不在首版范围内.** There is no `bridge:file-received` handling and no
  `/api/files/:fileId` call; the spec's §2 previously listed image receive/preview as shipped
  and has been corrected. A markdown image in a reply degrades to its alt text
  (`[图片: …]`, see `entry/src/main/ets/logic/markdownImage.ets`) rather than rendering as the
  zero pixels `ImageSpan` produces on a failed load. Adding it later means: dispatch
  `bridge:file-received`, fetch the bytes over the same token-authenticated binary path
  `PetImageCache` already uses (`RestClient.getBinary`), and hand a `PixelMap` back to the UI.
