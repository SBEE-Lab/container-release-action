import { basename, dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  assertBuildBackend,
  assertReleaseAssetNames,
  assertReleaseId,
  assertReleaseManifest,
  assertSourceRepository,
  assertSourceRevision,
  canonicalJson,
  gitTagForRelease,
  isJsonObject,
  sha256,
  type JsonObject,
  type JsonValue,
  type ReleaseManifest,
} from './manifest.js';
import {
  assertDigest,
  assertImageRepository,
  assertStagingReference,
  assertTag,
} from './registry.js';

export const spdxAttestationType = 'spdxjson';

export interface WorkflowProvenance {
  repository: string;
  workflowRef: string;
  workflowSha: string;
  ref: string;
  sha: string;
  runId: string;
}

export interface ArtifactRequest {
  releaseId: string;
  version: string;
  sourceRepository: string;
  sourceRevision: string;
  sourceDateEpoch: string;
  imageRepository: string;
  stagingReference: string;
  imageDigest: string;
  platforms: string[];
  buildBackend: string;
  buildMetadata: JsonObject;
  certificateIdentity: string;
  certificateOidcIssuer: string;
  attestationType: string;
  manifestPath: string;
  assetsDirectory: string;
  sbomPath: string;
  provenancePath: string;
  workflow: WorkflowProvenance;
}

function sourceDate(request: ArtifactRequest): string {
  if (!/^(0|[1-9][0-9]*)$/.test(request.sourceDateEpoch)) {
    throw new Error('source-date-epoch must be a non-negative integer');
  }
  const epoch = Number(request.sourceDateEpoch);
  if (!Number.isSafeInteger(epoch) || epoch > 253402300799) {
    throw new Error('source-date-epoch is outside the supported range');
  }
  return new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');
}

async function canonicalizeSbom(
  path: string,
  repository: string,
  digest: string,
  created: string,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`SBOM is not valid JSON: ${path}`, { cause: error });
  }
  if (!isJsonObject(parsed) || !isJsonObject(parsed.creationInfo)) {
    throw new Error(`SBOM must contain SPDX creationInfo: ${path}`);
  }
  parsed.documentNamespace = `https://sjanglab.org/spdx/${encodeURIComponent(repository)}/${digest}`;
  parsed.creationInfo.created = created;
  const canonical = canonicalJson(parsed);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonical);
  return canonical;
}

export async function createArtifacts(
  request: ArtifactRequest,
): Promise<ReleaseManifest> {
  const releaseId = assertReleaseId(request.releaseId);
  const version = assertTag(request.version);
  const repository = assertImageRepository(request.imageRepository);
  const digest = assertDigest(request.imageDigest);
  const stagingReference = assertStagingReference(repository, request.stagingReference);
  const sourceRepository = assertSourceRepository(request.sourceRepository);
  const sourceRevision = assertSourceRevision(request.sourceRevision);
  const buildBackend = assertBuildBackend(request.buildBackend);
  const created = sourceDate(request);
  if (!request.certificateIdentity || !request.certificateOidcIssuer) {
    throw new Error('certificate identity and OIDC issuer are required');
  }

  assertReleaseAssetNames(
    [request.manifestPath, request.sbomPath, request.provenancePath].map((path) =>
      basename(path),
    ),
  );
  await mkdir(request.assetsDirectory, { recursive: true });
  const sbom = await canonicalizeSbom(request.sbomPath, repository, digest, created);
  const imageReference = `${repository}@${digest}`;
  const provenance: JsonObject = {
    release: {
      id: releaseId,
      gitTag: gitTagForRelease(releaseId, version),
    },
    upstream: {
      repository: sourceRepository,
      tag: version,
      commit: sourceRevision,
    },
    builder: {
      callerRepository: request.workflow.repository,
      workflowRef: request.workflow.workflowRef,
      workflowSha: request.workflow.workflowSha,
      ref: request.workflow.ref,
      sha: request.workflow.sha,
      runId: request.workflow.runId,
    },
    build: {
      backend: buildBackend,
      metadata: request.buildMetadata,
    },
    image: {
      repository,
      tag: version,
      digest,
      reference: imageReference,
      platforms: request.platforms,
      stagingReference,
    },
  };
  const provenanceText = canonicalJson(provenance);
  await mkdir(dirname(request.provenancePath), { recursive: true });
  await writeFile(request.provenancePath, provenanceText);

  const manifest: ReleaseManifest = {
    release: {
      id: releaseId,
      gitTag: gitTagForRelease(releaseId, version),
    },
    upstream: {
      repository: sourceRepository,
      tag: version,
      commit: sourceRevision,
    },
    image: {
      repository,
      tag: version,
      digest,
      reference: imageReference,
      platforms: request.platforms,
      stagingReference,
    },
    supplyChain: {
      certificateIdentity: request.certificateIdentity,
      certificateOidcIssuer: request.certificateOidcIssuer,
    },
    build: {
      backend: buildBackend,
      metadata: request.buildMetadata,
    },
    artifacts: {
      provenance: {
        file: basename(request.provenancePath),
        sha256: sha256(provenanceText),
        attestationType: request.attestationType,
      },
      sbom: {
        file: basename(request.sbomPath),
        sha256: sha256(sbom),
        attestationType: spdxAttestationType,
      },
    },
  };

  const validatedManifest = assertReleaseManifest(manifest);
  const manifestText = canonicalJson(validatedManifest as unknown as JsonValue);
  await mkdir(dirname(request.manifestPath), { recursive: true });
  await writeFile(request.manifestPath, manifestText);
  const releaseAsset = join(request.assetsDirectory, basename(request.manifestPath));
  await writeFile(releaseAsset, manifestText);
  await writeChecksums(request.assetsDirectory, [
    releaseAsset,
    request.sbomPath,
    request.provenancePath,
  ]);
  return validatedManifest;
}

export async function writeChecksums(
  assetsDirectory: string,
  paths: readonly string[],
): Promise<void> {
  const entries = await Promise.all(
    paths.map(async (path) => `${sha256(await readFile(path))}  ${basename(path)}\n`),
  );
  await writeFile(join(assetsDirectory, 'SHA256SUMS'), entries.join(''));
}
