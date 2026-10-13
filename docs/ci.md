# CI: offline plans

`rig plan --offline` runs the module code, checks for conflicts, cycles and
unknown dependencies, and validates package names against a cached package
list. It doesn't touch any machine and needs no secrets (it only checks that
they exist), so it works in CI:

```sh
rig facts zephyr --save          # once per host, on (or over SSH to) the host; commit fixtures/zephyr.json
rig plan zephyr --offline        # in CI: exit 0 if the config is sound, 1 with the problems otherwise
```

```yaml
# .github/workflows/rig.yml
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: curl -fsSL https://github.com/<you>/rig/releases/latest/download/rig-linux-x64 -o rig && chmod +x rig
      - run: for h in zephyr vault; do ./rig plan "$h" --offline || exit 1; done
```

Refresh a fixture when your repos change (`rig facts <host> --save`). Without
a package list, the offline plan skips package-name checks and warns.
[`example/fixtures/`](../example/fixtures) has two hand-trimmed fixtures. Real ones list every
package in the sync repos (a few hundred KB).
