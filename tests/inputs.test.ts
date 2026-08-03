import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertRepositoryPath,
  verificationCertificateIdentityForWorkflow,
} from '../src/inputs.js';
import { certificateIdentityForWorkflow } from '../src/manifest.js';

describe('trusted inputs', () => {
  it('derives the signing and verification workflow identities', () => {
    expect(
      certificateIdentityForWorkflow(
        'owner/repo/.github/workflows/release.yaml@refs/heads/main',
      ),
    ).toBe(
      'https://github.com/owner/repo/.github/workflows/release.yaml@refs/heads/main',
    );
    expect(
      verificationCertificateIdentityForWorkflow(
        'SBEE-Lab/container-release-action/.github/workflows/finalize-release.yaml@refs/tags/v1.0.0',
      ),
    ).toBe(
      'https://github.com/SBEE-Lab/container-release-action/.github/workflows/prepare-release.yaml@refs/tags/v1.0.0',
    );
  });

  it('rejects paths outside the repository or through symlinks', async () => {
    for (const path of ['../release.json', '/tmp/release.json', '.git/config']) {
      expect(() => assertRepositoryPath(path, 'path')).toThrow(
        /safe repository-relative path/,
      );
    }

    const workspace = await mkdtemp(join(tmpdir(), 'container-release-path-'));
    await symlink('/tmp', join(workspace, 'linked'));
    expect(() => assertRepositoryPath('linked/secret', 'path', workspace)).toThrow(
      /symbolic link/,
    );
  });
});
