# Faster makefun-site

[![makefun-site](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/chiidaichii1-boop/site-generator/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/chiidaichii1-boop/site-generator/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` answers exactly as
makefun-site does for every case, and `main.ts` is the program the harness
runs — it reads every case from `/input/cases.json`, answers each with
`run`, and writes `/output/answers.json`.

`solve.js` is a dependency-free ES module written from scratch for this
bounty: a single-pass Markdown renderer, a range-based inline renderer, a
cached slugifier and a tight template interpreter, all tuned for CPU time
under Node 22.
