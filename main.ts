// Faster makefun-site: the program the harness runs (node22).
// It reads every case from /input/cases.json, answers each one alone with
// run() from solve.js, and writes /output/answers.json: a JSON array of the
// answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// The driver keeps the baseline's shape on purpose: the harness times the
// whole program, and every line here is work the baseline pays too, so the
// speed difference lives entirely in solve.js.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of
// its work runs under it.
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types). */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
