#!/usr/bin/env node
// Generates a solution with real project references and times `bun check -b --timing` against tsgo -b.
// Layered DAG: L layers of W projects. Each project references F projects of the layer below
// and imports from each of them. Each project has M source files.
// Usage: node bench.mjs [--layers 10] [--width 20] [--fanin 3] [--files 5] [--work 0] [--tsgo-only|--bun-only] [--no-64x1]
// Env:   BUN (default "bun"), TSGO (default ./node_modules/@typescript/native/bin/tsc)
//        `bun install` (or npm install) provides tsgo via package.json.
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => {
  if (x.startsWith("--")) acc.push([x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]);
  return acc;
}, []));
const L = +(a.layers ?? 10), W = +(a.width ?? 20), F = Math.min(+(a.fanin ?? 3), W), M = +(a.files ?? 5);
const WORK = +(a.work ?? 0); // blocks of generic/overload checking work per project
const BUN = process.env.BUN ?? "bun";
const TSGO = process.env.TSGO ?? "./node_modules/@typescript/native/bin/tsc";
const OUT = "solution";
const name = (l, w) => `p${l}_${w}`;
const refsOf = (l, w) => (l === 0 ? [] : Array.from({ length: F }, (_, j) => name(l - 1, (w + j) % W)));

function generate() {
  rmSync(OUT, { recursive: true, force: true });
  const sol = [];
  for (let l = 0; l < L; l++) for (let w = 0; w < W; w++) {
    const n = name(l, w), refs = refsOf(l, w), dir = `${OUT}/${n}`;
    mkdirSync(`${dir}/src`, { recursive: true });
    for (let m = 0; m < M; m++) {
      const lines = [];
      if (m + 1 < M) lines.push(`import type { S${m + 1} } from "./f${m + 1}";`);
      // File 0 imports every referenced project; the type depends on each of them.
      if (m === 0) refs.forEach((r, j) => lines.push(`import type { Top as R${j} } from "../../${r}/src/index";`));
      lines.push(`export interface S${m} {\n  id: string;\n  tags: readonly string[];` +
        (m + 1 < M ? `\n  next?: S${m + 1};` : "") +
        (m === 0 ? refs.map((_, j) => `\n  dep${j}?: R${j};`).join("") : "") + `\n}`);
      lines.push(`export declare function make${m}(id: string): S${m};`);
      writeFileSync(`${dir}/src/f${m}.ts`, lines.join("\n") + "\n");
    }
    if (WORK > 0) {
      let w = `type DeepRO<T> = { readonly [K in keyof T]: T[K] extends object ? DeepRO<T[K]> : T[K] };\n`;
      for (let k = 0; k < WORK; k++) w += `
export interface Rec${k}<T> { id: T; items: Array<{ key: string; val: T; tags: Set<string> }>; }
export function pick${k}<T, K extends keyof T>(o: T, ...ks: K[]): Pick<T, K>;
export function pick${k}<T>(o: T, ...ks: string[]): Partial<T>;
export function pick${k}(o: any, ...ks: any[]) { const r: any = {}; for (const k of ks) r[k] = o[k]; return r; }
type Fn${k}<T> = T extends (...a: infer A) => infer R ? (...a: { [I in keyof A]: A[I] | undefined }) => Promise<R> : never;
export const use${k} = <T extends { id: string }>(r: Rec${k}<T>, f: Fn${k}<(x: T) => number>): DeepRO<Rec${k}<T>> => { void f; return r as DeepRO<Rec${k}<T>>; };
export const v${k} = pick${k}({ a: ${k}, b: "x", c: [1, 2, 3] as const }, "a", "c");
`;
      writeFileSync(`${dir}/src/work.ts`, w);
    }
    writeFileSync(`${dir}/src/index.ts`,
      `${WORK > 0 ? 'export * from "./work";\n' : ""}import { make0 } from "./f0";\nimport type { S0 } from "./f0";\nexport type Top = S0;\nexport const top: Top = make0("${n}");\n`);
    writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
      compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist",
        strict: true, skipLibCheck: true, module: "esnext", moduleResolution: "bundler", target: "es2022", types: [] },
      include: ["src"], references: refs.map((r) => ({ path: `../${r}` })),
    }, null, 2) + "\n");
    sol.push({ path: `./${n}` });
  }
  writeFileSync(`${OUT}/tsconfig.json`, JSON.stringify({ files: [], references: sol }, null, 2) + "\n");
}

const clean = () => spawnSync("sh", ["-c", `rm -rf ${OUT}/*/dist; rm -f ${OUT}/*/*.tsbuildinfo`]);
function run(cmd, args) {
  clean();
  const env = { ...process.env };
  const t = Date.now();
  const r = spawnSync("/usr/bin/time", ["-f", "TIMEX %U %S", cmd, ...args], { cwd: OUT, env, encoding: "utf8", maxBuffer: 1 << 30 });
  const wall = (Date.now() - t) / 1000;
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const t2 = out.match(/TIMEX ([\d.]+) ([\d.]+)/);
  const cpu = t2 ? Math.round(((+t2[1] + +t2[2]) / wall) * 100) : "?";
  return { wall, out, code: r.status, cpu };
}
const errs = (o) => (o.match(/error TS/g) ?? []).length;
const abs = (p) => (p.startsWith(".") ? new URL(p, `file://${process.cwd()}/`).pathname : p);

generate();
const total = L * W;
const rows = [];
if (!a["tsgo-only"]) {
  for (const [label, extra] of [["bun check -b", []], ["bun check -b --threads 1", ["--threads", "1"]]]) {
  const r = run(BUN, ["check", "-b", "--timing", ...extra]);
  const m = r.out.match(/([\d,]+) files loaded in ([\d.]+)(m?s).*?([\d,]+) checked in ([\d.]+)(m?s)/s);
  const sec = (v, u) => (u === "ms" ? v / 1000 : +v);
  rows.push({ engine: label, cpu: r.cpu, wall: r.wall, files: m ? +m[1].replace(/,/g, "") : "?",
    load: m ? sec(+m[2], m[3]) : "?", check: m ? sec(+m[5], m[6]) : "?", errors: errs(r.out), code: r.code });
  if (!m) console.error("could not parse --timing output:\n" + r.out.slice(-600));
  }
}
if (!a["bun-only"]) {
  const modes = [["tsgo -b", []]];
  if (!a["no-64x1"]) modes.push(["tsgo -b --builders 64 --checkers 1", ["--builders", "64", "--checkers", "1"]]);
  for (const [label, extra] of modes) {
    const r = run(abs(TSGO), ["-b", "--extendedDiagnostics", ...extra]);
    // Sum "Files:" over projects. Counts each project's program, so shared files count once per project.
    const files = [...r.out.matchAll(/^Files:\s+(\d+)/gm)].reduce((s, x) => s + +x[1], 0);
    rows.push({ engine: label, cpu: r.cpu, wall: r.wall, files, load: "-", check: "-", errors: errs(r.out), code: r.code });
  }
}
console.log(`\nlayers=${L} width=${W} fanin=${F} files/project=${M} projects=${total}`);
console.log("| engine | wall s | CPU % | files loaded | load s | check s | errors | exit |\n|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.engine} | ${r.wall.toFixed(1)} | ${r.cpu} | ${r.files} | ${typeof r.load === "number" ? r.load.toFixed(1) : r.load} | ${typeof r.check === "number" ? r.check.toFixed(1) : r.check} | ${r.errors} | ${r.code} |`);
