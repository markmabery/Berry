import {BaseCommand}            from '@yarnpkg/cli';
import {Configuration, Project} from '@yarnpkg/core';
import {StreamReport}           from '@yarnpkg/core';
import {Command, Usage}         from 'clipanion';

import {Constraints}            from '../../Constraints';

// eslint-disable-next-line arca/no-default-export
export default class ConstraintsQueryCommand extends BaseCommand {
  @Command.Boolean(`--json`)
  json: boolean = false;

  @Command.String()
  query!: string;

  static usage: Usage = Command.Usage({
    category: `Constraints-related commands`,
    description: `query the constraints fact database`,
    details: `
      This command will output all matches to the given prolog query.

      If the \`--json\` flag is set the output will follow a JSON-stream output also known as NDJSON (https://github.com/ndjson/ndjson-spec).
    `,
    examples: [[
      `List all dependencies throughout the workspace`,
      `yarn constraints query 'workspace_has_dependency(_, DependencyName, _, _).'`,
    ]],
  });

  @Command.Path(`constraints`, `query`)
  async execute() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const {project} = await Project.find(configuration, this.context.cwd);
    const constraints = await Constraints.find(project);

    let query = this.query;
    if (!query.endsWith(`.`))
      query = `${query}.`;

    const report = await StreamReport.start({
      configuration,
      json: this.json,
      stdout: this.context.stdout,
    }, async report => {
      for await (const result of constraints.query(query)) {
        const lines = Array.from(Object.entries(result));
        const lineCount = lines.length;

        const maxVariableNameLength = lines.reduce((max, [variableName]) => Math.max(max, variableName.length), 0);

        for (let i = 0; i < lineCount; i++) {
          const [variableName, value] = lines[i];
          report.reportInfo(null, `${getLinePrefix(i, lineCount)}${variableName.padEnd(maxVariableNameLength, ` `)} = ${valueToString(value)}`);
        }

        report.reportJson(result);
      }
    });

    return report.exitCode();
  }
}

function valueToString(value: string|null): string {
  if (typeof value !== `string`)
    return `${value}`;

  if (value.match(/^[a-zA-Z][a-zA-Z0-9_]+$/))
    return value;

  return `'${value}'`;
}

function getLinePrefix(index: number, count: number): string {
  const isFirst = index === 0;
  const isLast = index === count - 1;

  if (isFirst && isLast)
    return ``;

  if (isFirst)
    return `┌ `;
  if (isLast)
    return `└ `;

  return `│ `;
}
