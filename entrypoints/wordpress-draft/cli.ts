import { DuplicateMissionRequestError } from './durable-audit.ts';
import { invokeWordPressArticleDraft } from './composition.ts';

interface ParsedArguments {
  readonly title: string;
  readonly contentHtml: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

function parseArguments(argumentsList: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  const allowed = new Set(['--title', '--content-html', '--request-id', '--correlation-id']);
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!option || !allowed.has(option) || value === undefined || values.has(option)) {
      throw new Error('Mission CLI input is invalid');
    }
    values.set(option, value);
  }
  const title = values.get('--title');
  const contentHtml = values.get('--content-html');
  if (!title?.trim() || !contentHtml?.trim()) throw new Error('Mission CLI input is invalid');
  const requestId = values.get('--request-id');
  const correlationId = values.get('--correlation-id');
  return {
    title,
    contentHtml,
    ...(requestId === undefined ? {} : { requestId }),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export async function runWordPressDraftCli(
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => process.stdout.write(line),
): Promise<number> {
  try {
    const result = await invokeWordPressArticleDraft(parseArguments(argumentsList), { environment });
    write(`${JSON.stringify(result)}\n`);
    return result.status === 'SUCCEEDED' ? 0 : 1;
  } catch (error) {
    const code = error instanceof DuplicateMissionRequestError ? 'DUPLICATE_REQUEST' : 'MISSION_ENTRYPOINT_FAILED';
    write(`${JSON.stringify({ status: 'FAILED', code })}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runWordPressDraftCli(process.argv.slice(2));
}
