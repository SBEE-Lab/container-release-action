import { basename, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { writeChecksums } from './artifacts.js';
import {
  assertReleaseAssetNames,
  canonicalJson,
  isJsonObject,
  sha256,
  type JsonObject,
  type JsonValue,
  type ReleaseManifest,
} from './manifest.js';
import type { CommandRunner } from './process.js';
import { runChecked } from './process.js';

export interface SignRequest {
  imageReference: string;
  provenancePath: string;
  sbomPath: string;
  provenanceAttestationType: string;
}

export async function signSupplyChain(
  runner: CommandRunner,
  request: SignRequest,
): Promise<void> {
  await runChecked(runner, 'cosign', ['sign', '--yes', request.imageReference]);
  await runChecked(runner, 'cosign', [
    'attest',
    '--yes',
    `--type=${request.provenanceAttestationType}`,
    '--predicate',
    request.provenancePath,
    request.imageReference,
  ]);
  await runChecked(runner, 'cosign', [
    'attest',
    '--yes',
    '--type=spdxjson',
    '--predicate',
    request.sbomPath,
    request.imageReference,
  ]);
}

function verificationFlags(manifest: ReleaseManifest): string[] {
  return [
    `--certificate-oidc-issuer=${manifest.supplyChain.certificateOidcIssuer}`,
    `--certificate-identity=${manifest.supplyChain.certificateIdentity}`,
  ];
}

interface AttestationEnvelope {
  payload?: unknown;
}

function decodePredicates(raw: string): JsonObject[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('Cosign returned invalid attestation JSON', { cause: error });
  }
  const entries = Array.isArray(value) ? value : [value];
  const predicates: JsonObject[] = [];
  for (const entry of entries) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const envelope = entry as AttestationEnvelope;
    if (typeof envelope.payload !== 'string') {
      continue;
    }
    let statement: unknown;
    try {
      statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
    } catch {
      continue;
    }
    if (isJsonObject(statement) && isJsonObject(statement.predicate)) {
      predicates.push(statement.predicate);
    }
  }
  return predicates;
}

async function verifiedPredicates(
  runner: CommandRunner,
  manifest: ReleaseManifest,
  attestationType: string,
): Promise<JsonObject[]> {
  const result = await runChecked(runner, 'cosign', [
    'verify-attestation',
    ...verificationFlags(manifest),
    `--type=${attestationType}`,
    '--output=json',
    manifest.image.reference,
  ]);
  return decodePredicates(result.stdout);
}

function predicateWithHash(
  predicates: readonly JsonObject[],
  expectedHash: string,
  name: string,
): string {
  for (const predicate of predicates) {
    const text = canonicalJson(predicate);
    if (sha256(text) === expectedHash) {
      return text;
    }
  }
  throw new Error(`no verified ${name} attestation matches ${expectedHash}`);
}

function assertProvenanceMatchesManifest(
  provenanceText: string,
  manifest: ReleaseManifest,
): void {
  const provenance = JSON.parse(provenanceText) as unknown;
  if (!isJsonObject(provenance)) {
    throw new Error('verified provenance predicate is not an object');
  }
  const expected: JsonObject = {
    upstream: {
      repository: manifest.upstream.repository,
      tag: manifest.upstream.tag,
      commit: manifest.upstream.commit,
    },
    build: {
      backend: manifest.build.backend,
      metadata: manifest.build.metadata,
    },
    image: {
      repository: manifest.image.repository,
      tag: manifest.image.tag,
      digest: manifest.image.digest,
      reference: manifest.image.reference,
      platforms: manifest.image.platforms,
      stagingReference: manifest.image.stagingReference,
    },
  };
  for (const section of ['upstream', 'build', 'image']) {
    if (
      canonicalJson(provenance[section] ?? null) !==
      canonicalJson(expected[section] ?? null)
    ) {
      throw new Error(`verified provenance ${section} does not match release manifest`);
    }
  }
  const builder = provenance.builder;
  const identityPrefix = 'https://github.com/';
  if (
    !isJsonObject(builder) ||
    builder.workflowRef !==
      manifest.supplyChain.certificateIdentity.slice(identityPrefix.length)
  ) {
    throw new Error('verified provenance builder does not match signing identity');
  }
}

export interface VerifyRequest {
  manifest: ReleaseManifest;
  expectedCertificateIdentity?: string;
  assetsDirectory?: string;
  manifestPath?: string;
}

export async function verifySupplyChain(
  runner: CommandRunner,
  request: VerifyRequest,
): Promise<void> {
  const { manifest } = request;
  if (
    request.expectedCertificateIdentity !== undefined &&
    manifest.supplyChain.certificateIdentity !== request.expectedCertificateIdentity
  ) {
    throw new Error(
      `release certificate identity ${manifest.supplyChain.certificateIdentity} does not match trusted signer ${request.expectedCertificateIdentity}`,
    );
  }
  await runChecked(runner, 'cosign', [
    'verify',
    ...verificationFlags(manifest),
    '--output=json',
    manifest.image.reference,
  ]);

  const provenance = predicateWithHash(
    await verifiedPredicates(
      runner,
      manifest,
      manifest.artifacts.provenance.attestationType,
    ),
    manifest.artifacts.provenance.sha256,
    'provenance',
  );
  assertProvenanceMatchesManifest(provenance, manifest);
  const sbom = predicateWithHash(
    await verifiedPredicates(runner, manifest, manifest.artifacts.sbom.attestationType),
    manifest.artifacts.sbom.sha256,
    'SBOM',
  );

  if (request.assetsDirectory) {
    assertReleaseAssetNames([
      manifest.artifacts.provenance.file,
      manifest.artifacts.sbom.file,
      ...(request.manifestPath ? [basename(request.manifestPath)] : []),
    ]);
    await mkdir(request.assetsDirectory, { recursive: true });
    const provenancePath = join(
      request.assetsDirectory,
      manifest.artifacts.provenance.file,
    );
    const sbomPath = join(request.assetsDirectory, manifest.artifacts.sbom.file);
    await writeFile(provenancePath, provenance);
    await writeFile(sbomPath, sbom);
    const paths = [provenancePath, sbomPath];
    if (request.manifestPath) {
      const manifestAsset = join(
        request.assetsDirectory,
        basename(request.manifestPath),
      );
      await writeFile(manifestAsset, canonicalJson(manifest as unknown as JsonValue));
      paths.unshift(manifestAsset);
    }
    await writeChecksums(request.assetsDirectory, paths);
  }
}
