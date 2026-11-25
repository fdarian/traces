import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Console, Effect, Option, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { FileSystem } from 'effect/FileSystem';
import { UsageError } from '#/errors.ts';
import { emitRecord, outputMode } from '#/output.ts';
import { globalOptions } from '#/resolve.ts';

const SKILL_FILE = 'SKILL.md';
const REFERENCES_DIR = 'references';

// Resolved from this file, not the cwd, so it works from any directory the CLI runs in.
export const skillsRoot = resolve(
  fileURLToPath(new URL('../../skills/', import.meta.url)),
);

/** A shipped skill file that breaks the layout: a bug in the skills, not in the invocation. */
export class InvalidSkill extends Schema.TaggedError<InvalidSkill>()(
  'InvalidSkill',
  { message: Schema.String },
) {}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export interface ParsedSkill {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

const unquote = (value: string) =>
  /^(["']).*\1$/.test(value) && value.length >= 2 ? value.slice(1, -1) : value;

/** A leading `---` block of `key: value` lines; anything richer than that is not supported. */
export const parseFrontmatter = (path: string, text: string) => {
  const lines = text.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end === -1) {
    return new InvalidSkill({
      message: `${path}: missing the leading --- frontmatter block`,
    });
  }
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) {
      return new InvalidSkill({
        message: `${path}: frontmatter line "${line}" is not key: value`,
      });
    }
    fields[line.slice(0, colon).trim()] = unquote(line.slice(colon + 1).trim());
  }
  return Effect.succeed({
    fields,
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, ''),
  } satisfies ParsedSkill);
};

const requiredField = (path: string, parsed: ParsedSkill, key: string) => {
  const value = parsed.fields[key];
  return value === undefined || value === ''
    ? new InvalidSkill({ message: `${path}: frontmatter has no ${key}` })
    : Effect.succeed(value);
};

const skillDir = (root: string, name: string) => join(root, name);

const loadSkill = (root: string, name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const file = join(skillDir(root, name), SKILL_FILE);
    const parsed = yield* parseFrontmatter(
      file,
      yield* fileSystem.readFileString(file),
    );
    const declared = yield* requiredField(file, parsed, 'name');
    if (declared !== name) {
      return yield* new InvalidSkill({
        message: `${file}: frontmatter name "${declared}" does not match its directory "${name}"`,
      });
    }
    return {
      summary: {
        name,
        description: yield* requiredField(file, parsed, 'description'),
        path: skillDir(root, name),
      } satisfies SkillSummary,
      body: parsed.body,
    };
  });

const skillNames = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const names: Array<string> = [];
    for (const entry of yield* fileSystem.readDirectory(root)) {
      if (yield* fileSystem.exists(join(root, entry, SKILL_FILE))) {
        names.push(entry);
      }
    }
    return names.sort();
  });

export const listSkills = (root: string) =>
  Effect.gen(function* () {
    const summaries: Array<SkillSummary> = [];
    for (const name of yield* skillNames(root)) {
      summaries.push((yield* loadSkill(root, name)).summary);
    }
    return summaries;
  });

const referenceNames = (root: string, skill: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const directory = join(skillDir(root, skill), REFERENCES_DIR);
    if (!(yield* fileSystem.exists(directory))) return [];
    return (yield* fileSystem.readDirectory(directory))
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => entry.slice(0, -'.md'.length))
      .sort();
  });

const validNames = (names: ReadonlyArray<string>) =>
  names.length === 0 ? 'none' : names.join(', ');

/** Fails with a UsageError that lists what does exist. */
const requireSkill = (root: string, name: string) =>
  Effect.gen(function* () {
    const names = yield* skillNames(root);
    if (!names.includes(name)) {
      return yield* new UsageError({
        message: `unknown skill "${name}"`,
        hint: `valid skills: ${validNames(names)}; \`traces skills list\` shows them`,
      });
    }
    return name;
  });

const requireReference = (root: string, skill: string, name: string) =>
  Effect.gen(function* () {
    const names = yield* referenceNames(root, skill);
    if (!names.includes(name)) {
      return yield* new UsageError({
        message: `skill "${skill}" has no reference "${name}"`,
        hint: `valid references: ${validNames(names)}`,
      });
    }
    return name;
  });

const readReference = (root: string, skill: string, name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    return yield* fileSystem.readFileString(
      join(skillDir(root, skill), REFERENCES_DIR, `${name}.md`),
    );
  });

export interface GetOptions {
  readonly full: boolean;
  readonly reference: Option.Option<string>;
}

/** The markdown `traces skills get` prints, without trailing blank lines. */
export const renderSkill = (root: string, name: string, options: GetOptions) =>
  Effect.gen(function* () {
    if (options.full && Option.isSome(options.reference)) {
      return yield* new UsageError({
        message: '--full and --ref cannot be combined',
        hint: 'use --full for SKILL.md and every reference, or --ref <name> for one reference',
      });
    }
    yield* requireSkill(root, name);
    if (Option.isSome(options.reference)) {
      const reference = yield* requireReference(
        root,
        name,
        options.reference.value,
      );
      return (yield* readReference(root, name, reference)).trimEnd();
    }
    const skill = yield* loadSkill(root, name);
    if (!options.full) return skill.body.trimEnd();
    const sections = [skill.body.trimEnd()];
    for (const reference of yield* referenceNames(root, name)) {
      sections.push(
        `# reference: ${reference}`,
        (yield* readReference(root, name, reference)).trimEnd(),
      );
    }
    return sections.join('\n\n');
  });

/**
 * `--json` is a shared flag so it is accepted before or after the subcommand name:
 * `hoistGlobalFlags` turns `traces --json skills list` into `skills --json list`.
 */
const skillsBase = Command.make('skills').pipe(
  Command.withSharedFlags({ json: globalOptions.json }),
);

const listSkillRecords = (json: boolean) =>
  Effect.gen(function* () {
    const summaries = yield* listSkills(skillsRoot);
    const width = Math.max(...summaries.map((skill) => skill.name.length));
    for (const summary of summaries) {
      yield* emitRecord(
        outputMode(json),
        summary,
        (skill) => `${skill.name.padEnd(width)}  ${skill.description}`,
      );
    }
  });

const listExamples = [
  { command: 'traces skills list', description: 'one line per skill' },
  {
    command: 'traces skills list --json',
    description: 'NDJSON: name, description, path',
  },
];

const listCommand = Command.make('list', {}, () =>
  Effect.gen(function* () {
    const parent = yield* skillsBase;
    yield* listSkillRecords(parent.json);
  }),
).pipe(
  Command.withShortDescription('list the skills shipped with traces'),
  Command.withDescription(
    'One line per skill: `name  description` on a terminal, NDJSON `{name, description, path}` when piped or with --json. `path` is the skill directory.',
  ),
  Command.withExamples(listExamples),
);

const getCommand = Command.make(
  'get',
  {
    name: Argument.String('name').pipe(
      Argument.withDescription(
        'skill name, e.g. core; see `traces skills list`',
      ),
    ),
    full: Flag.Boolean('full').pipe(
      Flag.withDescription(
        'SKILL.md followed by every reference, each under a `# reference: <name>` header',
      ),
      Flag.withDefault(false),
    ),
    reference: Flag.String('ref').pipe(
      Flag.withDescription(
        "print one reference instead of SKILL.md; the names are in the skill's References section",
      ),
      Flag.optional,
    ),
  },
  (args) =>
    renderSkill(skillsRoot, args.name, {
      full: args.full,
      reference: args.reference,
    }).pipe(Effect.flatMap((markdown) => Console.log(markdown))),
).pipe(
  Command.withShortDescription('print a skill as markdown'),
  Command.withDescription(
    'Print the skill (SKILL.md without its frontmatter) as raw markdown on stdout; there is no JSON mode. Agents: `traces skills get core` is the entry point. An unknown skill or reference exits 2 and lists the valid names.',
  ),
  Command.withExamples([
    { command: 'traces skills get core' },
    {
      command: 'traces skills get core --ref tracing',
      description: 'one reference',
    },
    {
      command: 'traces skills get core --full',
      description: 'the skill and every reference',
    },
  ]),
);

const pathCommand = Command.make(
  'path',
  {
    name: Argument.String('name').pipe(
      Argument.withDescription(
        'skill name; without it the skills root is printed',
      ),
      Argument.optional,
    ),
  },
  (args) =>
    Effect.gen(function* () {
      if (Option.isNone(args.name)) return yield* Console.log(skillsRoot);
      const name = yield* requireSkill(skillsRoot, args.name.value);
      yield* Console.log(skillDir(skillsRoot, name));
    }),
).pipe(
  Command.withShortDescription('print where the skills live on disk'),
  Command.withDescription(
    'Print the absolute path of the skills root, or of one skill directory, e.g. to symlink it into an agent skills folder.',
  ),
  Command.withExamples([
    { command: 'traces skills path', description: 'the skills root' },
    {
      command: 'traces skills path core',
      description: "the core skill's directory",
    },
    {
      command:
        'ln -s "$(traces skills path core)" ~/.claude/skills/traces-core',
      description: 'install it as a Claude Code skill',
    },
  ]),
);

export const skillsCommand = skillsBase.pipe(
  Command.withHandler((args) => listSkillRecords(args.json)),
  Command.withShortDescription('read the guidance skills shipped with traces'),
  Command.withDescription(
    'Long-form guidance for agents (resolution, config, tracing, output, per-command notes), kept as markdown skills. Without a subcommand it lists them. AI agents: start with `traces skills get core`.',
  ),
  Command.withExamples(listExamples),
  Command.withSubcommands([listCommand, getCommand, pathCommand]),
);
