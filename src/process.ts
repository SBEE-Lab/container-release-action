import * as exec from '@actions/exec';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

export class ActionsCommandRunner implements CommandRunner {
  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    const result = await exec.getExecOutput(command, [...args], {
      ignoreReturnCode: true,
      silent: true,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

export function commandText(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

export async function runChecked(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await runner.run(command, args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${commandText(command, args)} failed with exit code ${String(result.exitCode)}${detail ? `: ${detail}` : ''}`,
    );
  }
  return result;
}
