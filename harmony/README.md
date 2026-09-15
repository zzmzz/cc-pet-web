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

## Setup

```bash
cd harmony
ohpm install --all
```

Expected: exit code 0, `oh_modules/` created at both `harmony/` and `harmony/entry/`.

Then copy the signing template (see "Signing" below) so `build-profile.json5` exists locally
(it's gitignored):

```bash
cp build-profile.example.json5 build-profile.json5
```

## 命令

- 本地单测：
  ```bash
  cd harmony
  node /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw.js test -p module=entry@default -p product=default --no-daemon
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
  node /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw.js assembleHap -p module=entry@default -p product=default --no-daemon
  ```

## Signing

`harmony/build-profile.json5` is gitignored because it's machine-local (it embeds absolute
paths to a certificate/profile/keystore tied to one Huawei developer account). This repo
ships `harmony/build-profile.example.json5` as a template with `"<fill-me>"` placeholders.

To generate a real one:

1. Open `harmony/` in DevEco Studio and log in with a Huawei developer account.
2. Go to **File → Project Structure → Signing Configs**, enable "Automatically generate
   signature" for the `default` product.
3. DevEco writes a real `signingConfigs` block into the project's `build-profile.json5`.
4. Keep that file locally (it's gitignored) — do not commit it, since it contains
   machine/account-specific paths and secrets.

Until this is done, `assembleHap` will fail (there is no valid signing config), but
`ohpm install` and the local unit test command above both work without signing.

## Constraints

- **Zero server changes.** This client only consumes the existing WebSocket bridge protocol
  already used by `packages/web`; no server-side code in this repo is modified to support it.
- Task 1 (this scaffold) declares no `requestPermissions` in `entry/src/main/module.json5`.
  Network permission is added by Task 10, notification permission by Task 14.
