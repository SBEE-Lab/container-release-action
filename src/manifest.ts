import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  assertDigest,
  assertImageRepository,
  assertStagingReference,
  assertTag,
} from './registry.js';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ArtifactDescriptor {
  file: string;
  sha256: string;
  attestationType: string;
}

export interface ReleaseState {
  sourceRepository: string;
  version: string;
  sourceRevision: string;
  imageRepository: string;
  imageDigest: string;
}

export type ReleaseAction = 'update' | 'reconcile';
export type VersionPolicy = 'semver' | 'none';

export const githubActionsOidcIssuer = 'https://token.actions.githubusercontent.com';

const platformPattern =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/;
const workflowRefPattern =
  /^([^/]+\/[^/]+)\/\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml@\S+$/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

export interface ReleaseManifest {
  upstream: {
    repository: string;
    tag: string;
    commit: string;
  };
  image: {
    repository: string;
    tag: string;
    digest: string;
    reference: string;
    platforms: string[];
    stagingReference: string;
  };
  supplyChain: {
    certificateIdentity: string;
    certificateOidcIssuer: string;
  };
  build: {
    backend: string;
    metadata: JsonObject;
  };
  artifacts: {
    provenance: ArtifactDescriptor;
    sbom: ArtifactDescriptor;
  };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortedJson);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sortedJson(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return `${JSON.stringify(sortedJson(value), null, 2)}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export function parseJsonObject(value: string, name: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} is not valid JSON`, { cause: error });
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed;
}

function checkedPlatforms(
  value: unknown,
  path: string,
  deduplicate: boolean,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty platform string array`);
  }
  const platforms = value.filter(
    (platform): platform is string =>
      typeof platform === 'string' && platformPattern.test(platform),
  );
  if (platforms.length !== value.length) {
    throw new Error(`${path} contains an invalid OCI platform`);
  }
  const unique = [...new Set(platforms)];
  if (!deduplicate && unique.length !== platforms.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
  return unique;
}

export function parsePlatforms(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('platforms-json is not valid JSON', { cause: error });
  }
  return checkedPlatforms(parsed, 'platforms-json', true);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

export function assertSourceRepository(value: string): string {
  const components = value.split('/');
  if (
    components.length !== 2 ||
    components.some(
      (component) =>
        !/^[A-Za-z0-9_.-]+$/.test(component) || component === '.' || component === '..',
    )
  ) {
    throw new Error('source repository must use safe owner/name form');
  }
  return value;
}

export function assertSourceRevision(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('source revision must be a lowercase 40-character Git SHA');
  }
  return value;
}

export function assertBuildBackend(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('build backend must be a safe identifier');
  }
  return value;
}

export function certificateIdentityForWorkflow(workflowRef: string): string {
  const match = workflowRefPattern.exec(workflowRef);
  if (!match?.[1] || hasControlCharacter(workflowRef)) {
    throw new Error(`invalid GitHub workflow ref: ${workflowRef}`);
  }
  assertSourceRepository(match[1]);
  return `https://github.com/${workflowRef}`;
}

function assertCertificateIdentity(value: string): string {
  const prefix = 'https://github.com/';
  if (!value.startsWith(prefix)) {
    throw new Error('certificate identity must be an exact GitHub workflow URI');
  }
  const workflowRef = value.slice(prefix.length);
  if (certificateIdentityForWorkflow(workflowRef) !== value) {
    throw new Error('certificate identity must be an exact GitHub workflow URI');
  }
  return value;
}

export function assertReleaseAssetNames(files: readonly string[]): void {
  if (
    files.some(
      (file) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) || file === 'SHA256SUMS',
    ) ||
    new Set(files).size !== files.length
  ) {
    throw new Error('release asset filenames must be safe and distinct');
  }
}

function safeAssetFile(value: unknown, path: string): string {
  const file = requiredString(value, path);
  try {
    assertReleaseAssetNames([file]);
  } catch (error) {
    throw new Error(`${path} must be a safe asset filename`, { cause: error });
  }
  return file;
}

function artifact(value: unknown, path: string): ArtifactDescriptor {
  if (!isJsonObject(value)) {
    throw new Error(`${path} must be an object`);
  }
  const digest = requiredString(value.sha256, `${path}.sha256`);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${path}.sha256 must be a lowercase SHA256 checksum`);
  }
  return {
    file: safeAssetFile(value.file, `${path}.file`),
    sha256: digest,
    attestationType: requiredString(value.attestationType, `${path}.attestationType`),
  };
}

export function assertReleaseManifest(value: unknown): ReleaseManifest {
  if (!isJsonObject(value)) {
    throw new Error('release manifest must be an object');
  }
  const upstream = value.upstream;
  const image = value.image;
  const supplyChain = value.supplyChain;
  const build = value.build;
  const artifacts = value.artifacts;
  if (
    !isJsonObject(upstream) ||
    !isJsonObject(image) ||
    !isJsonObject(supplyChain) ||
    !isJsonObject(build) ||
    !isJsonObject(artifacts)
  ) {
    throw new Error('release manifest is missing required sections');
  }

  const repository = assertImageRepository(
    requiredString(image.repository, 'image.repository'),
  );
  const tag = assertTag(requiredString(image.tag, 'image.tag'));
  const digest = assertDigest(requiredString(image.digest, 'image.digest'));
  const platforms = checkedPlatforms(image.platforms, 'image.platforms', false);
  const metadata = build.metadata;
  if (!isJsonObject(metadata)) {
    throw new Error('build.metadata must be an object');
  }

  const sourceRepository = assertSourceRepository(
    requiredString(upstream.repository, 'upstream.repository'),
  );
  const sourceCommit = assertSourceRevision(
    requiredString(upstream.commit, 'upstream.commit'),
  );

  const manifest: ReleaseManifest = {
    upstream: {
      repository: sourceRepository,
      tag: assertTag(requiredString(upstream.tag, 'upstream.tag')),
      commit: sourceCommit,
    },
    image: {
      repository,
      tag,
      digest,
      reference: requiredString(image.reference, 'image.reference'),
      platforms,
      stagingReference: assertStagingReference(
        repository,
        requiredString(image.stagingReference, 'image.stagingReference'),
      ),
    },
    supplyChain: {
      certificateIdentity: assertCertificateIdentity(
        requiredString(
          supplyChain.certificateIdentity,
          'supplyChain.certificateIdentity',
        ),
      ),
      certificateOidcIssuer: requiredString(
        supplyChain.certificateOidcIssuer,
        'supplyChain.certificateOidcIssuer',
      ),
    },
    build: {
      backend: assertBuildBackend(requiredString(build.backend, 'build.backend')),
      metadata,
    },
    artifacts: {
      provenance: artifact(artifacts.provenance, 'artifacts.provenance'),
      sbom: artifact(artifacts.sbom, 'artifacts.sbom'),
    },
  };

  if (manifest.image.reference !== `${repository}@${digest}`) {
    throw new Error('image.reference does not match image.repository and image.digest');
  }
  if (manifest.upstream.tag !== tag) {
    throw new Error('upstream.tag and image.tag must match');
  }
  if (manifest.image.stagingReference === `${repository}:${tag}`) {
    throw new Error('staging and final image references must differ');
  }
  if (manifest.supplyChain.certificateOidcIssuer !== githubActionsOidcIssuer) {
    throw new Error(
      `supplyChain.certificateOidcIssuer must be ${githubActionsOidcIssuer}`,
    );
  }
  if (manifest.artifacts.provenance.file === manifest.artifacts.sbom.file) {
    throw new Error('provenance and SBOM asset filenames must differ');
  }
  return manifest;
}

export function releaseStateFromValue(value: unknown): ReleaseState {
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.upstream) ||
    !isJsonObject(value.image)
  ) {
    throw new Error('existing release manifest is missing upstream or image state');
  }
  return {
    sourceRepository: assertSourceRepository(
      requiredString(value.upstream.repository, 'upstream.repository'),
    ),
    version: assertTag(requiredString(value.upstream.tag, 'upstream.tag')),
    sourceRevision: assertSourceRevision(
      requiredString(value.upstream.commit, 'upstream.commit'),
    ),
    imageRepository: assertImageRepository(
      requiredString(value.image.repository, 'image.repository'),
    ),
    imageDigest: assertDigest(requiredString(value.image.digest, 'image.digest')),
  };
}

export async function readOptionalReleaseState(
  path: string,
): Promise<ReleaseState | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`could not read existing release state ${path}`, {
      cause: error,
    });
  }
  try {
    return releaseStateFromValue(JSON.parse(text));
  } catch (error) {
    throw new Error(`invalid existing release state ${path}`, { cause: error });
  }
}

function semanticVersion(version: string): readonly [bigint, bigint, bigint] {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`semantic version policy requires vX.Y.Z; got ${version}`);
  }
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function compareVersions(
  left: readonly [bigint, bigint, bigint],
  right: readonly [bigint, bigint, bigint],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const leftComponent = left[index] ?? 0n;
    const rightComponent = right[index] ?? 0n;
    if (leftComponent < rightComponent) {
      return -1;
    }
    if (leftComponent > rightComponent) {
      return 1;
    }
  }
  return 0;
}

export function classifyRelease(
  current: ReleaseState | null,
  next: ReleaseState,
  policy: VersionPolicy,
): ReleaseAction {
  const nextSemanticVersion =
    policy === 'semver' ? semanticVersion(next.version) : null;
  const currentSemanticVersion =
    policy === 'semver' && current !== null ? semanticVersion(current.version) : null;
  if (current === null) {
    return 'update';
  }
  if (current.sourceRepository !== next.sourceRepository) {
    throw new Error('source repository does not match existing release state');
  }
  if (current.imageRepository !== next.imageRepository) {
    throw new Error('image repository does not match existing release state');
  }
  if (current.version === next.version) {
    if (current.sourceRevision !== next.sourceRevision) {
      throw new Error(
        `source tag ${next.version} moved from ${current.sourceRevision} to ${next.sourceRevision}`,
      );
    }
    if (current.imageDigest !== next.imageDigest) {
      throw new Error(
        `release ${next.version} already records ${current.imageDigest}, refusing ${next.imageDigest}`,
      );
    }
    return 'reconcile';
  }
  if (
    nextSemanticVersion !== null &&
    currentSemanticVersion !== null &&
    compareVersions(nextSemanticVersion, currentSemanticVersion) < 0
  ) {
    throw new Error(`release ${next.version} is older than current ${current.version}`);
  }
  return 'update';
}

export async function readReleaseManifest(path: string): Promise<ReleaseManifest> {
  let text: string;
  let value: unknown;
  try {
    text = await readFile(path, 'utf8');
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`could not read release manifest ${path}`, { cause: error });
  }
  const manifest = assertReleaseManifest(value);
  if (
    canonicalJson(value as JsonValue) !==
    canonicalJson(manifest as unknown as JsonValue)
  ) {
    throw new Error(`release manifest ${path} contains unsupported fields`);
  }
  return manifest;
}
