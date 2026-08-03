import { describe, expect, it } from 'vitest';

import { digestFor, promoteImage } from '../src/registry.js';
import {
  commandResult,
  digest,
  FakeRunner,
  inspected,
  otherDigest,
} from './helpers.js';

const promotion = {
  imageRepository: 'example.test/org/image',
  version: 'v1.2.3',
  stagingReference: 'example.test/org/image:staging-v1.2.3-1',
  expectedDigest: digest,
};

describe('registry operations', () => {
  it('distinguishes an absent manifest from registry failure', async () => {
    await expect(
      digestFor(
        new FakeRunner([commandResult(1, '', 'manifest unknown')]),
        'example.test/org/image:v1',
      ),
    ).resolves.toBeNull();
    await expect(
      digestFor(
        new FakeRunner([commandResult(1, '', 'unauthorized')]),
        'example.test/org/image:v1',
      ),
    ).rejects.toThrow('unauthorized');
  });

  it('promotes from the digest-qualified source without wrapping an index', async () => {
    const runner = new FakeRunner([
      inspected(digest),
      commandResult(1, '', 'not found'),
      commandResult(0),
      inspected(digest),
    ]);

    await expect(promoteImage(runner, promotion)).resolves.toBe(
      'example.test/org/image:v1.2.3',
    );
    expect(runner.calls[2]).toEqual({
      command: 'docker',
      args: [
        'buildx',
        'imagetools',
        'create',
        '--prefer-index=false',
        '--tag',
        'example.test/org/image:v1.2.3',
        `example.test/org/image@${digest}`,
      ],
    });
  });

  it('does not overwrite a conflicting final tag', async () => {
    const runner = new FakeRunner([inspected(digest), inspected(otherDigest)]);
    await expect(promoteImage(runner, promotion)).rejects.toThrow(
      `exists at ${otherDigest}`,
    );
    expect(runner.calls).toHaveLength(2);
  });
});
