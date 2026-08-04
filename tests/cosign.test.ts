import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { ensureSupplyChain, verifySupplyChain } from '../src/cosign.js';
import { canonicalJson, sha256, type JsonObject } from '../src/manifest.js';
import {
  attestationEnvelope,
  commandResult,
  FakeRunner,
  releaseManifest,
  workflowRef,
} from './helpers.js';

async function predicateFiles(
  provenance: JsonObject,
  sbom: JsonObject,
): Promise<{ provenancePath: string; sbomPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'container-release-predicates-'));
  const provenancePath = join(root, 'provenance.json');
  const sbomPath = join(root, 'sbom.spdx.json');
  await writeFile(provenancePath, canonicalJson(provenance));
  await writeFile(sbomPath, canonicalJson(sbom));
  return { provenancePath, sbomPath };
}

describe('Cosign verification', () => {
  it('accepts JSON streams and selects matching attestations', async () => {
    const manifest = releaseManifest();
    const provenance = {
      release: manifest.release,
      upstream: manifest.upstream,
      builder: { workflowRef },
      build: manifest.build,
      image: manifest.image,
    };
    const unrelated = { value: 'unrelated' };
    const sbom = { spdxVersion: 'SPDX-2.3', packages: [] };
    manifest.artifacts.provenance.sha256 = sha256(canonicalJson(provenance));
    manifest.artifacts.sbom.sha256 = sha256(canonicalJson(sbom));
    const runner = new FakeRunner([
      commandResult(0, '[]'),
      commandResult(
        0,
        `${attestationEnvelope(unrelated)}\n${attestationEnvelope(provenance)}`,
      ),
      commandResult(
        0,
        `${attestationEnvelope(unrelated)}\n${attestationEnvelope(sbom)}`,
      ),
    ]);

    await expect(verifySupplyChain(runner, { manifest })).resolves.toBeUndefined();
  });

  it('does not write evidence that already matches the release', async () => {
    const manifest = releaseManifest();
    const provenance = { release: manifest.release };
    const sbom = { spdxVersion: 'SPDX-2.3' };
    manifest.artifacts.provenance.sha256 = sha256(canonicalJson(provenance));
    manifest.artifacts.sbom.sha256 = sha256(canonicalJson(sbom));
    const runner = new FakeRunner([
      commandResult(0, '[]'),
      commandResult(0, attestationEnvelope(provenance)),
      commandResult(0, attestationEnvelope(sbom)),
    ]);
    const paths = await predicateFiles(provenance, sbom);

    await ensureSupplyChain(runner, { manifest, ...paths });

    expect(runner.calls).toHaveLength(3);
    expect(runner.calls.every(({ args }) => args[0]?.startsWith('verify'))).toBe(true);
  });

  it('creates only missing supply-chain evidence', async () => {
    const manifest = releaseManifest();
    const provenance = { release: manifest.release };
    const sbom = { spdxVersion: 'SPDX-2.3' };
    manifest.artifacts.provenance.sha256 = sha256(canonicalJson(provenance));
    manifest.artifacts.sbom.sha256 = sha256(canonicalJson(sbom));
    const runner = new FakeRunner([
      commandResult(0, '[]'),
      commandResult(0, attestationEnvelope(provenance)),
      commandResult(1, '', 'no matching attestations'),
      commandResult(0),
    ]);
    const paths = await predicateFiles(provenance, sbom);

    await ensureSupplyChain(runner, { manifest, ...paths });

    expect(runner.calls.filter(({ args }) => args[0] === 'attest')).toHaveLength(1);
    expect(
      runner.calls.at(-1)?.args.some((arg) => arg.endsWith('sbom.spdx.json')),
    ).toBe(true);
  });

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
