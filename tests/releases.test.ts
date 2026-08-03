import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverReleaseTargets, releaseMatrixJson } from '../src/releases.js';
import { commandResult, FakeRunner } from './helpers.js';

const config = {
  releases: [
    {
      id: 'api',
      manifestPath: '.github/releases/api.json',
      imageRepository: 'example.test/org/api',
      registryHost: 'example.test',
      registryUsername: 'release-bot',
      environment: 'release-api',
    },
    {
      id: 'worker',
      manifestPath: '.github/releases/worker.json',
      imageRepository: 'example.test/org/worker',
      registryHost: 'example.test',
      registryUsername: 'release-bot',
    },
  ],
};

describe('multi-release discovery', () => {
  it('selects only trusted explicit or changed release streams', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-releases-'));
    const configPath = join(root, 'releases.json');
    await writeFile(configPath, JSON.stringify(config));

    const explicit = await discoverReleaseTargets(new FakeRunner([]), {
      configPath,
      releaseId: 'api',
      beforeSha: '',
      afterSha: '',
    });
    expect(explicit).toEqual([
      expect.objectContaining({ releaseId: 'api', environment: 'release-api' }),
    ]);

    const changed = await discoverReleaseTargets(
      new FakeRunner([commandResult(0, '.github/releases/worker.json\0README.md\0')]),
      {
        configPath,
        releaseId: '',
        beforeSha: 'a'.repeat(40),
        afterSha: 'b'.repeat(40),
      },
    );
    expect(JSON.parse(releaseMatrixJson(changed))).toEqual([
      expect.objectContaining({
        releaseId: 'worker',
        manifestPath: '.github/releases/worker.json',
        environment: 'release',
      }),
    ]);

    await expect(
      discoverReleaseTargets(
        new FakeRunner([commandResult(0, '.github/releases/untrusted.json\0')]),
        {
          configPath,
          releaseId: '',
          beforeSha: 'a'.repeat(40),
          afterSha: 'b'.repeat(40),
        },
      ),
    ).rejects.toThrow(/not present in the trusted config/);
  });
});
