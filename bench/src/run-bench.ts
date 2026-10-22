import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resultsDir } from './bench-paths.js';
import type { BenchArgs } from './cli-args.js';
import { budgetsFrom, checkGate, readBudgets, writeBudgets } from './gate.js';
import { buildReport, reportMarkdown } from './harness/report.js';
import type { SuiteReport } from './harness/report.js';
import { runSuite } from './harness/suite.js';
import { toolSet } from './harness/tool-sets.js';
import { modelSolverFromEnv } from './model-solver.js';
import { scriptedSolver } from './solvers/registry.js';
import { buildSpec, buildSpecs, catalogueEntries, replaceSpecs } from './tasks/build-specs.js';
import { readSpecs, writeSpecs } from './tasks/spec-files.js';
import type { TaskSpec } from './task-spec.js';

/** The specs a run covers: held-out ones only with `--held-out`, filtered by seed and task, plus fresh-seed rebuilds. */
export async function selectSpecs(args: BenchArgs): Promise<TaskSpec[]> {
  const { heldOut, seeds, tasks, freshSeeds = [] } = args;
  const committed = (await readSpecs()).filter(spec => spec.heldOut === heldOut && (seeds == null || seeds.includes(spec.repo.seed)) && (tasks == null || tasks.includes(spec.family)));
  const fresh: TaskSpec[] = [];
  for (const seed of heldOut ? [] : freshSeeds) {
    for (const entry of catalogueEntries({ heldOut: false }).filter(({ task }) => tasks == null || tasks.includes(task.id))) fresh.push(await buildSpec({ ...entry, seed }));
  }
  return [...committed, ...fresh];
}

/** Runs the bench as the CLI asked; returns the report (written to `bench/results/<label>.json|.md` with a label). */
export async function runBench(params: { args: BenchArgs; log: (line: string) => void }): Promise<SuiteReport | undefined> {
  const { args, log } = params;
  if (args.buildSpecs) {
    // Held-out specs are rebuilt (their reference measured) only with --held-out, as part of the one held-out run.
    const rebuilt = await buildSpecs({ heldOut: args.heldOut, ...(args.tasks == null ? {} : { tasks: args.tasks }) });
    const specs = replaceSpecs({ committed: await readSpecs(), rebuilt });
    log(`wrote ${(await writeSpecs({ specs })).length} spec files (${rebuilt.length} ${args.heldOut ? 'held-out' : 'tuning'} specs rebuilt, ${specs.length} in all)`);
    return undefined;
  }
  const specs = await selectSpecs(args);
  const solvers = args.tier === 'model' ? [modelSolverFromEnv(process.env)] : args.policies.map(scriptedSolver);
  const runs = await runSuite({ specs, solvers, repeat: args.repeat, tools: toolSet(args.tools), onRow: row => log(`${row.solver} ${row.taskId} ${row.tier} tokens=${row.tokens} turns=${row.turns} calls=${row.toolCalls}`) });
  const report = buildReport({ label: args.label ?? 'bench', tier: args.tier, runs, specs: specs.length });
  log(reportMarkdown(report));
  if (args.label != null) {
    await mkdir(resultsDir(), { recursive: true });
    await writeFile(join(resultsDir(), `${args.label}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(join(resultsDir(), `${args.label}.summary.md`), reportMarkdown(report), 'utf8');
  }
  if (args.writeBudgets != null) {
    await writeBudgets({ budgets: budgetsFrom({ rows: report.rows, round: args.writeBudgets, policy: args.policies[0] ?? 'optimised', tools: args.tools }) });
    log(`wrote budgets.json from ${args.writeBudgets}`);
  }
  if (args.gate) {
    const gate = checkGate({ report, budgets: await readBudgets() });
    log(gate.ok ? 'gate: passed' : `gate: FAILED\n${gate.failures.join('\n')}`);
    if (!gate.ok) process.exitCode = 1;
  }
  return report;
}
