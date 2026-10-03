import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBin, HARNESS_NAMES, HARNESSES } from '../src/reviewers/index.ts';
import { resultText } from '../src/reviewers/run.ts';
import type { ReviewerInput } from '../src/reviewers/types.ts';
import { removeProjectFiles } from '../src/runner.ts';
import type { HarnessName } from '../src/types.ts';
import { DIMENSIONS, type Verdict } from '../src/verdict.ts';

const verdict: Verdict = {
  summary: 'Adds median().',
  score: 4,
  scoreRationale: 'Small and tested.',
  dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, { score: 4, note: 'ok' }])) as Verdict['dimensions'],
  findings: [],
};

/** Environment variables the harnesses set to lock a CLI down; the fake records only these. */
const LOCKDOWN_VARS = [
  'GROK_CLAUDE_HOOKS_ENABLED',
  'GROK_CLAUDE_MCPS_ENABLED',
  'GROK_CURSOR_MCPS_ENABLED',
  'HERMES_WRITE_SAFE_ROOT',
  'TERMINAL_CWD',
  'VIBE_ENABLE_TELEMETRY',
  'VIBE_ACTIVE_MODEL',
  'OPENCODE_DISABLE_PROJECT_CONFIG',
  'OPENCODE_PERMISSION',
  'KILO_NO_DAEMON',
  'KILO_DISABLE_PROJECT_CONFIG',
  'KILO_PERMISSION',
  'GEMINI_CLI_TRUST_WORKSPACE',
];

/**
 * A stand-in CLI: records its argv, stdin, and lockdown env vars, prints `stdout`, and copies it to the file
 * after `-o` (how codex hands back its answer). `tools` is what it prints for `tools list` (auggie).
 */
function fakeCli(stdout: string, opts: { exitCode?: number; tools?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-fake-cli-'));
  writeFileSync(join(dir, 'out'), stdout);
  writeFileSync(join(dir, 'tools'), opts.tools ?? '');
  const bin = join(dir, 'cli');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = tools ]; then cat "${dir}/tools"; exit 0; fi
printf '%s\\n' "$@" > "${dir}/argv"
for v in ${LOCKDOWN_VARS.join(' ')}; do eval "printf '%s=%s\\n' \\"\\$v\\" \\"\\\${$v-}\\"" >> "${dir}/env"; done
cat > "${dir}/stdin"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && cp "${dir}/out" "$2"; shift; done
cat "${dir}/out"
exit ${opts.exitCode ?? 0}
`,
  );
  chmodSync(bin, 0o755);
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  return {
    dir,
    bin,
    ran: () => existsSync(join(dir, 'argv')),
    argv: () => read('argv').trimEnd().split('\n'),
    stdin: () => read('stdin'),
    env: () => read('env').trimEnd().split('\n'),
  };
}

const run = (name: HarnessName, cli: ReturnType<typeof fakeCli>, input: Partial<ReviewerInput> = {}) =>
  HARNESSES[name].run({
    bin: cli.bin,
    dir: cli.dir,
    prompt: 'review this',
    schemaPath: join(cli.dir, 'schema.json'),
    scratchDir: cli.dir,
    timeoutMs: 10_000,
    ...input,
  });

/** True when `flag` appears in argv immediately followed by `value`. */
const hasPair = (argv: string[], flag: string, value: string) =>
  argv.some((a, i) => a === flag && argv[i + 1] === value);

const envelope = (result: string, isError = false) =>
  JSON.stringify({ type: 'result', subtype: isError ? 'error' : 'success', is_error: isError, result });

describe('claude', () => {
  test('runs restricted with read tools only and reads the result out of the message array', async () => {
    const cli = fakeCli(
      JSON.stringify([
        { type: 'system', subtype: 'init' },
        { type: 'result', subtype: 'success', is_error: false, structured_output: verdict },
      ]),
    );
    const out = await run('claude', cli, { model: 'claude-opus-5-5', effort: 'max' });
    expect(out.verdict).toEqual(verdict);
    const argv = cli.argv();
    expect(argv).toContain('--restricted');
    expect(argv).toContain('--strict-mcp-config');
    expect(hasPair(argv, '--permission-mode', 'dontAsk')).toBe(true);
    expect(hasPair(argv, '--tools', 'Read,Grep,Glob')).toBe(true);
    expect(argv.slice(argv.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Grep', 'Glob']);
    expect(argv.join(' ')).not.toContain('Bash');
    expect(hasPair(argv, '--model', 'claude-opus-5-5')).toBe(true);
    expect(cli.stdin()).toBe('review this');
  });

  test('still reads the single result object older CLIs print, and reports is_error as a failure', async () => {
    const ok = await run('claude', fakeCli(JSON.stringify({ type: 'result', structured_output: verdict })));
    expect(ok.verdict).toEqual(verdict);
    const failed = await run('claude', fakeCli(JSON.stringify({ type: 'result', is_error: true, result: 'no auth' })));
    expect(failed.code).toBe(1);
    expect(failed.raw).toBe('no auth');
  });

  test('leaves model and effort to the CLI when unset', async () => {
    const cli = fakeCli(JSON.stringify({ structured_output: verdict }));
    await run('claude', cli);
    expect(cli.argv()).not.toContain('--model');
    expect(cli.argv()).not.toContain('--effort');
  });
});

test('codex runs in the read-only sandbox without user config and reads the -o file', async () => {
  const cli = fakeCli(JSON.stringify(verdict));
  const out = await run('codex', cli, { model: 'gpt-6-astra', effort: 'high' });
  expect(out.verdict).toEqual(verdict);
  const argv = cli.argv();
  expect(hasPair(argv, '--sandbox', 'read-only')).toBe(true);
  expect(argv).toContain('--ignore-user-config');
  expect(argv).toContain('--ignore-rules');
  expect(hasPair(argv, '-c', 'model_reasoning_effort="high"')).toBe(true);
  expect(argv.at(-1)).toBe('-');
});

describe('droid', () => {
  test('runs exec at its read-only default with read tools only', async () => {
    const cli = fakeCli(envelope(`Done.\n${JSON.stringify(verdict)}`));
    const out = await run('droid', cli, { model: 'claude-opus-4-8', effort: 'high' });
    expect(out.verdict).toEqual(verdict);
    const argv = cli.argv();
    expect(argv[0]).toBe('exec');
    expect(hasPair(argv, '--only-tools', 'Read,Grep,Glob,LS')).toBe(true);
    expect(argv).not.toContain('--auto');
    expect(hasPair(argv, '-r', 'high')).toBe(true);
    expect(cli.stdin()).toBe('review this');
  });

  test('an is_error envelope fails with the CLI message', async () => {
    const out = await run('droid', fakeCli(envelope('Authentication failed', true)));
    expect(out.code).toBe(1);
    expect(out.error).toBe('the CLI reported an error: Authentication failed');
  });
});

describe('auggie', () => {
  const tools = ['view', 'save-file', 'launch-process', 'web-fetch', 'grep-search', 'sub-agent-code']
    .map((t) => `  ✓ ${t}   enabled`)
    .join('\n');

  test('lists its tools first and removes every one that is not read-only', async () => {
    const reply = `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``;
    const cli = fakeCli(`🔌 Waiting for 2 MCP server(s)...\n${envelope(reply)}`, { tools });
    const out = await run('auggie', cli);
    expect(out.verdict).toEqual(verdict);
    const argv = cli.argv();
    expect(argv.filter((_, i) => argv[i - 1] === '--remove-tool')).toEqual([
      'save-file',
      'launch-process',
      'web-fetch',
      'sub-agent-code',
    ]);
    expect(hasPair(argv, '--augment-cache-dir', join(cli.dir, 'augment'))).toBe(true);
    expect(argv).toContain('--print');
  });

  test('refuses to run when the tool list is unreadable', async () => {
    const cli = fakeCli(envelope('should not run'), { tools: 'Error: not logged in' });
    const out = await run('auggie', cli);
    expect(out.error).toStartWith('could not list auggie tools to lock it down');
    expect(cli.ran()).toBe(false);
  });
});

describe('grok', () => {
  test('keeps only read tools, turns off Claude and Cursor imports, and reads structuredOutput', async () => {
    const cli = fakeCli(JSON.stringify({ text: 'dup', stopReason: 'end_turn', structuredOutput: verdict }));
    const out = await run('grok', cli, { model: 'grok-4.7', effort: 'low' });
    expect(out.verdict).toEqual(verdict);
    const argv = cli.argv();
    expect(hasPair(argv, '--tools', 'read_file,grep,list_dir')).toBe(true);
    for (const flag of ['--disable-web-search', '--no-subagents', '--json-schema']) expect(argv).toContain(flag);
    expect(readFileSync(argv[argv.indexOf('--prompt-file') + 1]!, 'utf8')).toBe('review this');
    expect(cli.env()).toContain('GROK_CLAUDE_HOOKS_ENABLED=0');
    expect(cli.env()).toContain('GROK_CLAUDE_MCPS_ENABLED=0');
    expect(cli.env()).toContain('GROK_CURSOR_MCPS_ENABLED=0');
  });

  test('a cancelled turn with no structured output is a failure', async () => {
    const out = await run('grok', fakeCli(JSON.stringify({ text: '', stopReason: 'cancelled' })));
    expect(out.verdict).toBeUndefined();
    expect(out.error).toStartWith('unreadable verdict');
  });
});

test('hermes takes the prompt in argv with file tools only and a write root inside scratch', async () => {
  const cli = fakeCli(`${JSON.stringify(verdict)}\n\n⚠️ File-mutation verifier: 2 file(s) were NOT modified this turn`);
  const out = await run('hermes', cli);
  expect(out.verdict).toEqual(verdict);
  const argv = cli.argv();
  expect(hasPair(argv, '-z', 'review this')).toBe(true);
  expect(hasPair(argv, '-t', 'file')).toBe(true);
  expect(argv).toContain('--safe-mode');
  expect(cli.env()).toContain(`HERMES_WRITE_SAFE_ROOT=${join(cli.dir, 'hermes-writes')}`);
  expect(cli.env()).toContain(`TERMINAL_CWD=${cli.dir}`);
  expect(cli.stdin()).toBe('');
});

test('pi allows read tools only, ignores project files, and takes the prompt last', async () => {
  const cli = fakeCli(`Here it is:\n${JSON.stringify(verdict)}`);
  const out = await run('pi', cli, { model: 'anthropic/claude-haiku-4-5', effort: 'low' });
  expect(out.verdict).toEqual(verdict);
  const argv = cli.argv();
  expect(hasPair(argv, '--tools', 'read,grep,find,ls')).toBe(true);
  for (const flag of ['--no-approve', '--no-extensions', '--no-skills', '--no-context-files']) {
    expect(argv).toContain(flag);
  }
  expect(argv.at(-1)).toBe('review this');
  expect(cli.stdin()).toBe('');
});

test('vibe runs the plan agent without trust and reads the last assistant message', async () => {
  const history = [
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'review this' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Looking at the diff.' }] },
    { type: 'effect', title: 'file_system.bash', state: { status: 'completed' } },
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(verdict) }] },
  ];
  const cli = fakeCli(JSON.stringify(history));
  const out = await run('vibe', cli, { model: 'mistral-medium' });
  expect(out.verdict).toEqual(verdict);
  const argv = cli.argv();
  expect(hasPair(argv, '--agent', 'plan')).toBe(true);
  expect(argv).not.toContain('--trust');
  expect(cli.env()).toContain('VIBE_ACTIVE_MODEL=mistral-medium');
  expect(cli.env()).toContain('VIBE_ENABLE_TELEMETRY=false');
});

describe('opencode and kilo', () => {
  const events = [
    { type: 'step_start' },
    { type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } },
    { type: 'text', part: { type: 'text', text: 'Reading the diff.' } },
    { type: 'text', part: { type: 'text', text: JSON.stringify(verdict) } },
    { type: 'step_finish', part: { reason: 'stop' } },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const readOnly = 'OPENCODE_PERMISSION={"*":"deny","read":"allow","grep":"allow","glob":"allow","list":"allow"}';

  test('opencode runs a read-only agent with project config off and reads the last text event', async () => {
    const cli = fakeCli(events);
    const out = await run('opencode', cli, { model: 'openai/gpt-5.5', effort: 'low' });
    expect(out.verdict).toEqual(verdict);
    const argv = cli.argv();
    expect(argv.slice(0, 4)).toEqual(['run', '--pure', '--agent', 'relay-review']);
    expect(hasPair(argv, '--variant', 'low')).toBe(true);
    expect(cli.env()).toContain('OPENCODE_DISABLE_PROJECT_CONFIG=1');
    expect(cli.env()).toContain(readOnly);
    expect(cli.stdin()).toBe('review this');
  });

  test('kilo does the same with KILO_ variables and never hands the run to a daemon', async () => {
    const cli = fakeCli(events);
    expect((await run('kilo', cli)).verdict).toEqual(verdict);
    expect(cli.env()).toContain('KILO_NO_DAEMON=1');
    expect(cli.env()).toContain('KILO_DISABLE_PROJECT_CONFIG=1');
    expect(cli.env()).toContain(readOnly.replace('OPENCODE_', 'KILO_'));
  });
});

test('gemini runs in plan mode with no extensions or MCP servers and reads .response', async () => {
  const cli = fakeCli(JSON.stringify({ session_id: 's', response: JSON.stringify(verdict), stats: {} }));
  const out = await run('gemini', cli, { model: 'gemini-3-pro-preview' });
  expect(out.verdict).toEqual(verdict);
  const argv = cli.argv();
  expect(hasPair(argv, '--approval-mode', 'plan')).toBe(true);
  expect(hasPair(argv, '-e', 'none')).toBe(true);
  expect(argv).toContain('--allowed-mcp-server-names');
  expect(hasPair(argv, '-p', 'review this')).toBe(true);
  expect(cli.env()).toContain('GEMINI_CLI_TRUST_WORKSPACE=true');
  const failed = await run('gemini', fakeCli(JSON.stringify({ response: '', error: { type: 'auth' } })));
  expect(failed.error).toStartWith('the CLI reported an error');
});

test('qwen runs in plan mode with safe mode and the schema, and reads structured_result', async () => {
  const cli = fakeCli(
    JSON.stringify([{ type: 'system' }, { type: 'result', is_error: false, structured_result: verdict }]),
  );
  const out = await run('qwen', cli, { model: 'qwen3-coder-plus' });
  expect(out.verdict).toEqual(verdict);
  const argv = cli.argv();
  expect(hasPair(argv, '--approval-mode', 'plan')).toBe(true);
  expect(argv).toContain('--safe-mode');
  expect(argv).toContain('--json-schema');
  expect(cli.stdin()).toBe('review this');
});

test('copilot hides all but read tools, denies write and shell, and skips instruction files', async () => {
  const cli = fakeCli(`Review done.\n${JSON.stringify(verdict)}`);
  const out = await run('copilot', cli, { effort: 'high' });
  expect(out.verdict).toEqual(verdict);
  const argv = cli.argv();
  expect(hasPair(argv, '-p', 'review this')).toBe(true);
  expect(hasPair(argv, '--available-tools', 'view,read,grep,glob')).toBe(true);
  expect(hasPair(argv, '--deny-tool', 'write')).toBe(true);
  expect(hasPair(argv, '--deny-tool', 'shell')).toBe(true);
  for (const flag of ['--no-custom-instructions', '--disable-builtin-mcps', '--no-ask-user'])
    expect(argv).toContain(flag);
});

test('only harnesses whose shell is sandboxed or flag-checked get to run git', () => {
  // codex runs commands in its read-only OS sandbox; vibe's plan agent refuses git flags that write or run programs.
  // Any other harness that could run `git diff --output=<file>` or `git grep -O<cmd>` must use the inline diff.
  expect(HARNESS_NAMES.filter((name) => HARNESSES[name].shell === 'git')).toEqual(['codex', 'vibe']);
});

test('resultText reads the result envelope after banners and stops on is_error', () => {
  expect(resultText(`banner\n${envelope('{"a":1}')}\n`)).toBe('{"a":1}');
  expect(resultText(JSON.stringify({ type: 'result', result: 'whole' }, null, 2))).toBe('whole');
  expect(() => resultText(envelope('quota exceeded', true))).toThrow('the CLI reported an error: quota exceeded');
  expect(() => resultText('plain text')).toThrow('no result message');
});

test('a reply without a verdict keeps the raw output and says why', async () => {
  const out = await run('codex', fakeCli('{"summary": "half an answer"}'));
  expect(out.verdict).toBeUndefined();
  expect(out.error).toBe('unreadable verdict: verdict.dimensions missing');
  expect(out.raw).toBe('{"summary": "half an answer"}');
});

test('removeProjectFiles deletes harness config from the checkout but never follows a symlink out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-worktree-'));
  const outside = mkdtempSync(join(tmpdir(), 'relay-outside-'));
  writeFileSync(join(outside, 'keep.txt'), 'mine');
  mkdirSync(join(dir, '.factory'));
  writeFileSync(join(dir, '.factory', 'hooks.json'), '{}');
  symlinkSync(outside, join(dir, '.augment'));
  writeFileSync(join(dir, 'README.md'), 'readme');

  await removeProjectFiles(dir, ['claude', 'droid', 'auggie']);
  expect(existsSync(join(dir, '.factory'))).toBe(false);
  expect(existsSync(join(dir, '.augment'))).toBe(false);
  expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('mine');
  expect(existsSync(join(dir, 'README.md'))).toBe(true);
});

test('findBin takes the first executable on PATH from the harness list', () => {
  expect(findBin('claude', (bin) => (bin === 'claude' ? '/opt/bin/claude' : null))).toBe('/opt/bin/claude');
  expect(findBin('claude', () => null)).toBeNull();
});

describe('choices', () => {
  test('every harness lists its defaults among its choices and passes an effort exactly when it offers one', async () => {
    for (const name of HARNESS_NAMES) {
      const { defaults, choices } = HARNESSES[name];
      if (defaults.model) expect(choices.model).toContain(defaults.model);
      if (defaults.effort) expect(choices.effort).toContain(defaults.effort);
      const cli = fakeCli(envelope(JSON.stringify(verdict)), { tools: '  ✓ view   enabled' });
      await run(name, cli, { effort: 'effort-under-test' });
      expect(cli.argv().some((arg) => arg.includes('effort-under-test'))).toBe(choices.effort !== undefined);
    }
  });
});
