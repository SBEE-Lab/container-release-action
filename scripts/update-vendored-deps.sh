#!/usr/bin/env bash
set -euo pipefail

if [[ "${UPDATE_VENDORED_DEPS_IN_SHELL:-}" != 1 ]]; then
  exec nix develop --command env UPDATE_VENDORED_DEPS_IN_SHELL=1 "$0" "$@"
fi

npm install

new_hash="$(prefetch-npm-deps package-lock.json)"
export NEW_NPM_DEPS_HASH="$new_hash"

python3 <<'PY'
import os
import pathlib
import re

path = pathlib.Path("flake.nix")
text = path.read_text()
updated, count = re.subn(
    r'npmDepsHash = "sha256-[^"]+";',
    f'npmDepsHash = "{os.environ["NEW_NPM_DEPS_HASH"]}";',
    text,
)
if count != 1:
    raise SystemExit(f"expected exactly one npmDepsHash, found {count}")
path.write_text(updated)
PY

npm ci
npm run build
nix fmt
