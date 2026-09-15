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

## Constraints

- **Zero server changes.** This client only consumes the existing WebSocket bridge protocol
  already used by `packages/web`; no server-side code in this repo is modified to support it.
- Task 1 (this scaffold) declares no `requestPermissions` in `entry/src/main/module.json5`.
  Network permission is added by Task 10, notification permission by Task 14.
