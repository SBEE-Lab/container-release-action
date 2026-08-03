import { describe, expect, it } from 'vitest';

import {
  assertReleaseManifest,
  classifyRelease,
  defaultManifestPath,
  type ReleaseManifest,
} from '../src/manifest.js';
import { digest, releaseManifest, releaseState } from './helpers.js';

describe('release manifests', () => {
  it('rejects inconsistent security-sensitive fields', () => {
    expect(defaultManifestPath('api')).toBe('.github/releases/api.json');
    expect(assertReleaseManifest(releaseManifest()).image.digest).toBe(digest);

    const namespaced = releaseManifest();
    namespaced.release.id = 'api';
    namespaced.release.gitTag = 'api/v1.2.3';
    expect(assertReleaseManifest(namespaced).release.gitTag).toBe('api/v1.2.3');

    const cases: {
      mutate: (manifest: ReleaseManifest) => void;
      error: RegExp;
    }[] = [
      {
        mutate: (manifest) => {
          manifest.release.id = 'API';
        },
        error: /release ID/,
      },
      {
        mutate: (manifest) => {
          manifest.release.id = 'api';
        },
        error: /release\.gitTag does not match/,
      },
      {
        mutate: (manifest) => {
          manifest.image.reference = `example.test/org/other@${digest}`;
        },
        error: /does not match/,
      },
      {
        mutate: (manifest) => {
          manifest.image.stagingReference = 'example.test/org/image:v1.2.3';
        },
        error: /must differ/,
      },
      {
        mutate: (manifest) => {
          manifest.artifacts.sbom.file = '../sbom.json';
        },
        error: /safe asset filename/,
      },
      {
        mutate: (manifest) => {
          manifest.supplyChain.certificateOidcIssuer = 'https://issuer.example';
        },
        error: /token\.actions\.githubusercontent\.com/,
      },
    ];

    for (const { mutate, error } of cases) {
      const candidate = releaseManifest();
      mutate(candidate);
      expect(() => assertReleaseManifest(candidate)).toThrow(error);
    }
  });

  it('classifies releases without weakening immutable state', () => {
    const current = releaseState();
    expect(classifyRelease(null, current, 'semver')).toBe('update');
    expect(classifyRelease(current, current, 'semver')).toBe('reconcile');
    expect(
      classifyRelease(current, releaseState({ version: 'v1.3.0' }), 'semver'),
    ).toBe('update');

    const rejected = [
      [releaseState({ releaseId: 'other' }), /release ID/],
      [releaseState({ sourceRevision: 'e'.repeat(40) }), /moved/],
      [releaseState({ imageDigest: `sha256:${'c'.repeat(64)}` }), /refusing/],
      [releaseState({ version: 'v1.2.2' }), /older/],
      [releaseState({ version: 'latest' }), /requires vX\.Y\.Z/],
    ] as const;
    for (const [next, error] of rejected) {
      expect(() => classifyRelease(current, next, 'semver')).toThrow(error);
    }
  });
});
