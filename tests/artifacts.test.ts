import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createArtifacts } from '../src/artifacts.js';
import { readReleaseManifest, sha256File } from '../src/manifest.js';
import { digest, sourceRevision, workflowRef } from './helpers.js';

describe('artifact generation', () => {
  it('records the generated SBOM and provenance checksums', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-release-action-'));
    const assets = join(root, '.release-assets');
    const sbom = join(assets, 'sbom.spdx.json');
    const provenance = join(assets, 'provenance.json');
    const manifestPath = join(root, 'release.json');
    await mkdir(assets);
    await writeFile(sbom, '{"spdxVersion":"SPDX-2.3"}\n');

    const generated = await createArtifacts({
      version: 'v1.2.3',
      sourceRepository: 'owner/source',
      sourceRevision,
      imageRepository: 'example.test/org/image',
      stagingReference: 'example.test/org/image:staging-v1.2.3-1',
      imageDigest: digest,
      platforms: ['linux/amd64'],
      buildBackend: 'nix',
      buildMetadata: {},
      certificateIdentity: `https://github.com/${workflowRef}`,
      certificateOidcIssuer: 'https://token.actions.githubusercontent.com',
      attestationType: 'https://example.test/provenance/v1',
      manifestPath,
      assetsDirectory: assets,
      sbomPath: sbom,
      provenancePath: provenance,
      workflow: {
        repository: 'owner/repo',
        workflowRef,
        workflowSha: 'f'.repeat(40),
        ref: 'refs/heads/main',
        sha: 'e'.repeat(40),
        runId: '123',
        runAttempt: '1',
      },
    });

    await expect(readReleaseManifest(manifestPath)).resolves.toEqual(generated);
    expect(generated.artifacts.sbom.sha256).toBe(await sha256File(sbom));
    expect(generated.artifacts.provenance.sha256).toBe(await sha256File(provenance));
  });
});
