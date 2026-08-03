import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { verifySupplyChain } from '../src/cosign.js';
import { canonicalJson, sha256 } from '../src/manifest.js';
import {
  attestationEnvelope,
  commandResult,
  FakeRunner,
  releaseManifest,
  workflowRef,
} from './helpers.js';

describe('Cosign verification', () => {
  it('restores matching attestations and rejects mismatched provenance', async () => {
    const manifest = releaseManifest();
    const provenance = {
      release: manifest.release,
      upstream: manifest.upstream,
      builder: { workflowRef },
      build: manifest.build,
      image: manifest.image,
    };
    const sbom = { spdxVersion: 'SPDX-2.3', packages: [] };
    manifest.artifacts.provenance.sha256 = sha256(canonicalJson(provenance));
    manifest.artifacts.sbom.sha256 = sha256(canonicalJson(sbom));

    const runner = new FakeRunner([
      commandResult(0, '[]'),
      commandResult(0, attestationEnvelope(provenance)),
      commandResult(0, attestationEnvelope(sbom)),
    ]);
    const assets = await mkdtemp(join(tmpdir(), 'container-release-cosign-'));
    await verifySupplyChain(runner, { manifest, assetsDirectory: assets });

    expect(JSON.parse(await readFile(join(assets, 'provenance.json'), 'utf8'))).toEqual(
      provenance,
    );
    expect(JSON.parse(await readFile(join(assets, 'sbom.spdx.json'), 'utf8'))).toEqual(
      sbom,
    );
    expect(runner.calls[0]?.args).toContain(
      `--certificate-identity=${manifest.supplyChain.certificateIdentity}`,
    );

    const tampered = structuredClone(manifest);
    tampered.upstream.tag = 'v1.2.4';
    tampered.image.tag = 'v1.2.4';
    const tamperedRunner = new FakeRunner([
      commandResult(0, '[]'),
      commandResult(0, attestationEnvelope(provenance)),
    ]);
    await expect(
      verifySupplyChain(tamperedRunner, { manifest: tampered }),
    ).rejects.toThrow(/provenance upstream does not match/);
  });
});
