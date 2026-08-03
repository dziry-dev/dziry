/**
 * Generates both sides of the shared-memory protocol from one schema.
 *
 *   bun run gen:protocol
 *
 * The point is that field identity cannot drift. A human editing two files stays
 * in sync until they don't, and the failure mode is silent memory corruption —
 * so nobody edits either output.
 *
 * Offsets are deliberately *not* generated: they depend on capacity, which
 * changes when a list arena regrows. The engine computes them and reports a
 * descriptor; Bun checks the field count and order against what is generated
 * here. Identity from codegen, offsets at run time.
 */
import { join } from "node:path";
import {
  ANIMATABLE_FIELDS,
  ControlFlags,
  ELEM_SIZE,
  ELEM_VIEW,
  ENUMS,
  INTERP_CODE,
  NodeFlags,
  PROTOCOL_VERSION,
  TABLES,
  type EnumDef,
  type Field,
  type Table,
} from "../src/protocol/schema.ts";

const ROOT = join(import.meta.dir, "..");

/**
 * Node flag bits, rendered for each side from `schema.ts`'s one definition.
 *
 * These used to be written out by hand in this file, twice — once as TypeScript
 * and once as Rust — while `schema.ts` also declared them, so the "single source
 * of truth" had three copies and only the schema's was authoritative on paper.
 * Adding `GENERATED` is what surfaced it: the flag existed in the schema, the
 * generator kept emitting the old pair, and nothing failed. A disagreement here
 * is the same silent class as a wrong offset — the engine would test a bit
 * neither side agreed on — and `SCHEMA_HASH` does not cover flags.
 */
const flagBodyTs = (bits: Record<string, number>) =>
  Object.entries(bits)
    .map(([name, bit]) => `  ${name}: 1 << ${Math.log2(bit)},`)
    .join("\n");

const flagBodyRust = (bits: Record<string, number>) =>
  Object.entries(bits)
    .map(([name, bit]) => `    pub const ${name}: u8 = 1 << ${Math.log2(bit)};`)
    .join("\n");

/**
 * Every flag group, so adding one is an entry here rather than four edits.
 *
 * `ControlFlags` is the second, and it is what turned the pair of hand-written
 * renderings above into a table: the argument for generating `NodeFlags` applies
 * verbatim to any further group, and the way to stop the same mistake recurring is
 * to make "another group" cost nothing.
 */
const FLAG_GROUPS: Array<[string, string, Record<string, number>]> = [
  ["flags", "NodeFlags", NodeFlags],
  ["control_flags", "ControlFlags", ControlFlags],
];

/**
 * A structural fingerprint of the tables: every table name, field name and
 * element type, in order.
 *
 * This exists because the startup handshake used to compare field *counts*, and
 * a count is exactly the property a dangerous change preserves. Renaming a field,
 * reordering two `u32`s, or retyping `i32` to `f32` all keep the count identical
 * while making one side read the other's bytes as something else — wrong values
 * at a valid offset, which is the failure this whole generator exists to prevent.
 *
 * Hashing the structure means the two sides agree on *identity*, not just shape,
 * and a stale engine binary is a refusal to start rather than a corrupt frame.
 * FNV-1a: short input, no dependency, and it only has to detect accidents.
 */
function schemaHash(): number {
  let h = 0x811c9dc5;
  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };

  feed(`v${PROTOCOL_VERSION}`);
  for (const table of TABLES) {
    feed(`|${table.name}:${table.sizedBy}`);
    // `affects` carries no bytes, so it could have been left out of the
    // fingerprint. It is in, because the two sides disagreeing about it means
    // the engine skips a relayout the compiler expected — a stale frame with no
    // write to blame, which is the same class of failure the hash exists for.
    //
    // `interp` is in for the same reason, one step worse: it decides which mask
    // bit a field owns, so two sides disagreeing about a single field's `interp`
    // renumbers every bit above it. Every transition on the page then animates a
    // neighbouring property.
    for (const field of table.fields) {
      const affects = field.affects ? `:${field.affects}` : "";
      const interp = field.interp ? `:${field.interp}` : "";
      feed(`,${field.name}:${field.type}${affects}${interp}`);
    }
  }
  return h >>> 0;
}

/**
 * Which tables classify their fields as layout- or paint-affecting.
 *
 * A partially tagged table is refused rather than defaulted. Either default is
 * wrong for somebody: assume `layout` and a paint field silently costs a
 * relayout forever, assume `paint` and a layout field silently stops causing
 * one. A field added without a tag should stop the build, which is the only
 * moment anyone is thinking about that field.
 */
function classifiedTables(): Table[] {
  const out: Table[] = [];
  for (const table of TABLES) {
    const tagged = table.fields.filter((f) => f.affects !== undefined);
    if (tagged.length === 0) continue;
    if (tagged.length !== table.fields.length) {
      const missing = table.fields.filter((f) => f.affects === undefined).map((f) => f.name);
      throw new Error(
        `table "${table.name}" tags some fields with \`affects\` and not others.\n` +
          `  untagged: ${missing.join(", ")}\n` +
          `  Tag every field or none — see the \`Affects\` doc comment in schema.ts.`,
      );
    }
    out.push(table);
  }
  return out;
}

const CLASSIFIED = classifiedTables();

/**
 * Which fields can be interpolated, and the bit each one owns in a tween's mask.
 *
 * Two rules, both checked here rather than trusted, because both fail silently.
 *
 * A mask is a `u32`, so **33 animatable fields would wrap** — bit 32 becomes bit
 * 0, and a transition asked to move `translateX` would move `bg` instead. That is
 * a wrong-looking frame with nothing in the compiler to blame, and the moment to
 * catch it is the moment somebody adds the field.
 *
 * And an animatable field must be **paint-only**. A layout-affecting field
 * interpolated in paint alone would give a box whose colour eases while its width
 * jumps, because nothing on the layout side reads a blend. The compiler refuses
 * such a transition by name; this makes it impossible to reach that refusal by
 * mislabelling the schema instead.
 */
function animBits(): Map<string, number> {
  const bits = new Map<string, number>();
  ANIMATABLE_FIELDS.forEach((f, i) => bits.set(f.name, i));

  if (bits.size > 32) {
    throw new Error(
      `${bits.size} style fields are marked \`interp\`, and a tween mask is a u32.\n` +
        `  A 33rd bit wraps onto bit 0 and animates the wrong property.\n` +
        `  Widen \`tweens.mask\` to a pair of u32s — and teach both sides — or drop one.`,
    );
  }

  const misfiled = ANIMATABLE_FIELDS.filter((f) => f.affects !== "paint").map((f) => f.name);
  if (misfiled.length > 0) {
    throw new Error(
      `styles fields marked \`interp\` but not \`affects: "paint"\`: ${misfiled.join(", ")}.\n` +
        `  Only paint reads an interpolated value, so a layout-affecting field would ease\n` +
        `  its colour and jump its geometry. See the \`Interp\` doc comment in schema.ts.`,
    );
  }
  return bits;
}

const ANIM_BITS = animBits();

/** `INTERP` codes, from the one table the `Interp` enum is also built from. */
const interpCode = (f: Field): number => INTERP_CODE[f.interp ?? "none"];

const SCHEMA_HASH = schemaHash();

/** The widest table, so a (table, field) index needs no hand-written stride. */
const MAX_FIELD_COUNT = Math.max(...TABLES.map((t) => t.fields.length));

const BANNER = (source: string) =>
  `// GENERATED by scripts/gen-protocol.ts from ${source}\n// Do not edit.\n`;

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const rustType = (t: keyof typeof ELEM_SIZE): string =>
  ({ u8: "u8", u16: "u16", i16: "i16", u32: "u32", i32: "i32", f32: "f32", f64: "f64" })[t];

/** `firstChild` -> `FIRST_CHILD`, so the Rust side reads idiomatically. */
const screamingSnake = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

/** `firstChild` -> `first_child`, for Rust accessor names. */
const snake = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function rustTable(table: Table): string {
  const consts = table.fields
    .map((f, i) => `    pub const ${screamingSnake(f.name)}: usize = ${i};`)
    .join("\n");

  const sizes = table.fields.map((f) => `${ELEM_SIZE[f.type]}`).join(", ");
  const names = table.fields.map((f) => `"${f.name}"`).join(", ");

  const classification = table.fields.some((f) => f.affects)
    ? `

    /// Whether a change to this field can move a box.
    ///
    /// \`false\` means paint reads it and layout does not, so a commit that
    /// touches only such fields needs no Taffy work at all — the repaint that
    /// every non-empty commit schedules is the entire response. A colour-only
    /// theme patch is the case this exists for.
    pub const LAYOUT_AFFECTING: [bool; FIELD_COUNT] = [${table.fields
      .map((f) => (f.affects === "paint" ? "false" : "true"))
      .join(", ")}];`
    : "";

  // Only the styles table has an interpolation story, and emitting these two
  // arrays unconditionally would put a 9-entry `ANIM_BIT` of nothing but 255 on
  // every other table.
  const interpolation = table.fields.some((f) => f.interp)
    ? `

    /// How each field is interpolated partway through a tween.
    ///
    /// \`interp::NONE\` means discrete — every enum, and the two tween references
    /// themselves. See the \`Interp\` doc comment in schema.ts for why a colour is
    /// not a number here.
    pub const INTERP: [u8; FIELD_COUNT] = [${table.fields.map(interpCode).join(", ")}];

    /// Which bit of a tween's \`mask\` each field owns, or 255 for "not animatable".
    ///
    /// Dense over the animatable fields rather than sparse over all of them, so a
    /// mask stays one \`u32\` while the table grows. The numbering is derived from
    /// field order, which is why \`interp\` is in \`SCHEMA_HASH\`: renumbering it on
    /// one side only would animate a neighbouring property.
    pub const ANIM_BIT: [u8; FIELD_COUNT] = [${table.fields
      .map((f) => ANIM_BITS.get(f.name) ?? 255)
      .join(", ")}];

    /// The field index each mask bit refers to, low bit first — \`ANIM_BIT\` inverted.
    ///
    /// The engine walks a mask's set bits and needs the field for each; searching
    /// \`ANIM_BIT\` for a value would be a linear scan per bit per animating node.
    pub const ANIM_FIELDS: [usize; ${ANIMATABLE_FIELDS.length}] = [${ANIMATABLE_FIELDS.map(
      (f) => table.fields.findIndex((g) => g.name === f.name),
    ).join(", ")}];`
    : "";

  return `/// ${table.doc}
pub mod ${snake(table.name)} {
    /// Field indices, in descriptor order.
${consts}

    pub const FIELD_COUNT: usize = ${table.fields.length};
    pub const ELEM_SIZES: [usize; FIELD_COUNT] = [${sizes}];
    pub const FIELD_NAMES: [&str; FIELD_COUNT] = [${names}];${classification}${interpolation}
}`;
}

const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1);

/** `NodeKind` -> `node_kind`, so the Rust side reads as a module path. */
const moduleName = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function rustEnum(e: EnumDef): string {
  const values = Object.entries(e.values)
    .map(([k, v]) => `    pub const ${k}: ${e.ty} = ${v};`)
    .join("\n");
  return `/// ${e.doc}\npub mod ${moduleName(e.name)} {\n${values}\n}`;
}

function emitRust(): string {
  const tables = TABLES.map(rustTable).join("\n\n");
  const enums = ENUMS.map(rustEnum).join("\n\n");
  const enumVariants = TABLES.map((t, i) => `    ${cap(t.name)} = ${i},`).join("\n");
  const tableNames = TABLES.map((t) => `"${t.name}"`).join(", ");
  const fieldCounts = TABLES.map((t) => `${snake(t.name)}::FIELD_COUNT`).join(", ");
  const sizedBy = TABLES.map((t) => `"${t.sizedBy}"`).join(", ");
  const elemSizeArms = TABLES.map((t, i) => `        ${i} => &${snake(t.name)}::ELEM_SIZES,`).join("\n");
  const fieldNameArms = TABLES.map((t, i) => `        ${i} => &${snake(t.name)}::FIELD_NAMES,`).join("\n");

  return `${BANNER("src/protocol/schema.ts")}
//! Shared-memory layout. Struct-of-arrays: every field is its own contiguous
//! span, so a style patch touches one array and paint reads stay monomorphic.

/// Bumped on any schema change. The engine refuses to start on a mismatch rather
/// than rendering garbage.
pub const PROTOCOL_VERSION: u32 = ${PROTOCOL_VERSION};

/// Structural fingerprint of every table, field name and element type, in order.
///
/// The version says "the protocol changed on purpose"; this says "the two sides
/// were generated from the same schema". A field rename, a reorder of two
/// same-width fields, or an \`i32\` retyped to \`f32\` all leave the field count
/// untouched — so a handshake that counts fields cannot see them, and the result
/// is one side reading the other's bytes as a different type at a valid offset.
pub const SCHEMA_HASH: u32 = 0x${SCHEMA_HASH.toString(16).padStart(8, "0")};

pub const TABLE_COUNT: usize = ${TABLES.length};

/// Field count of the widest table. The (table, field) lookup index uses this as
/// its stride, so it cannot be out-grown by adding fields to a table.
pub const MAX_FIELD_COUNT: usize = ${MAX_FIELD_COUNT};
pub const TABLE_NAMES: [&str; TABLE_COUNT] = [${tableNames}];

#[repr(u32)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Table {
${enumVariants}
}

impl Table {
    pub fn field_count(self) -> usize {
        FIELD_COUNTS[self as usize]
    }
}

pub const FIELD_COUNTS: [usize; TABLE_COUNT] = [${fieldCounts}];

/// How each table is sized, so the engine can turn a capacity request into byte
/// spans without a hand-written mapping that could drift from the schema.
pub const SIZED_BY: [&str; TABLE_COUNT] = [${sizedBy}];

/// Element size per field, indexed by table. Empty for an unknown table.
pub fn elem_sizes(table: usize) -> &'static [usize] {
    match table {
${elemSizeArms}
        _ => &[],
    }
}

/// Field names per table, for descriptor assertions and diagnostics.
pub fn field_names(table: usize) -> &'static [&'static str] {
    match table {
${fieldNameArms}
        _ => &[],
    }
}

${tables}

${FLAG_GROUPS.map(([mod, , bits]) => `pub mod ${mod} {\n${flagBodyRust(bits)}\n}`).join("\n\n")}

${enums}
`;
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

function emitTypeScript(): string {
  const tableConsts = TABLES.map((t) => {
    const fields = t.fields
      .map((f, i) => `    ${f.name}: ${i},${f.doc ? ` // ${f.doc}` : ""}`)
      .join("\n");
    return `  /** ${t.doc} */\n  ${t.name}: {\n${fields}\n  },`;
  }).join("\n");

  const views = TABLES.map((t) => {
    const fields = t.fields.map((f) => `    ${f.name}: ${ELEM_VIEW[f.type]};`).join("\n");
    return `  ${t.name}: {\n${fields}\n  };`;
  }).join("\n");

  const counts = TABLES.map((t) => `  ${t.name}: ${t.fields.length},`).join("\n");
  const elemViews = TABLES.map((t) => {
    const list = t.fields.map((f) => ELEM_VIEW[f.type]).join(", ");
    return `  ${t.name}: [${list}],`;
  }).join("\n");

  return `${BANNER("src/protocol/schema.ts")}
/**
 * Shared-memory field indices, matching the engine's generated \`protocol.rs\`.
 *
 * Indices identify fields; byte offsets come from the engine's descriptor at run
 * time, because they depend on capacity and a list arena can regrow.
 */

export const PROTOCOL_VERSION = ${PROTOCOL_VERSION};

/**
 * Structural fingerprint of every table, field name and element type, in order.
 *
 * Checked against the engine's copy at startup. The version says "the protocol
 * changed on purpose"; this says "both sides were generated from the same
 * schema" — which is the part a field count cannot tell you, because renaming a
 * field or reordering two same-width fields keeps the count identical while
 * changing what the bytes mean.
 */
export const SCHEMA_HASH = 0x${SCHEMA_HASH.toString(16).padStart(8, "0")};

/** Element size in bytes per field, indexed as \`FIELD_SIZES[table][field]\`. */
export const FIELD_SIZES: Record<TableName, number[]> = {
${TABLES.map((t) => `  ${t.name}: [${t.fields.map((f) => ELEM_SIZE[f.type]).join(", ")}],`).join("\n")}
};

/** Field names per table, in descriptor order — used to name a mismatch. */
export const FIELD_NAMES: Record<TableName, string[]> = {
${TABLES.map((t) => `  ${t.name}: [${t.fields.map((f) => `"${f.name}"`).join(", ")}],`).join("\n")}
};

/**
 * Whether a change to a field can move a box, for the tables that classify.
 *
 * The engine is the consumer — it uses this to skip Taffy entirely for a
 * paint-only patch. It is emitted here so the compiler's own \`LAYOUT_FIELDS\`
 * can be checked against it rather than trusted to agree.
 */
export const LAYOUT_AFFECTING: { [K in TableName]?: boolean[] } = {
${CLASSIFIED.map(
  (t) => `  ${t.name}: [${t.fields.map((f) => (f.affects === "paint" ? "false" : "true")).join(", ")}],`,
).join("\n")}
};

/**
 * Which bit of a tween's \`mask\` each animatable style field owns.
 *
 * Only the names that *are* animatable, so a lookup miss is the answer to "can
 * this property be transitioned at all" rather than something to compare against a
 * sentinel. The compiler builds a \`transition-property\` list into a mask through
 * this map, and refuses a property that is absent from it — which is how
 * \`transition: width\` becomes a named warning rather than a mask bit nothing
 * honours.
 */
export const ANIM_BIT = {
${ANIMATABLE_FIELDS.map((f, i) => `  ${f.name}: ${i},`).join("\n")}
} as const;

/**
 * A style field that can be transitioned, by its **schema** name.
 *
 * The schema's spelling rather than the IR's — \`radiusTopLeft\`, not \`radTL\` —
 * because a mask is what crosses the boundary and the engine indexes it with
 * \`styles::ANIM_BIT\`. Naming the fields the way the wire names them means the
 * compiler's \`transition-property\` map is type-checked against the schema itself,
 * with no second list translating between the two spellings.
 */
export type AnimatableField = keyof typeof ANIM_BIT;

/** Every animatable field's mask bit at once — what \`transition-property: all\` means here. */
export const ANIM_ALL = ${
    ANIMATABLE_FIELDS.length === 32 ? "0xffffffff" : `0x${((2 ** ANIMATABLE_FIELDS.length - 1) >>> 0).toString(16)}`
  };

export const TABLE_NAMES = [${TABLES.map((t) => `"${t.name}"`).join(", ")}] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** Field index per table, in descriptor order. */
export const F = {
${tableConsts}
} as const;

/** Field counts, asserted against the engine's descriptor at startup. */
export const FIELD_COUNTS: Record<TableName, number> = {
${counts}
};

/** Typed-array constructor per field, used to wrap the engine's memory. */
export const FIELD_VIEWS: Record<TableName, unknown[]> = {
${elemViews}
};

/** Shape of the wrapped tables once the descriptor has been read. */
export type SharedTables = {
${views}
};

${FLAG_GROUPS.map(([, name, bits]) => `export const ${name} = {\n${flagBodyTs(bits)}\n} as const;`).join("\n\n")}

${ENUMS.map(tsEnum).join("\n\n")}
`;
}

function tsEnum(e: EnumDef): string {
  const values = Object.entries(e.values)
    .map(([k, v]) => `  ${k}: ${v},`)
    .join("\n");
  return `/** ${e.doc} */\nexport const ${e.name} = {\n${values}\n} as const;\nexport type ${e.name} = (typeof ${e.name})[keyof typeof ${e.name}];`;
}

// ---------------------------------------------------------------------------

const rustPath = join(ROOT, "native-src", "dziri-engine", "src", "protocol.rs");
const tsPath = join(ROOT, "src", "protocol", "generated.ts");

await Bun.write(rustPath, emitRust());
await Bun.write(tsPath, emitTypeScript());

/**
 * Hand the Rust file to rustfmt rather than trying to emit its formatting.
 *
 * The crate denies clippy's default lints and `cargo fmt --check` covers every
 * file in it, generated ones included — and a generator cannot reliably guess
 * where rustfmt wants to break a 48-element array. So it emits readable Rust and
 * rustfmt decides the rest.
 *
 * A missing rustfmt is a warning, not a failure: it is a rustup component, and
 * `gen:protocol` must keep working for anyone who has not installed it. The
 * output compiles either way; only `cargo fmt --check` would notice.
 */
const fmt = Bun.spawnSync(["rustfmt", "--edition", "2021", rustPath]);
if (!fmt.success) {
  const detail = new TextDecoder().decode(fmt.stderr).trim();
  console.warn(`warning: rustfmt did not format protocol.rs${detail ? `: ${detail}` : ""}`);
}

const totalFields = TABLES.reduce((n, t) => n + t.fields.length, 0);
console.log(
  `protocol v${PROTOCOL_VERSION}: ${TABLES.length} tables, ${totalFields} fields\n` +
    `  -> native-src/dziri-engine/src/protocol.rs\n` +
    `  -> src/protocol/generated.ts`,
);

for (const t of TABLES) {
  const bytes = t.fields.reduce((n, f) => n + ELEM_SIZE[f.type], 0);
  console.log(`  ${t.name.padEnd(8)} ${String(t.fields.length).padStart(2)} fields, ${bytes} bytes/entry`);
}
