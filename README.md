# bun check -b is 2x slower than tsgo --builders 64 on solutions with many small projects

On a solution with thousands of small projects, `bun check -b` is about 2x slower than `tsgo -b --builders 64 --checkers 1`. Both engines load the same files and report 0 errors. bun uses about 5 of 32 cores. tsgo uses about 18.

## Run it

```sh
bun install
node bench.mjs --layers 1 --width 4000
```

`bench.mjs` writes `./solution`, runs each engine cold (outputs and tsbuildinfo deleted before each run) and prints a table. `--layers 1 --width 4000` makes 4000 independent projects of 5 files each, and a solution tsconfig that references all of them. It takes about 90 s.

- `BUN=/path/to/bun` picks the bun binary. The default is `bun` on `PATH`.
- `TSGO=/path/to/tsc` picks tsgo. The default is the one `bun install` puts in `node_modules`.
- `--layers L --width W --fanin F` makes L layers of W projects. Each project references F projects in the layer below and imports from each of them.

## Results

32 cores, Linux 6.8.0-1066-aws x86_64, bun 1.4.4-canary.1+b92e2f470, tsgo 7.0.2. One cold run each. Load and check are from bun's `--timing`.

`--layers 1 --width 4000` (4000 projects, no references between them):

| engine | wall | CPU | files loaded | load / check |
|---|---|---|---|---|
| `bun check -b` | 14.0 s | 467% | 276,000 | 11.2 s / 2.6 s |
| `bun check -b --threads 1` | 34.2 s | 100% | 276,000 | 32.9 s / 1.3 s |
| `tsgo -b` | 34.1 s | 1711% | 276,000 | |
| `tsgo -b --builders 64 --checkers 1` | 5.8 s | 1839% | 276,000 | |

bun is 2.4x slower than tsgo 64x1. Most of its time is load (11.2 of 14.0 s), and it does not use more than about 5 cores.

With references between projects (fan-in 3):

| shape | projects | bun | CPU | tsgo 64x1 | CPU | ratio |
|---|---|---|---|---|---|---|
| 2 layers x 2000 | 4000 | 14.8 s | 494% | 7.1 s | 1980% | 2.1x |
| 3 layers x 1000 | 3000 | 10.6 s | 533% | 5.4 s | 1976% | 2.0x |
| 3 layers x 500 | 1500 | 4.9 s | 539% | 2.3 s | 1794% | 2.1x |

When each project is large, the gap closes. With `--layers 4 --width 100 --fanin 64` (400 projects, each loading about 800 files through its references), bun takes 4.8 s at about 1080% CPU and tsgo 64x1 takes 4.1 s. So bun parallelises well inside a project, but not across many small ones.

## Expected

`bun check -b` builds independent projects in parallel, like `tsgo -b --builders 64 --checkers 1`, or has an option to do so. Wall time on a solution with many small projects is close to tsgo's.

## Private monorepo

A private monorepo (~1000 projects, ~800,000 files) shows a larger gap:

- Standalone `-b` with real references: bun ~2,200 s (~1,700 s of it load), tsgo `--builders 64 --checkers 1` ~600 s.
- With `references: []` per project and pre-built declaration files: bun ~480 s at ~950% CPU, tsgo 64x1 ~330 s at ~1600% CPU.
- bun `--threads` 4, 32 and 64 were all within a few percent of each other.

## Related

- #44763: load time grows with the number of project references.
- #44807: load declaration files once.
- #45001 fixed the `paths` cost reported in https://github.com/spanishpear/bun-check-build-slow-repro.
