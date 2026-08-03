# Security Policy

## Reporting

Report suspected vulnerabilities privately to the SBEE Lab repository maintainers. Do not open a public issue containing credentials, signing material, or an exploitable release path.

## Release invariants

- Final image tags are immutable.
- A staging reference must resolve to the digest recorded in `release.json`.
- Signatures and attestations are created and verified against digest-qualified references.
- Promotion must preserve the exact manifest digest.
- Existing final tags at a different digest are rejected.
- Release assets must match the checksums committed in the release manifest.
- GitHub App and registry credentials must be passed through the `secrets` interface.
- The signing identity is derived from the pinned prepare reusable workflow; repository content cannot select another identity.
- Finalization requires the manifest image repository to match the caller workflow configuration.
- The annotated Git tag is bound to the manifest-changing commit reachable from the trigger SHA after its content is rechecked through the GitHub API.

## Version pinning

Consumers should pin this action and its reusable workflows to an immutable full release tag or commit SHA. Moving major tags may be offered for convenience but are a weaker trust boundary.
