import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import * as core from '@actions/core';
import * as github from '@actions/github';

import {
  assertReleaseId,
  assertSourceRepository,
  certificateIdentityForWorkflow,
  defaultManifestPath,
  defaultReleaseId,
  parseJsonObject,
  parsePlatforms,
  type JsonObject,
  type VersionPolicy,
} from './manifest.js';

export type Operation =
  | 'resolve'
  | 'inspect'
  | 'validate'
  | 'artifacts'
  | 'sign'
  | 'verify'
  | 'promote'
  | 'prepare-pr'
  | 'publish';

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

const operations = new Set<Operation>([
  'resolve',
  'inspect',
  'validate',
  'artifacts',
  'sign',
  'verify',
  'promote',
  'prepare-pr',
  'publish',
]);

export function operationInput(): Operation {
  const value = requiredInput('operation');
  if (!operations.has(value as Operation)) {
    throw new Error(`unsupported operation: ${value}`);
  }
  return value as Operation;
}

export function input(name: string): string {
  return core.getInput(name, { trimWhitespace: true });
}

export function requiredInput(name: string): string {
  return core.getInput(name, { required: true, trimWhitespace: true });
}

export function tokenInput(): string {
  const token = requiredInput('token');
  core.setSecret(token);
  return token;
}

export function platformsInput(): string[] {
  return parsePlatforms(requiredInput('platforms-json'));
}

export function buildMetadataInput(): JsonObject {
  return parseJsonObject(requiredInput('build-metadata-json'), 'build-metadata-json');
}

export function versionPolicyInput(): VersionPolicy {
  const value = requiredInput('version-policy');
  if (value !== 'semver' && value !== 'none') {
    throw new Error(`unsupported version policy: ${value}`);
  }
  return value;
}

export function assertRepositoryPath(
  value: string,
  name: string,
  workspace?: string,
): string {
  const components = value.split('/');
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    hasControlCharacter(value) ||
    components.some(
      (component) =>
        component.length === 0 ||
        component === '.' ||
        component === '..' ||
        component === '.git',
    )
  ) {
    throw new Error(`${name} must be a safe repository-relative path`);
  }
  if (workspace) {
    let current = realpathSync(workspace);
    for (const component of components) {
      current = resolve(current, component);
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error(`${name} must not traverse a symbolic link`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          break;
        }
        throw error;
      }
    }
  }
  return value;
}

export function repositoryPathInput(name: string): string {
  return assertRepositoryPath(
    requiredInput(name),
    name,
    process.env.GITHUB_WORKSPACE ?? process.cwd(),
  );
}

export function releaseIdInput(): string {
  return assertReleaseId(input('release-id') || defaultReleaseId);
}

export function manifestPathInput(releaseId = releaseIdInput()): string {
  return assertRepositoryPath(
    input('manifest-path') || defaultManifestPath(releaseId),
    'manifest-path',
    process.env.GITHUB_WORKSPACE ?? process.cwd(),
  );
}

function builderWorkflowRef(): string {
  const workflowRef = input('builder-workflow-ref') || process.env.GITHUB_WORKFLOW_REF;
  if (!workflowRef) {
    throw new Error('GitHub builder workflow ref is required');
  }
  return workflowRef;
}

export function certificateIdentityInput(): string {
  return certificateIdentityForWorkflow(builderWorkflowRef());
}

export function verificationCertificateIdentityForWorkflow(
  workflowRef: string,
): string {
  const finalizeMarker = '/.github/workflows/finalize-release.yaml@';
  const markerIndex = workflowRef.indexOf(finalizeMarker);
  if (markerIndex === -1) {
    return certificateIdentityForWorkflow(workflowRef);
  }
  const prepareWorkflowRef = `${workflowRef.slice(0, markerIndex)}/.github/workflows/prepare-release.yaml@${workflowRef.slice(markerIndex + finalizeMarker.length)}`;
  return certificateIdentityForWorkflow(prepareWorkflowRef);
}

export function verificationCertificateIdentity(): string {
  return verificationCertificateIdentityForWorkflow(builderWorkflowRef());
}

export function workflowProvenance() {
  const repository = process.env.GITHUB_REPOSITORY;
  const workflowRef = builderWorkflowRef();
  const workflowSha = input('builder-workflow-sha') || process.env.GITHUB_WORKFLOW_SHA;
  if (!repository || !workflowSha) {
    throw new Error('GitHub workflow repository and SHA are required');
  }
  assertSourceRepository(repository);
  certificateIdentityForWorkflow(workflowRef);
  if (!/^[0-9a-f]{40}$/.test(workflowSha)) {
    throw new Error('GitHub builder workflow SHA must be a lowercase Git SHA');
  }
  return {
    repository,
    workflowRef,
    workflowSha,
    ref: github.context.ref,
    sha: github.context.sha,
    runId: String(github.context.runId),
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
  };
}
