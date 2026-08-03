import type { CommandRunner } from './process.js';
import { runChecked } from './process.js';

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const repositoryComponent = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*';
const repositoryPattern = new RegExp(
  `^${repositoryComponent}(?::[0-9]+)?(?:/${repositoryComponent})*$`,
);
const missingManifestPattern =
  /manifest unknown|manifest_unknown|name_unknown|not found|404/i;

export function assertDigest(value: string, name = 'digest'): string {
  if (!digestPattern.test(value)) {
    throw new Error(`${name} must be a lowercase sha256 digest; got ${value}`);
  }
  return value;
}

export function assertImageRepository(value: string): string {
  if (!repositoryPattern.test(value)) {
    throw new Error(`invalid image repository: ${value}`);
  }
  return value;
}

export function assertTag(value: string): string {
  if (!/^[\w][\w.-]{0,127}$/.test(value)) {
    throw new Error(`invalid OCI tag: ${value}`);
  }
  return value;
}

export function digestReference(repository: string, digest: string): string {
  return `${assertImageRepository(repository)}@${assertDigest(digest)}`;
}

export function taggedReference(repository: string, tag: string): string {
  return `${assertImageRepository(repository)}:${assertTag(tag)}`;
}

export function assertStagingReference(
  repository: string,
  stagingReference: string,
): string {
  const prefix = `${assertImageRepository(repository)}:`;
  if (!stagingReference.startsWith(prefix)) {
    throw new Error(
      `staging reference ${stagingReference} must be a tag in ${repository}`,
    );
  }
  assertTag(stagingReference.slice(prefix.length));
  return stagingReference;
}

export async function digestFor(
  runner: CommandRunner,
  reference: string,
): Promise<string | null> {
  const result = await runner.run('docker', [
    'buildx',
    'imagetools',
    'inspect',
    reference,
  ]);
  if (result.exitCode !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`;
    if (missingManifestPattern.test(detail)) {
      return null;
    }
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `could not inspect ${reference}`,
    );
  }

  const match = /^Digest:\s+(sha256:[0-9a-f]{64})\s*$/m.exec(result.stdout);
  if (!match?.[1]) {
    throw new Error(`could not determine digest for ${reference}`);
  }
  return assertDigest(match[1]);
}

export async function verifyReference(
  runner: CommandRunner,
  reference: string,
  expectedDigest: string,
): Promise<string> {
  const expected = assertDigest(expectedDigest, 'expected digest');
  const actual = await digestFor(runner, reference);
  if (actual === null) {
    throw new Error(`image reference does not exist: ${reference}`);
  }
  if (actual !== expected) {
    throw new Error(`${reference} has ${actual}, expected ${expected}`);
  }
  return actual;
}

export interface PromotionRequest {
  imageRepository: string;
  version: string;
  stagingReference: string;
  expectedDigest: string;
}

export async function promoteImage(
  runner: CommandRunner,
  request: PromotionRequest,
): Promise<string> {
  const expected = assertDigest(request.expectedDigest, 'expected digest');
  const finalReference = taggedReference(request.imageRepository, request.version);
  const stagingReference = assertStagingReference(
    request.imageRepository,
    request.stagingReference,
  );
  if (stagingReference === finalReference) {
    throw new Error('staging and final image references must differ');
  }
  await verifyReference(runner, stagingReference, expected);

  const existing = await digestFor(runner, finalReference);
  if (existing !== null && existing !== expected) {
    throw new Error(
      `final tag ${finalReference} exists at ${existing}, expected ${expected}`,
    );
  }

  if (existing === null) {
    await runChecked(runner, 'docker', [
      'buildx',
      'imagetools',
      'create',
      '--prefer-index=false',
      '--tag',
      finalReference,
      digestReference(request.imageRepository, expected),
    ]);
  }

  await verifyReference(runner, finalReference, expected);
  return finalReference;
}
