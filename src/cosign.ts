import { basename, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

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

export interface EnsureRequest {
  manifest: ReleaseManifest;
  provenancePath: string;
  sbomPath: string;
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

function jsonStream(raw: string): unknown[] {
  const values: unknown[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start === -1) {
      if (/\s/.test(character ?? '')) continue;
      if (character !== '{' && character !== '[') {
        throw new Error('Cosign returned invalid attestation JSON');
      }
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          values.push(JSON.parse(raw.slice(start, index + 1)) as unknown);
        } catch (error) {
          throw new Error('Cosign returned invalid attestation JSON', {
            cause: error,
          });
        }
        start = -1;
      }
    }
  }
  if (start !== -1 || quoted || depth !== 0 || values.length === 0) {
    throw new Error('Cosign returned invalid attestation JSON');
  }
  return values;
}

function decodePredicates(raw: string): JsonObject[] {
  const entries: unknown[] = [];
  for (const value of jsonStream(raw)) {
    if (Array.isArray(value)) entries.push(...(value as unknown[]));
    else entries.push(value);
  }
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

function attestationArguments(
  manifest: ReleaseManifest,
  attestationType: string,
): string[] {
  return [
    'verify-attestation',
    ...verificationFlags(manifest),
    `--type=${attestationType}`,
    '--output=json',
    manifest.image.reference,
  ];
}

function absentEvidence(output: string): boolean {
  return /no signatures found|no matching signatures|no matching attestations|no attestations found/i.test(
    output,
  );
}

async function optionalVerifiedPredicates(
  runner: CommandRunner,
  manifest: ReleaseManifest,
  attestationType: string,
): Promise<JsonObject[]> {
  const args = attestationArguments(manifest, attestationType);
  const result = await runner.run('cosign', args);
  if (result.exitCode === 0) return decodePredicates(result.stdout);
  const detail = result.stderr.trim() || result.stdout.trim();
  if (absentEvidence(detail)) return [];
  throw new Error(
    `cosign ${args.join(' ')} failed with exit code ${String(result.exitCode)}${detail ? `: ${detail}` : ''}`,
  );
}

async function verifiedPredicates(
  runner: CommandRunner,
  manifest: ReleaseManifest,
  attestationType: string,
): Promise<JsonObject[]> {
  const result = await runChecked(
    runner,
    'cosign',
    attestationArguments(manifest, attestationType),
  );
  return decodePredicates(result.stdout);
}

async function assertPredicateFile(
  path: string,
  expectedHash: string,
  name: string,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${name} predicate is not valid JSON: ${path}`, { cause: error });
  }
  if (!isJsonObject(value) || sha256(canonicalJson(value)) !== expectedHash) {
    throw new Error(`${name} predicate does not match ${expectedHash}`);
  }
}

function matchingPredicate(
  predicates: readonly JsonObject[],
  expectedHash: string,
): string | undefined {
  for (const predicate of predicates) {
    const text = canonicalJson(predicate);
    if (sha256(text) === expectedHash) return text;
  }
  return undefined;
}

export async function ensureSupplyChain(
  runner: CommandRunner,
  request: EnsureRequest,
): Promise<void> {
  const { manifest } = request;
  await assertPredicateFile(
    request.provenancePath,
    manifest.artifacts.provenance.sha256,
    'provenance',
  );
  await assertPredicateFile(request.sbomPath, manifest.artifacts.sbom.sha256, 'SBOM');
  const verifyArgs = [
    'verify',
    ...verificationFlags(manifest),
    '--output=json',
    manifest.image.reference,
  ];
  const signature = await runner.run('cosign', verifyArgs);
  if (signature.exitCode !== 0) {
    const detail = signature.stderr.trim() || signature.stdout.trim();
    if (!absentEvidence(detail)) {
      throw new Error(
        `cosign ${verifyArgs.join(' ')} failed with exit code ${String(signature.exitCode)}${detail ? `: ${detail}` : ''}`,
      );
    }
    await runChecked(runner, 'cosign', ['sign', '--yes', manifest.image.reference]);
  }

  const provenanceType = manifest.artifacts.provenance.attestationType;
  const provenance = await optionalVerifiedPredicates(runner, manifest, provenanceType);
  if (
    matchingPredicate(provenance, manifest.artifacts.provenance.sha256) === undefined
  ) {
    await runChecked(runner, 'cosign', [
      'attest',
      '--yes',
      `--type=${provenanceType}`,
      '--predicate',
      request.provenancePath,
      manifest.image.reference,
    ]);
  }

  const sbomType = manifest.artifacts.sbom.attestationType;
  const sboms = await optionalVerifiedPredicates(runner, manifest, sbomType);
  if (matchingPredicate(sboms, manifest.artifacts.sbom.sha256) === undefined) {
    await runChecked(runner, 'cosign', [
      'attest',
      '--yes',
      `--type=${sbomType}`,
      '--predicate',
      request.sbomPath,
      manifest.image.reference,
    ]);
  }
}

function predicateWithHash(
  predicates: readonly JsonObject[],
  expectedHash: string,
  name: string,
): string {
  const match = matchingPredicate(predicates, expectedHash);
  if (match !== undefined) return match;
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
    release: {
      id: manifest.release.id,
      gitTag: manifest.release.gitTag,
    },
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
  for (const section of ['release', 'upstream', 'build', 'image']) {
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
