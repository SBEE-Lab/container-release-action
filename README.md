# Container Release Action

Reusable GitHub Actions for promoting a verified staging image to an immutable
container release.

> The stable action release is `v1.0.0`. Pin this immutable tag in workflow
> references; use the full commit SHA when your organization requires
> byte-for-byte ref pinning.

## What this action does

```text
caller-owned source checkout and build
  → unique staging tag and registry digest
  → registry digest verification
  → canonical SBOM and provenance
  → Cosign signature and attestations
  → release pull request with merge-commit auto-merge
  → digest-preserving final tag promotion
  → annotated Git tag and GitHub Release
```

This action starts **after the caller has built and pushed an image**. It does
not discover a Dockerfile, choose a build context, run `docker build`, or
construct a Nix image. Those choices remain in the caller repository so that
the same release protocol can support both Docker Buildx and Nix
`pkgs.dockerTools.buildLayeredImage`.

The action never builds directly to a final release tag. A final tag that
already exists at another digest is rejected rather than overwritten.

## Release contract and trust boundary

The caller owns:

- checking out and validating the immutable source revision;
- selecting the Dockerfile, build context, Nix attribute, and build arguments;
- building and pushing a unique staging reference;
- reporting the resulting registry digest and truthful backend metadata.

The shared workflows own:

- verifying the staging reference against the reported digest;
- generating, signing, and later restoring the release evidence;
- creating the release pull request;
- promoting the verified digest without changing its manifest;
- reconciling the annotated Git tag and GitHub Release.

Every backend must hand off the same core values:

| Value                 | Requirement                                                 |
| --------------------- | ----------------------------------------------------------- |
| `release-id`          | Stable lowercase stream ID; defaults to `container`         |
| `version`             | Final tag; `vMAJOR.MINOR.PATCH` under the default policy    |
| `source-repository`   | Source repository in `owner/name` form                      |
| `source-revision`     | Full immutable 40-character Git commit SHA                  |
| `source-date-epoch`   | Commit timestamp used to make signed artifacts reproducible |
| `image-repository`    | Registry repository without a tag                           |
| `staging-reference`   | Unique staging tag in the same image repository             |
| `image-digest`        | Registry-reported `sha256:...` manifest digest              |
| `platforms-json`      | JSON array such as `["linux/amd64"]`                        |
| `build-backend`       | Backend identifier, for example `buildx` or `nix`           |
| `build-metadata-json` | Backend-specific provenance metadata                        |

Each release stream stores its signed state at
`.github/releases/<release-id>.json` by default. The path can be overridden
with `manifest-path`, but prepare and finalize must use the same release ID and
path. The default single-image stream keeps a conventional Git tag such as
`v1.2.3`; custom streams use namespaced tags such as `api/v1.2.3`. Release PR
branches are always isolated as `release/<release-id>/<version>`.

`release-id` and the derived Git tag are included in both the canonical
manifest and signed provenance. `build-metadata-json` is also recorded in the
signed provenance. The shared action does not independently prove that a
declared Dockerfile path, build context,
or Nix attribute was used; the caller workflow must keep those values aligned
with the actual build.

## Example 1: Docker Buildx

The complete templates are in [`examples/buildx`](examples/buildx). The build
job must check out the exact source SHA and explicitly choose both the context
and Dockerfile:

```yaml
on:
  workflow_dispatch:
    inputs:
      version:
        required: true
        type: string
      source-revision:
        description: Full 40-character commit SHA to build
        required: true
        type: string

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.build.outputs.digest }}
      source-date-epoch: ${{ steps.source.outputs.source-date-epoch }}
      staging-reference: ${{ steps.meta.outputs.staging-reference }}
    steps:
      - uses: actions/checkout@v7.0.1
        with:
          ref: ${{ inputs.source-revision }}
          persist-credentials: false

      - name: Resolve reproducible source timestamp
        id: source
        run: echo "source-date-epoch=$(git show -s --format=%ct HEAD)" >> "$GITHUB_OUTPUT"

      - uses: docker/login-action@v4.6.0
        with:
          registry: registry.example.org
          username: container-push-bot
          password: ${{ secrets.REGISTRY_PASSWORD }}

      - uses: docker/setup-buildx-action@v4.2.0

      - name: Resolve staging reference
        id: meta
        env:
          VERSION: ${{ inputs.version }}
        run: |
          echo "staging-reference=registry.example.org/org/example:staging-${VERSION}-${GITHUB_RUN_ID}" >> "$GITHUB_OUTPUT"

      - name: Build and push staging image
        id: build
        uses: docker/build-push-action@v7.3.0
        with:
          context: .
          file: ./docker/Dockerfile
          platforms: linux/amd64
          push: true
          tags: ${{ steps.meta.outputs.staging-reference }}
          cache-from: type=registry,ref=registry.example.org/org/example:buildcache
          cache-to: type=registry,ref=registry.example.org/org/example:buildcache,mode=max
          provenance: false
          sbom: false
```

`file` is the Dockerfile path in the checked-out workspace. `context` controls
which files its `COPY` and `ADD` instructions can access. For example, a
Dockerfile at `docker/Dockerfile` can still require `context: .` when it copies
files from the repository root.

The build output is then handed to the prepare workflow:

```yaml
prepare:
  needs: build
  permissions:
    contents: read
    id-token: write
  uses: SBEE-Lab/container-release-action/.github/workflows/prepare-release.yaml@v1.0.0
  with:
    version: ${{ inputs.version }}
    source-repository: ${{ github.repository }}
    source-revision: ${{ inputs.source-revision }}
    source-date-epoch: ${{ needs.build.outputs.source-date-epoch }}
    image-repository: registry.example.org/org/example
    staging-reference: ${{ needs.build.outputs.staging-reference }}
    image-digest: ${{ needs.build.outputs.digest }}
    platforms-json: '["linux/amd64"]'
    build-backend: buildx
    build-metadata-json: >-
      {"context":".","dockerfile":"docker/Dockerfile"}
    registry-host: registry.example.org
    registry-username: container-push-bot
  secrets:
    registry-password: ${{ secrets.REGISTRY_PASSWORD }}
    app-id: ${{ secrets.APP_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
```

BuildKit provenance and SBOM generation are disabled in this example because
the prepare workflow generates the canonical release evidence after verifying
the pushed registry digest.

## Example 2: Nix `dockerTools.buildLayeredImage`

The complete workflow templates are in
[`examples/nix-docker-tools`](examples/nix-docker-tools). A caller can expose a
container archive as a flake package:

```nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      packages.${system}.container = pkgs.dockerTools.buildLayeredImage {
        name = "example";
        tag = "build";
        contents = [ pkgs.busybox ];
        config.Cmd = [ "${pkgs.busybox}/bin/sh" ];
      };
    };
}
```

The local image tag is only a transport detail. The workflow loads the archive,
retags it with a unique staging reference, pushes it, and resolves the digest
from the registry:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.image.outputs.digest }}
      source-date-epoch: ${{ steps.source.outputs.source-date-epoch }}
      staging-reference: ${{ steps.meta.outputs.staging-reference }}
    steps:
      - uses: actions/checkout@v7.0.1
        with:
          ref: ${{ inputs.source-revision }}
          persist-credentials: false

      - name: Resolve reproducible source timestamp
        id: source
        run: echo "source-date-epoch=$(git show -s --format=%ct HEAD)" >> "$GITHUB_OUTPUT"

      - uses: cachix/install-nix-action@v31.11.0
        with:
          github_access_token: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/login-action@v4.6.0
        with:
          registry: registry.example.org
          username: container-push-bot
          password: ${{ secrets.REGISTRY_PASSWORD }}

      - uses: docker/setup-buildx-action@v4.2.0

      - name: Build and load dockerTools image
        run: |
          archive=$(nix build .#container --no-link --print-out-paths)
          docker load --input "$archive"
          docker image inspect example:build

      - name: Resolve staging reference
        id: meta
        env:
          VERSION: ${{ inputs.version }}
        run: |
          echo "staging-reference=registry.example.org/org/example:staging-${VERSION}-${GITHUB_RUN_ID}" >> "$GITHUB_OUTPUT"

      - name: Push staging image
        env:
          STAGING: ${{ steps.meta.outputs.staging-reference }}
        run: |
          docker tag example:build "$STAGING"
          docker push "$STAGING"

      - name: Resolve registry digest
        id: image
        uses: SBEE-Lab/container-release-action@v1.0.0
        with:
          operation: resolve
          image-repository: registry.example.org/org/example
          staging-reference: ${{ steps.meta.outputs.staging-reference }}
```

The prepare handoff uses the registry digest, not the Nix store path or local
Docker image ID:

```yaml
prepare:
  needs: build
  permissions:
    contents: read
    id-token: write
  uses: SBEE-Lab/container-release-action/.github/workflows/prepare-release.yaml@v1.0.0
  with:
    version: ${{ inputs.version }}
    source-repository: ${{ github.repository }}
    source-revision: ${{ inputs.source-revision }}
    source-date-epoch: ${{ needs.build.outputs.source-date-epoch }}
    image-repository: registry.example.org/org/example
    staging-reference: ${{ needs.build.outputs.staging-reference }}
    image-digest: ${{ needs.build.outputs.digest }}
    platforms-json: '["linux/amd64"]'
    build-backend: nix
    build-metadata-json: >-
      {"attribute":".#container","lockFile":"flake.lock","localImage":"example:build"}
    registry-host: registry.example.org
    registry-username: container-push-bot
  secrets:
    registry-password: ${{ secrets.REGISTRY_PASSWORD }}
    app-id: ${{ secrets.APP_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
```

Use Cachix or Attic in the caller workflow when remote Nix build caching is
required. BuildKit registry cache settings do not apply to
`dockerTools.buildLayeredImage`. The example is a single `x86_64-linux` image;
multi-architecture Nix publication requires building each target architecture
and assembling the registry manifest before the release handoff.

## Common finalization workflow

Both backends use the same finalization workflow. It must be triggered from the
caller repository after the release pull request merges to `main`, so that a
protected `release` environment receives an allowed branch ref:

```yaml
name: Finalize container release

on:
  push:
    branches: [main]
    paths: [.github/releases/container.json]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  finalize:
    uses: SBEE-Lab/container-release-action/.github/workflows/finalize-release.yaml@v1.0.0
    with:
      image-repository: registry.example.org/org/example
      registry-host: registry.example.org
      registry-username: container-push-bot
    secrets:
      registry-password: ${{ secrets.REGISTRY_PASSWORD }}
```

Prepare and finalize must use the same immutable action release ref. The called
workflow checks out its bundled action implementation at the exact reusable
workflow commit rather than executing code from the caller checkout.

## Multiple independent release streams

A repository that publishes independently versioned images gives each image a
stable release ID and passes it to the prepare workflow:

```yaml
with:
  release-id: api
  version: v1.2.3
  image-repository: registry.example.org/org/api
  # The default manifest path is .github/releases/api.json.
```

Build orchestration remains caller-owned: each matrix leg must hand one staged
digest to `prepare-release.yaml` with its release ID. The shared action does not
aggregate matrix build outputs into an atomic bundle.

This namespaces mutable GitHub state while leaving the image tag unchanged:

| State          | Example                     |
| -------------- | --------------------------- |
| Manifest       | `.github/releases/api.json` |
| Release branch | `release/api/v1.2.3`        |
| Image tag      | `api:v1.2.3`                |
| Git tag        | `api/v1.2.3`                |
| GitHub Release | tag `api/v1.2.3`            |

Finalization discovers changed manifests only through a trusted configuration,
for example `.github/container-releases.json`:

```json
{
  "releases": [
    {
      "id": "api",
      "manifestPath": ".github/releases/api.json",
      "imageRepository": "registry.example.org/org/api",
      "registryHost": "registry.example.org",
      "registryUsername": "container-push-bot",
      "environment": "release-api"
    }
  ]
}
```

A caller dispatcher watches `.github/releases/*.json`, compares the protected
`main` push range, rejects manifests absent from this configuration, and passes
the trusted targets to the finalize workflow as a matrix. Manual dispatch
selects one configured `release-id`. See
[`examples/multi-image`](examples/multi-image) for the complete dispatcher and
configuration templates. A custom manifest location must also be added to the
caller dispatcher's `paths` filter.

The trusted configuration contains no credentials. The matrix jobs receive the
registry password through the normal `secrets` interface. Each release stream
gets independent branch, Git tag, GitHub Release, environment, and concurrency
state; a failure in one matrix leg does not retarget another stream. GitHub has
only one repository-wide "Latest" release, so namespaced stream releases are
published with `make_latest=false`; consumers should select them by namespaced
tag instead.

This is an independent-stream model, not an atomic bundle release. Images that
must always publish under one shared version require a different manifest that
records all image digests and are outside this protocol.

## Required GitHub configuration

Each caller repository needs:

- GitHub Actions auto-merge enabled;
- merge commits enabled;
- appropriate required checks on `main`;
- tag rules that protect both single-stream `v*` and namespaced `*/v*` tags;
- a protected `release` environment that permits `main`;
- `REGISTRY_PASSWORD`, `APP_ID`, and `APP_PRIVATE_KEY` Actions secrets;
- access to this reusable workflow when this repository is private.

The GitHub App must be installed on each caller repository and have only these
repository permissions:

- **Contents: Read and write**;
- **Pull requests: Read and write**.

Store the raw PEM private key as `APP_PRIVATE_KEY`. `APP_ID` is not inherently
secret, but this workflow accepts it through the same secret interface. An
organization secret restricted to selected caller repositories can provide the
same App credentials without duplicating them in every repository.

The App token is used only to write the release branch, open the release pull
request, and enable merge-commit auto-merge. Finalization uses the caller's
short-lived `GITHUB_TOKEN` with `contents: write` to create the annotated tag
and GitHub Release.

Registry host, repository, and username are ordinary workflow inputs. The
registry password is the only registry credential secret. The registry must
support digest-qualified OCI access and Cosign signatures and attestations.

### Maintainer dependency updates

This action repository stores `APP_ID` and `APP_PRIVATE_KEY` as Dependabot
secrets. The vendored-dependency workflow uses that App only to update the
Dependabot branch with the regenerated `npmDepsHash`, lockfile, and `dist/`
output. Dependency auto-merge continues to use the repository
`GITHUB_TOKEN`; protected-branch checks decide whether the updated PR may
merge.

## Supply-chain behavior

- Images are signed only by digest.
- Provenance and SPDX SBOM predicates are canonicalized and attested separately.
- `source-date-epoch` normalizes the SPDX creation timestamp, and the image
  digest determines its document namespace, so retries produce identical assets.
- Signing is convergent: matching signatures and predicates are reused, and only
  missing evidence is appended. Verification accepts multiple Cosign results and
  selects the predicate whose SHA256 matches the manifest.
- Finalization restores the exact predicates from verified Cosign attestations
  and checks their SHA256 values against the stream manifest.
- Single-manifest promotion uses
  `docker buildx imagetools create --prefer-index=false`.
- Existing matching releases reconcile successfully; conflicting digests fail.
- The default `semver` policy rejects source tag mutation and version
  downgrades.
- The Fulcio identity is derived from the pinned prepare reusable workflow;
  finalize rejects any other signer.
- Finalization binds the stream ID and manifest to the caller-configured image
  repository and the manifest-changing commit in the triggering history.

## Action operations

The bundled Node 24 action is also usable directly:

| Operation    | Purpose                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `resolve`    | Resolve the registry digest of a staging reference                     |
| `inspect`    | Assert that a staging reference has an expected digest                 |
| `discover`   | Build a trusted finalize matrix from changed stream manifests          |
| `validate`   | Validate a local release manifest without mutations                    |
| `artifacts`  | Canonicalize the SBOM and generate provenance and release metadata     |
| `sign`       | Ensure the digest has the exact signature, provenance, and SPDX SBOM   |
| `verify`     | Verify the signature and restore exact signed assets from attestations |
| `promote`    | Promote staging to the final tag without changing its manifest digest  |
| `prepare-pr` | Create/update the release PR and enable merge-commit auto-merge        |
| `publish`    | Create the annotated tag and GitHub Release idempotently               |

## Development

The development and validation environment is pinned by `flake.lock`:

```bash
nix develop
npm ci
npm run check
npm run build
nix fmt
nix flake check -L
```

`dist/index.js` is committed. CI rebuilds it with ncc and fails when generated
output differs.
