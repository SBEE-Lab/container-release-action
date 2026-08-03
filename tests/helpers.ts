import type { JsonObject, ReleaseManifest, ReleaseState } from '../src/manifest.js';
import type { CommandResult, CommandRunner } from '../src/process.js';

export const digest = `sha256:${'a'.repeat(64)}`;
export const otherDigest = `sha256:${'b'.repeat(64)}`;
export const sourceRevision = 'd'.repeat(40);
export const workflowRef = 'owner/repo/.github/workflows/release.yml@refs/heads/main';

export function releaseManifest(): ReleaseManifest {
  return {
    upstream: {
      repository: 'owner/source',
      tag: 'v1.2.3',
      commit: sourceRevision,
    },
    image: {
      repository: 'example.test/org/image',
      tag: 'v1.2.3',
      digest,
      reference: `example.test/org/image@${digest}`,
      platforms: ['linux/amd64'],
      stagingReference: 'example.test/org/image:staging-v1.2.3-1',
    },
    supplyChain: {
      certificateIdentity: `https://github.com/${workflowRef}`,
      certificateOidcIssuer: 'https://token.actions.githubusercontent.com',
    },
    build: { backend: 'buildx', metadata: {} },
    artifacts: {
      provenance: {
        file: 'provenance.json',
        sha256: 'b'.repeat(64),
        attestationType: 'https://example.test/provenance/v1',
      },
      sbom: {
        file: 'sbom.spdx.json',
        sha256: 'c'.repeat(64),
        attestationType: 'spdxjson',
      },
    },
  };
}

export function releaseState(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    sourceRepository: 'owner/source',
    version: 'v1.2.3',
    sourceRevision,
    imageRepository: 'example.test/org/image',
    imageDigest: digest,
    ...overrides,
  };
}

export class FakeRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];

  constructor(private readonly results: CommandResult[]) {}

  run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const result = this.results.shift();
    if (!result) {
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    }
    return Promise.resolve(result);
  }
}

export function commandResult(
  exitCode: number,
  stdout = '',
  stderr = '',
): CommandResult {
  return { exitCode, stdout, stderr };
}

export function inspected(value: string): CommandResult {
  return commandResult(0, `Name: example.test/org/image:test\nDigest: ${value}\n`);
}

export function attestationEnvelope(predicate: JsonObject): string {
  const payload = Buffer.from(
    JSON.stringify({
      _type: 'https://in-toto.io/Statement/v0.1',
      predicate,
    }),
  ).toString('base64');
  return JSON.stringify([{ payload }]);
}
