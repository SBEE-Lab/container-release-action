# Container Release Action

Reusable GitHub Actions for promoting a verified staging image to an immutable container release.

> This repository is under initial development. No stable release tag exists yet.

## Release model

```text
caller-specific build
  → unique staging tag
  → registry digest verification
  → canonical SBOM and provenance
  → Cosign signature and attestations
  → release pull request with merge-commit auto-merge
  → digest-preserving final tag promotion
  → annotated Git tag and GitHub Release
```

The action never builds directly to a final release tag. A final tag that already exists at another digest is rejected rather than overwritten.

## Supported build backends

Builds remain in caller repositories. The shared release protocol accepts any backend that can push an OCI image and report its registry digest, including:

- Dockerfile builds with Docker Buildx
- Nix images built with `dockerTools.buildLayeredImage`

See [`examples/buildx`](examples/buildx) and [`examples/nix-docker-tools`](examples/nix-docker-tools).

## Reusable workflows

A caller build job passes its staging image to the prepare workflow:

```yaml
jobs:
  prepare:
    needs: build
    permissions:
      contents: read
      id-token: write
    uses: SBEE-Lab/container-release-action/.github/workflows/prepare-release.yaml@v1.0.0
    with:
      version: v1.2.3
      source-repository: owner/project
      source-revision: 0123456789abcdef0123456789abcdef01234567
      image-repository: registry.example.org/org/project
      staging-reference: registry.example.org/org/project:staging-v1.2.3-12345
      image-digest: sha256:...
      build-backend: buildx
      registry-host: registry.example.org
      registry-username: container-push-bot
    secrets:
      registry-password: ${{ secrets.REGISTRY_PASSWORD }}
      app-id: ${{ secrets.APP_ID }}
      app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
```

The caller owns the finalize trigger so its protected `release` environment sees an allowed `main` ref:

```yaml
on:
  push:
    branches: [main]
    paths: [release.json]
  workflow_dispatch:

jobs:
  finalize:
    uses: SBEE-Lab/container-release-action/.github/workflows/finalize-release.yaml@v1.0.0
    permissions:
      contents: write
    with:
      image-repository: registry.example.org/org/project
      registry-host: registry.example.org
      registry-username: container-push-bot
    secrets:
      registry-password: ${{ secrets.REGISTRY_PASSWORD }}
```

## Action operations

The bundled Node 24 action is also usable directly:

| Operation    | Purpose                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `resolve`    | Resolve the registry digest of a staging reference                     |
| `inspect`    | Assert that a staging reference has an expected digest                 |
| `validate`   | Validate a local release manifest without mutations                    |
| `artifacts`  | Canonicalize the SBOM and generate provenance and release metadata     |
| `sign`       | Sign the image and attest provenance and the SPDX SBOM                 |
| `verify`     | Verify the signature and restore exact signed assets from attestations |
| `promote`    | Promote staging to the final tag without changing its manifest digest  |
| `prepare-pr` | Create/update the release PR and enable merge-commit auto-merge        |
| `publish`    | Create the annotated tag and GitHub Release idempotently               |

## Supply-chain behavior

- Images are signed only by digest.
- Provenance and SPDX SBOM predicates are canonicalized and attested separately.
- Finalization restores the exact predicates from verified Cosign attestations and checks their SHA256 values against `release.json`.
- Single-manifest promotion uses `docker buildx imagetools create --prefer-index=false`.
- Existing matching releases reconcile successfully; conflicting digests fail.
- The default `semver` policy rejects source tag mutation and version downgrades.
- The Fulcio identity is derived from the pinned prepare reusable workflow; finalize rejects any other signer.
- Finalization binds `release.json` to the caller-configured image repository and the manifest-changing commit in the triggering history.

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

`dist/index.js` is committed. CI rebuilds it with ncc and fails when generated output differs.

## Required caller configuration

- GitHub Actions auto-merge enabled
- merge commits enabled
- appropriate required checks on `main`
- the same action release ref for prepare and finalize
- a GitHub App with contents and pull request write permissions
- a protected `release` environment that permits `main`
- `REGISTRY_PASSWORD`, `APP_ID`, and `APP_PRIVATE_KEY` secrets

Registry host, repository, and username are ordinary workflow inputs; the registry password is the only registry credential secret.
