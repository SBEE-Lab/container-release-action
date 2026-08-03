import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import * as github from '@actions/github';

import {
  assertReleaseAssetNames,
  canonicalJson,
  classifyRelease,
  defaultReleaseId,
  releaseStateFromValue,
  sha256,
  type JsonValue,
  type ReleaseManifest,
  type ReleaseState,
  type VersionPolicy,
} from './manifest.js';

export type Octokit = ReturnType<typeof github.getOctokit>;

function isStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === status
  );
}

function releaseBranch(releaseId: string, version: string): string {
  const branch = `release/${releaseId}/${version}`;
  if (branch.length > 240) {
    throw new Error(`release ID and version form an overlong branch: ${branch}`);
  }
  return branch;
}

export interface PreparePullRequestRequest {
  token: string;
  manifest: ReleaseManifest;
  manifestPath: string;
  versionPolicy: VersionPolicy;
  baseBranch: string;
  title: string;
  body: string;
}

function manifestContentMatches(content: string, manifest: ReleaseManifest): boolean {
  try {
    return (
      canonicalJson(JSON.parse(content) as JsonValue) ===
      canonicalJson(manifest as unknown as JsonValue)
    );
  } catch {
    return false;
  }
}

function manifestState(manifest: ReleaseManifest): ReleaseState {
  return {
    releaseId: manifest.release.id,
    sourceRepository: manifest.upstream.repository,
    version: manifest.upstream.tag,
    sourceRevision: manifest.upstream.commit,
    imageRepository: manifest.image.repository,
    imageDigest: manifest.image.digest,
  };
}

async function repositoryFileAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    const data = response.data;
    if (
      Array.isArray(data) ||
      data.type !== 'file' ||
      data.encoding !== 'base64' ||
      typeof data.content !== 'string'
    ) {
      throw new Error(`${path} is not a base64-encoded repository file`);
    }
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    if (isStatus(error, 404)) {
      return null;
    }
    throw error;
  }
}

async function releaseStateAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<ReleaseState | null> {
  const content = await repositoryFileAtRef(octokit, owner, repo, path, ref);
  return content === null ? null : releaseStateFromValue(JSON.parse(content));
}

export async function preparePullRequest(
  request: PreparePullRequestRequest,
): Promise<number | null> {
  const octokit = github.getOctokit(request.token);
  const { owner, repo } = github.context.repo;
  const branch = releaseBranch(request.manifest.release.id, request.manifest.image.tag);
  const content = await readFile(request.manifestPath, 'utf8');

  const baseRef = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${request.baseBranch}`,
  });
  const currentState = await releaseStateAtRef(
    octokit,
    owner,
    repo,
    request.manifestPath,
    baseRef.data.object.sha,
  );
  if (
    classifyRelease(
      currentState,
      manifestState(request.manifest),
      request.versionPolicy,
    ) === 'reconcile'
  ) {
    return null;
  }
  const baseCommit = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: baseRef.data.object.sha,
  });
  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.data.tree.sha,
    tree: [
      {
        path: request.manifestPath,
        mode: '100644',
        type: 'blob',
        content,
      },
    ],
  });
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: `release: track ${request.manifest.release.id} ${request.manifest.image.tag}\n\nPublish ${request.manifest.image.reference}.`,
    tree: tree.data.sha,
    parents: [baseRef.data.object.sha],
  });

  try {
    await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commit.data.sha,
      force: true,
    });
  } catch (error) {
    if (!isStatus(error, 404)) {
      throw error;
    }
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: commit.data.sha,
    });
  }

  const existing = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    base: request.baseBranch,
    head: `${owner}:${branch}`,
    per_page: 1,
  });
  let pullRequest;
  if (existing.data[0]) {
    pullRequest = (
      await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: existing.data[0].number,
        title: request.title,
        body: request.body,
      })
    ).data;
  } else {
    pullRequest = (
      await octokit.rest.pulls.create({
        owner,
        repo,
        base: request.baseBranch,
        head: branch,
        title: request.title,
        body: request.body,
      })
    ).data;
  }

  try {
    await octokit.graphql(
      `mutation EnableReleaseAutoMerge(
        $pullRequestId: ID!
        $expectedHeadOid: GitObjectID!
      ) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId
          mergeMethod: MERGE
          expectedHeadOid: $expectedHeadOid
        }) {
          pullRequest { number }
        }
      }`,
      {
        pullRequestId: pullRequest.node_id,
        expectedHeadOid: commit.data.sha,
      },
    );
  } catch (error) {
    const live = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullRequest.number,
    });
    if (
      live.data.merged ||
      live.data.auto_merge?.merge_method.toLowerCase() === 'merge'
    ) {
      return pullRequest.number;
    }
    if (live.data.mergeable === true && live.data.mergeable_state === 'clean') {
      await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: pullRequest.number,
        merge_method: 'merge',
        sha: commit.data.sha,
      });
    } else {
      throw new Error('could not enable merge-commit auto-merge', { cause: error });
    }
  }
  return pullRequest.number;
}

async function tagTarget(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<string> {
  try {
    const tag = await octokit.rest.git.getTag({ owner, repo, tag_sha: sha });
    if (tag.data.object.type === 'tag') {
      return await tagTarget(octokit, owner, repo, tag.data.object.sha);
    }
    return tag.data.object.sha;
  } catch (error) {
    if (isStatus(error, 404) || isStatus(error, 422)) {
      return sha;
    }
    throw error;
  }
}

async function ensureAnnotatedTag(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string,
  commit: string,
): Promise<void> {
  try {
    const existing = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `tags/${tag}`,
    });
    if (existing.data.object.type !== 'tag') {
      throw new Error(`tag ${tag} exists but is not annotated`);
    }
    const target = await tagTarget(octokit, owner, repo, existing.data.object.sha);
    if (target !== commit) {
      throw new Error(`tag ${tag} targets ${target}, expected ${commit}`);
    }
    return;
  } catch (error) {
    if (!isStatus(error, 404)) {
      throw error;
    }
  }

  const tagObject = await octokit.rest.git.createTag({
    owner,
    repo,
    tag,
    message: `Container release ${tag}`,
    object: commit,
    type: 'commit',
    tagger: {
      name: 'SBEE Lab release bot',
      email: 'actions@users.noreply.github.com',
      date: new Date().toISOString(),
    },
  });
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/tags/${tag}`,
    sha: tagObject.data.sha,
  });
}

interface ReleaseAsset {
  name: string;
  data: string;
}

async function verifiedReleaseAssets(
  request: PublishReleaseRequest,
): Promise<ReleaseAsset[]> {
  const manifestName = basename(request.manifestPath);
  const contentNames = [
    manifestName,
    request.manifest.artifacts.sbom.file,
    request.manifest.artifacts.provenance.file,
  ];
  assertReleaseAssetNames(contentNames);

  const dataByName = new Map<string, string>();
  for (const name of [...contentNames, 'SHA256SUMS']) {
    dataByName.set(name, await readFile(join(request.assetsDirectory, name), 'utf8'));
  }

  const manifestData = dataByName.get(manifestName);
  if (manifestData !== canonicalJson(request.manifest as unknown as JsonValue)) {
    throw new Error('release manifest asset is not canonical or does not match');
  }
  for (const descriptor of [
    request.manifest.artifacts.sbom,
    request.manifest.artifacts.provenance,
  ]) {
    const data = dataByName.get(descriptor.file);
    if (data === undefined || sha256(data) !== descriptor.sha256) {
      throw new Error(`release asset ${descriptor.file} does not match its checksum`);
    }
  }

  const expectedChecksums = contentNames
    .map((name) => `${sha256(dataByName.get(name) ?? '')}  ${name}\n`)
    .join('');
  if (dataByName.get('SHA256SUMS') !== expectedChecksums) {
    throw new Error('SHA256SUMS does not match release assets');
  }
  return [...contentNames, 'SHA256SUMS'].map((name) => ({
    name,
    data: dataByName.get(name) ?? '',
  }));
}

export interface PublishReleaseRequest {
  token: string;
  manifest: ReleaseManifest;
  manifestPath: string;
  assetsDirectory: string;
  releaseCommit: string;
  title: string;
  notes: string;
}

export async function publishRelease(request: PublishReleaseRequest): Promise<string> {
  const assets = await verifiedReleaseAssets(request);
  const octokit = github.getOctokit(request.token);
  const { owner, repo } = github.context.repo;
  const commits = await octokit.rest.repos.listCommits({
    owner,
    repo,
    sha: request.releaseCommit,
    path: request.manifestPath,
    per_page: 1,
  });
  const releaseCommit = commits.data[0]?.sha;
  if (!releaseCommit) {
    throw new Error(
      `could not find ${request.manifestPath} in the history of ${request.releaseCommit}`,
    );
  }
  const committedManifest = await repositoryFileAtRef(
    octokit,
    owner,
    repo,
    request.manifestPath,
    releaseCommit,
  );
  if (
    committedManifest === null ||
    !manifestContentMatches(committedManifest, request.manifest)
  ) {
    throw new Error(
      `${request.manifestPath} at ${releaseCommit} does not match the verified release manifest`,
    );
  }
  await ensureAnnotatedTag(
    octokit,
    owner,
    repo,
    request.manifest.release.gitTag,
    releaseCommit,
  );

  const namespacedRelease = request.manifest.release.id !== defaultReleaseId;
  let release;
  try {
    release = (
      await octokit.rest.repos.getReleaseByTag({
        owner,
        repo,
        tag: request.manifest.release.gitTag,
      })
    ).data;
    release = (
      await octokit.rest.repos.updateRelease({
        owner,
        repo,
        release_id: release.id,
        tag_name: request.manifest.release.gitTag,
        name: request.title,
        body: request.notes,
        draft: false,
        prerelease: false,
        ...(namespacedRelease ? { make_latest: 'false' as const } : {}),
      })
    ).data;
  } catch (error) {
    if (!isStatus(error, 404)) {
      throw error;
    }
    release = (
      await octokit.rest.repos.createRelease({
        owner,
        repo,
        tag_name: request.manifest.release.gitTag,
        name: request.title,
        body: request.notes,
        draft: false,
        prerelease: false,
        ...(namespacedRelease ? { make_latest: 'false' as const } : {}),
      })
    ).data;
  }

  const assetNames = assets.map(({ name }) => name);
  const existingAssets = await octokit.paginate(octokit.rest.repos.listReleaseAssets, {
    owner,
    repo,
    release_id: release.id,
    per_page: 100,
  });
  for (const asset of existingAssets) {
    if (assetNames.includes(asset.name)) {
      await octokit.rest.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: asset.id,
      });
    }
  }
  for (const { name, data } of assets) {
    await octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id: release.id,
      name,
      data,
      headers: {
        'content-type': name.endsWith('.json')
          ? 'application/json'
          : 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(data),
      },
    });
  }
  return release.html_url;
}
