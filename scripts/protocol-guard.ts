/**
 * Proves the two halves of the shared-memory protocol still agree.
 *
 *   bun run protocol-guard          # check, exit 1 on drift
 *   bun run protocol-guard --fix    # regenerate, then re-check
 *
 * Risk #1 is layout drift: a stride or field-order disagreement corrupts silently
 * rather than raising a type error, and presents as inexplicably wrong pixels.
 * `gen-protocol.ts` removes the *authoring* half of that by generating both sides
 * from `schema.ts` — but nothing forced anyone to re-run it, so the generated
 * files can sit stale in the tree while `schema.ts` moves on. That is a
 * regenerate-and-forget hole, and it is what this closes.
 *
 * Four checks, cheapest first:
 *   1. PROTOCOL_VERSION agrees across schema.ts, generated.ts and protocol.rs
 *   2. SCHEMA_HASH agrees between generated.ts and protocol.rs
 *   3. regenerating produces byte-identical output (i.e. nobody forgot)
 *   4. the built engine binary reports the same version and hash as the source
 *
 * (4) is the one that catches a stale *binary* — source can be perfectly
 * consistent while `dziry_engine.dll` was built before the last schema change,
 * which is the same corruption arriving by a different route.
 */
import { readFile, writeFile, copyFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIX = process.argv.includes("--fix");

const TS = join(ROOT, "src/protocol/generated.ts");
const RS = join(ROOT, "native-src/dziry-engine/src/protocol.rs");
const SCHEMA = join(ROOT, "src/protocol/schema.ts");

const fail: string[] = [];
const note = (s: string) => console.log(`  ${s}`);

const grab = (text: string, re: RegExp, what: string): string | null => {
  const m = text.match(re);
  if (!m) {
    fail.push(`could not find ${what}`);
    return null;
  }
  return m[1]!;
};

console.log("protocol-guard");

// ── 1 & 2 ── declared constants agree ───────────────────────────────────────
let tsText = await readFile(TS, "utf8");
let rsText = await readFile(RS, "utf8");
const schemaText = await readFile(SCHEMA, "utf8");

const vSchema = grab(schemaText, /export const PROTOCOL_VERSION\s*=\s*(\d+)/, "PROTOCOL_VERSION in schema.ts");
const vTs = grab(tsText, /export const PROTOCOL_VERSION\s*=\s*(\d+)/, "PROTOCOL_VERSION in generated.ts");
const vRs = grab(rsText, /pub const PROTOCOL_VERSION:\s*u32\s*=\s*(\d+)/, "PROTOCOL_VERSION in protocol.rs");

if (vSchema && vTs && vRs) {
  if (vSchema === vTs && vTs === vRs) note(`version    ${vSchema} — agrees across all three`);
  else {
    fail.push(
      `PROTOCOL_VERSION disagrees: schema.ts=${vSchema} generated.ts=${vTs} protocol.rs=${vRs}\n` +
        `      the generated files are stale — run: bun run gen:protocol`,
    );
  }
}

const hTs = grab(tsText, /export const SCHEMA_HASH\s*=\s*(0x[0-9a-fA-F]+|\d+)/, "SCHEMA_HASH in generated.ts");
const hRs = grab(rsText, /pub const SCHEMA_HASH:\s*u32\s*=\s*(0x[0-9a-fA-F]+|\d+)/, "SCHEMA_HASH in protocol.rs");
if (hTs && hRs) {
  const same = BigInt(hTs) === BigInt(hRs);
  if (same) note(`hash       ${hTs} — TS and Rust agree`);
  else fail.push(`SCHEMA_HASH disagrees: generated.ts=${hTs} protocol.rs=${hRs}`);
}

// ── 3 ── regenerating changes nothing ───────────────────────────────────────
// Generation writes in place, so snapshot, regenerate, compare, restore unless
// --fix. A guard that mutates the tree as a side effect of *checking* would be
// its own kind of hazard.
const tsBak = TS + ".guardbak";
const rsBak = RS + ".guardbak";
await copyFile(TS, tsBak);
await copyFile(RS, rsBak);

let regenOk = false;
try {
  const proc = Bun.spawn(["bun", "run", "scripts/gen-protocol.ts"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    fail.push(`gen-protocol.ts failed:\n      ${(await new Response(proc.stderr).text()).trim()}`);
  } else {
    const tsNow = await readFile(TS, "utf8");
    const rsNow = await readFile(RS, "utf8");
    const tsDrift = tsNow !== tsText;
    const rsDrift = rsNow !== rsText;
    if (!tsDrift && !rsDrift) {
      note("codegen    up to date — regenerating is a no-op");
      regenOk = true;
    } else {
      const which = [tsDrift && "src/protocol/generated.ts", rsDrift && "protocol.rs"].filter(Boolean);
      fail.push(
        `generated output is stale: ${which.join(", ")}\n` +
          `      ${FIX ? "FIXED — regenerated in place" : "run: bun run protocol-guard --fix"}`,
      );
      if (FIX) {
        tsText = tsNow;
        rsText = rsNow;
        regenOk = true;
      }
    }
  }
} finally {
  if (!FIX || !regenOk) {
    await copyFile(tsBak, TS);
    await copyFile(rsBak, RS);
  }
  await unlink(tsBak).catch(() => {});
  await unlink(rsBak).catch(() => {});
}

// ── 4 ── the built binary agrees with the source ────────────────────────────
// Same two candidates, in the same order, as `libraryPath()` in engine/host.ts:
// cargo's output first, the packaged copy second. Checking a different path than
// the one the app loads would make this check a lie.
const libName =
  process.platform === "win32"
    ? "dziry_engine.dll"
    : process.platform === "darwin"
      ? "libdziry_engine.dylib"
      : "libdziry_engine.so";

const dll = [
  join(ROOT, "native-src", "dziry-engine", "target", "release", libName),
  join(ROOT, "native", `${process.platform}-${process.arch}`, libName),
].find(existsSync);

if (!dll) {
  note("binary     not built — skipped (run: bun run engine)");
} else {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen(dll, {
      dziry_protocol_version: { args: [], returns: FFIType.u32 },
      dziry_schema_hash: { args: [], returns: FFIType.u32 },
    });
    const bv = String(lib.symbols.dziry_protocol_version());
    const bh = lib.symbols.dziry_schema_hash();
    lib.close();

    const srcV = FIX ? grab(rsText, /pub const PROTOCOL_VERSION:\s*u32\s*=\s*(\d+)/, "version")! : vRs;
    const srcH = FIX ? grab(rsText, /pub const SCHEMA_HASH:\s*u32\s*=\s*(0x[0-9a-fA-F]+|\d+)/, "hash")! : hRs;

    const vOk = bv === srcV;
    const hOk = srcH != null && BigInt(bh) === BigInt(srcH);
    if (vOk && hOk) note(`binary     v${bv} hash ${"0x" + bh.toString(16)} — matches source`);
    else
      fail.push(
        `the built engine is stale: binary reports v${bv}/0x${bh.toString(16)}, ` +
          `source says v${srcV}/${srcH}\n      rebuild: bun run engine`,
      );
  } catch (e) {
    note(`binary     could not load (${(e as Error).message.split("\n")[0]}) — skipped`);
  }
}

if (fail.length) {
  console.log("");
  for (const f of fail) console.log(`FAIL  ${f}`);
  console.log(`\n${fail.length} protocol problem(s)`);
  process.exit(1);
}
console.log("\nprotocol is consistent");
