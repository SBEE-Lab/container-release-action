import { readFile } from 'node:fs/promises';

import { assertReleaseId, isJsonObject } from './manifest.js';
import { assertRepositoryPath } from './inputs.js';
import type { CommandRunner } from './process.js';
import { runChecked } from './process.js';
import { assertImageRepository } from './registry.js';

export interface ReleaseTarget {
  releaseId: string;
  manifestPath: string;
  imageRepository: string;
  registryHost: string;
  registryUsername: string;
  environment: string;
}

interface DiscoverReleaseRequest {
  configPath: string;
  releaseId: string;
  beforeSha: string;
  afterSha: string;
}

const allowedTargetKeys = new Set([
  'id',
  'manifestPath',
  'imageRepository',
  'registryHost',
  'registryUsername',
  'environment',
]);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function requiredString(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

function releaseTarget(value: unknown, index: number): ReleaseTarget {
  const path = `releases[${String(index)}]`;
  if (!isJsonObject(value)) {
    throw new Error(`${path} must be an object`);
  }
  const unsupported = Object.keys(value).filter((key) => !allowedTargetKeys.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${path} contains unsupported fields: ${unsupported.join(', ')}`);
  }

  const releaseId = assertReleaseId(requiredString(value.id, `${path}.id`));
  const manifestPath = assertRepositoryPath(
    requiredString(value.manifestPath, `${path}.manifestPath`),
    `${path}.manifestPath`,
    process.env.GITHUB_WORKSPACE ?? process.cwd(),
  );
  const imageRepository = assertImageRepository(
    requiredString(value.imageRepository, `${path}.imageRepository`),
  );
  const registryHost = requiredString(value.registryHost, `${path}.registryHost`);
  if (imageRepository.split('/')[0] !== registryHost) {
    throw new Error(`${path}.registryHost does not match imageRepository`);
  }

  return {
    releaseId,
    manifestPath,
    imageRepository,
    registryHost,
    registryUsername: requiredString(
      value.registryUsername,
      `${path}.registryUsername`,
    ),
    environment:
      value.environment === undefined
        ? 'release'
        : requiredString(value.environment, `${path}.environment`),
  };
}

export async function readReleaseTargets(configPath: string): Promise<ReleaseTarget[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read release configuration ${configPath}`, {
      cause: error,
    });
  }
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((key) => key !== 'releases') ||
    !Array.isArray(value.releases) ||
    value.releases.length === 0 ||
    value.releases.length > 256
  ) {
    throw new Error('release configuration must contain only 1 to 256 release entries');
  }

  const targets = value.releases.map(releaseTarget);
  for (const [field, values] of [
    ['release ID', targets.map(({ releaseId }) => releaseId)],
    ['manifest path', targets.map(({ manifestPath }) => manifestPath)],
    ['image repository', targets.map(({ imageRepository }) => imageRepository)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      throw new Error(`release configuration contains a duplicate ${field}`);
    }
  }
  return targets;
}

function assertGitSha(value: string, name: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} must be a lowercase 40-character Git SHA`);
  }
  return value;
}

async function changedPaths(
  runner: CommandRunner,
  beforeSha: string,
  afterSha: string,
): Promise<string[]> {
  const after = assertGitSha(afterSha, 'after-sha');
  const before = assertGitSha(beforeSha, 'before-sha');
  const args = /^0{40}$/.test(before)
    ? ['ls-tree', '-r', '--name-only', '-z', after]
    : [
        'diff',
        '--name-only',
        '--no-renames',
        '--diff-filter=ACDMRT',
        '-z',
        before,
        after,
        '--',
      ];
  const result = await runChecked(runner, 'git', args);
  return result.stdout.split('\0').filter(Boolean);
}

export async function discoverReleaseTargets(
  runner: CommandRunner,
  request: DiscoverReleaseRequest,
): Promise<ReleaseTarget[]> {
  const targets = await readReleaseTargets(request.configPath);
  if (request.releaseId) {
    const releaseId = assertReleaseId(request.releaseId);
    const selected = targets.find((target) => target.releaseId === releaseId);
    if (!selected) {
      throw new Error(`release ID ${releaseId} is not present in the trusted config`);
    }
    return [selected];
  }
  if (!request.beforeSha || !request.afterSha) {
    throw new Error('before-sha and after-sha are required for release discovery');
  }

  const paths = await changedPaths(runner, request.beforeSha, request.afterSha);
  const byPath = new Map(targets.map((target) => [target.manifestPath, target]));
  const unknownConventionalPaths = paths.filter(
    (path) =>
      path.startsWith('.github/releases/') &&
      path.endsWith('.json') &&
      !byPath.has(path),
  );
  if (unknownConventionalPaths.length > 0) {
    throw new Error(
      `changed release manifests are not present in the trusted config: ${unknownConventionalPaths.join(', ')}`,
    );
  }

  const selected = targets
    .filter((target) => paths.includes(target.manifestPath))
    .sort((left, right) => left.releaseId.localeCompare(right.releaseId));
  if (selected.length === 0) {
    throw new Error('no configured release manifest changed');
  }
  return selected;
}

export function releaseMatrixJson(targets: readonly ReleaseTarget[]): string {
  return JSON.stringify(targets);
}
