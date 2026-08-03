import { readFile } from 'node:fs/promises';

import * as core from '@actions/core';

import { createArtifacts } from './artifacts.js';
import { signSupplyChain, verifySupplyChain } from './cosign.js';
import { preparePullRequest, publishRelease } from './github.js';
import {
  buildMetadataInput,
  certificateIdentityInput,
  input,
  operationInput,
  platformsInput,
  repositoryPathInput,
  requiredInput,
  tokenInput,
  verificationCertificateIdentity,
  versionPolicyInput,
  workflowProvenance,
  type Operation,
} from './inputs.js';
import {
  classifyRelease,
  githubActionsOidcIssuer,
  readOptionalReleaseState,
  readReleaseManifest,
} from './manifest.js';
import { ActionsCommandRunner } from './process.js';
import {
  assertImageRepository,
  assertStagingReference,
  digestFor,
  digestReference,
  promoteImage,
  verifyReference,
} from './registry.js';

const runner = new ActionsCommandRunner();

function assertPublishOperation(operation: Operation): void {
  if (operation !== 'publish') {
    throw new Error(`unhandled operation: ${operation}`);
  }
}

function releaseTitle(version: string): string {
  return input('release-title') || `Container release ${version}`;
}

function pullRequestBody(
  version: string,
  sourceRepository: string,
  sourceRevision: string,
  imageReference: string,
): string {
  return [
    '## Automated container release',
    '',
    `- Version: \`${version}\``,
    `- Source: \`${sourceRepository}@${sourceRevision}\``,
    `- Image: \`${imageReference}\``,
    '',
    'The staging image has been verified, signed, and attested.',
    'Merging this PR promotes the verified digest to the immutable final tag.',
    '',
  ].join('\n');
}

function defaultReleaseNotes(
  manifest: Awaited<ReturnType<typeof readReleaseManifest>>,
) {
  return [
    `## ${manifest.image.tag}`,
    '',
    '### Container',
    '',
    `- Image: \`${manifest.image.reference}\``,
    `- Platforms: ${manifest.image.platforms.map((value) => `\`${value}\``).join(', ')}`,
    `- Build backend: \`${manifest.build.backend}\``,
    '',
    '### Source',
    '',
    `- Repository: \`${manifest.upstream.repository}\``,
    `- Version: \`${manifest.upstream.tag}\``,
    `- Revision: \`${manifest.upstream.commit}\``,
    '',
    '### Supply chain',
    '',
    '- Cosign signature: verified',
    '- Provenance attestation: verified',
    '- SPDX JSON SBOM attestation: verified',
    '',
  ].join('\n');
}

async function run(): Promise<void> {
  const operation = operationInput();

  if (operation === 'resolve') {
    const repository = requiredInput('image-repository');
    const staging = assertStagingReference(
      repository,
      requiredInput('staging-reference'),
    );
    const digest = await digestFor(runner, staging);
    if (digest === null) {
      throw new Error(`staging image does not exist: ${staging}`);
    }
    core.setOutput('digest', digest);
    core.setOutput('reference', digestReference(repository, digest));
    return;
  }

  if (operation === 'inspect') {
    const repository = requiredInput('image-repository');
    const digest = requiredInput('image-digest');
    const staging = assertStagingReference(
      repository,
      requiredInput('staging-reference'),
    );
    await verifyReference(runner, staging, digest);
    core.setOutput('digest', digest);
    core.setOutput('reference', digestReference(repository, digest));
    return;
  }

  if (operation === 'artifacts') {
    const repository = requiredInput('image-repository');
    const digest = requiredInput('image-digest');
    const version = requiredInput('version');
    const sourceRepository = requiredInput('source-repository');
    const sourceRevision = requiredInput('source-revision');
    const staging = assertStagingReference(
      repository,
      requiredInput('staging-reference'),
    );
    await verifyReference(runner, staging, digest);
    const manifestPath = repositoryPathInput('manifest-path');
    const releaseAction = classifyRelease(
      await readOptionalReleaseState(manifestPath),
      {
        sourceRepository,
        version,
        sourceRevision,
        imageRepository: repository,
        imageDigest: digest,
      },
      versionPolicyInput(),
    );
    core.setOutput('release-action', releaseAction);
    core.setOutput('digest', digest);
    core.setOutput('reference', digestReference(repository, digest));
    core.setOutput('manifest-path', manifestPath);
    if (releaseAction === 'reconcile') {
      return;
    }
    await createArtifacts({
      version,
      sourceRepository,
      sourceRevision,
      imageRepository: repository,
      stagingReference: staging,
      imageDigest: digest,
      platforms: platformsInput(),
      buildBackend: requiredInput('build-backend'),
      buildMetadata: buildMetadataInput(),
      certificateIdentity: certificateIdentityInput(),
      certificateOidcIssuer: githubActionsOidcIssuer,
      attestationType: requiredInput('attestation-type'),
      manifestPath,
      assetsDirectory: repositoryPathInput('assets-directory'),
      sbomPath: repositoryPathInput('sbom-path'),
      provenancePath: repositoryPathInput('provenance-path'),
      workflow: workflowProvenance(),
    });
    return;
  }

  const manifestPath = repositoryPathInput('manifest-path');
  const manifest = await readReleaseManifest(manifestPath);
  const expectedRepository = input('image-repository');
  if (
    expectedRepository &&
    assertImageRepository(expectedRepository) !== manifest.image.repository
  ) {
    throw new Error(
      `release image repository ${manifest.image.repository} does not match expected ${expectedRepository}`,
    );
  }

  if (operation === 'validate') {
    core.setOutput('digest', manifest.image.digest);
    core.setOutput('reference', manifest.image.reference);
    core.setOutput('manifest-path', manifestPath);
    return;
  }

  if (operation === 'sign') {
    await verifyReference(
      runner,
      manifest.image.stagingReference,
      manifest.image.digest,
    );
    await signSupplyChain(runner, {
      imageReference: manifest.image.reference,
      provenancePath: repositoryPathInput('provenance-path'),
      sbomPath: repositoryPathInput('sbom-path'),
      provenanceAttestationType: manifest.artifacts.provenance.attestationType,
    });
    await verifySupplyChain(runner, { manifest });
    return;
  }

  if (operation === 'verify') {
    await verifyReference(
      runner,
      manifest.image.stagingReference,
      manifest.image.digest,
    );
    await verifySupplyChain(runner, {
      manifest,
      expectedCertificateIdentity: verificationCertificateIdentity(),
      assetsDirectory: repositoryPathInput('assets-directory'),
      manifestPath,
    });
    return;
  }

  if (operation === 'promote') {
    const finalReference = await promoteImage(runner, {
      imageRepository: manifest.image.repository,
      version: manifest.image.tag,
      stagingReference: manifest.image.stagingReference,
      expectedDigest: manifest.image.digest,
    });
    core.setOutput('final-reference', finalReference);
    return;
  }

  if (operation === 'prepare-pr') {
    const number = await preparePullRequest({
      token: tokenInput(),
      manifest,
      manifestPath,
      versionPolicy: versionPolicyInput(),
      baseBranch: requiredInput('base-branch'),
      title: releaseTitle(manifest.image.tag),
      body: pullRequestBody(
        manifest.image.tag,
        manifest.upstream.repository,
        manifest.upstream.commit,
        manifest.image.reference,
      ),
    });
    if (number !== null) {
      core.setOutput('pull-request-number', String(number));
    }
    return;
  }

  assertPublishOperation(operation);
  const releaseCommit = requiredInput('release-commit');
  if (!/^[0-9a-f]{40}$/.test(releaseCommit)) {
    throw new Error('release-commit must be a lowercase 40-character Git SHA');
  }
  const notesPath = input('release-notes-path');
  const notes = notesPath
    ? await readFile(repositoryPathInput('release-notes-path'), 'utf8')
    : defaultReleaseNotes(manifest);
  const url = await publishRelease({
    token: tokenInput(),
    manifest,
    manifestPath,
    assetsDirectory: repositoryPathInput('assets-directory'),
    releaseCommit,
    title: releaseTitle(manifest.image.tag),
    notes,
  });
  core.setOutput('release-url', url);
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
