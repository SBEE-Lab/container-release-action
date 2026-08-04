import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    const manifestPath = join(root, '.github/releases/api.json');
    await mkdir(assets);
    await writeFile(
      sbom,
      '{"spdxVersion":"SPDX-2.3","documentNamespace":"https://example.test/random-1","creationInfo":{"created":"2026-08-04T00:00:00Z"}}\n',
    );

    const request = {
      releaseId: 'api',
      version: 'v1.2.3',
      sourceRepository: 'owner/source',
      sourceRevision,
      sourceDateEpoch: '1700000000',
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
      },
    };
    const generated = await createArtifacts(request);

    await expect(readReleaseManifest(manifestPath)).resolves.toEqual(generated);
    expect(generated.release).toEqual({ id: 'api', gitTag: 'api/v1.2.3' });
    expect(generated.artifacts.sbom.sha256).toBe(await sha256File(sbom));
    expect(generated.artifacts.provenance.sha256).toBe(await sha256File(provenance));
    const firstSbomHash = generated.artifacts.sbom.sha256;
    await writeFile(
      sbom,
      '{"spdxVersion":"SPDX-2.3","documentNamespace":"https://example.test/random-2","creationInfo":{"created":"2026-08-05T00:00:00Z"}}\n',
    );
    const repeated = await createArtifacts(request);
    expect(repeated.artifacts.sbom.sha256).toBe(firstSbomHash);
    expect(JSON.parse(await readFile(sbom, 'utf8'))).toMatchObject({
      documentNamespace: `https://sjanglab.org/spdx/${encodeURIComponent('example.test/org/image')}/${digest}`,
      creationInfo: { created: '2023-11-14T22:13:20Z' },
    });
  });
});
