import { parseArgs } from './cli-args.js';
import { runBench } from './run-bench.js';

// `npm run bench -- --tier scripted --seed 1 --repeat 3 [--held-out] [--label round-0]`
runBench({ args: parseArgs(process.argv.slice(2)), log: line => process.stdout.write(`${line}\n`) }).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
