// One authority for tool names and schemas.
//
// THE BUG THIS REPLACES. Both encoders built their own pair of maps, inline and identically:
//
//   const name = sanitizeToolName(t.name);
//   if (name !== t.name) nameMap.set(name, t.name);   // sanitized -> original
//   schemas.set(t.name, t.input_schema);              // original  -> schema
//
// OpenAI requires tool names matching ^[a-zA-Z0-9_-]{1,64}$, so the sanitizer replaces every
// other character and truncates at 64. That is MANY-TO-ONE, and nothing checked for the
// collision:
//
//   * `foo.bar` and `foo_bar` both become `foo_bar`.
//   * Two names sharing their first 64 characters become the same name.
//
// When two tools collide, three things happen at once and none of them is visible:
//   1. the wire carries two tools with the same name;
//   2. `nameMap.set` overwrites, so a returned call maps back to whichever tool was declared
//      LAST — the model asked for one tool and the agent is handed another;
//   3. `schemas` is keyed by the original name, so the wrong schema prunes the arguments, and
//      pruning drops every argument the wrong schema does not declare.
//
// The result is a call to the wrong tool with mangled arguments, attributed to the model.
//
// HOW CLOSE THIS IS. Measured against the 57 real MCP tool names this app sends: 32 of them are
// already longer than 64 characters and therefore truncated, and the closest pair is TWO
// characters from colliding —
//   mcp__34c022b6-…-c999a7f65ec4__slack_search_public
//   mcp__34c022b6-…-c999a7f65ec4__slack_search_public_and_private
// because `mcp__` + a 36-character UUID + `__` consumes 43 of the 64 characters, leaving 21 for
// the tool name itself. No collision exists today. One more connector, or one longer tool name,
// and there is.
//
// WHY IT FAILS THE REQUEST RATHER THAN RENAMING. Suffixing an alias (`foo_bar_2`) would keep the
// request working while making the model's tool list disagree with its own documentation, and the
// failure would resurface as a model that "chose the wrong tool". A deterministic error naming
// both tools is diagnosable in one read. The catalog is validated in full BEFORE any
// surface-specific dropping, so the answer does not depend on which tools happened to survive a
// cap.
import { ToolCatalogError } from "./errors.mjs";

// OpenAI's constraint, on both surfaces: ^[a-zA-Z0-9_-]{1,64}$.
export const sanitizeToolName = (n) =>
  String(n || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";

export class ToolRegistry {
  constructor(tools) {
    this.tools = tools;
    this.byOriginal = new Map();     // original name -> { tool, wire, schema }
    this.byWire = new Map();         // wire name     -> original name
  }

  // Build and validate. Throws ToolCatalogError, which becomes a 400 naming the offenders.
  static from(tools) {
    const list = Array.isArray(tools) ? tools : [];
    const reg = new ToolRegistry(list);
    const seen = new Map();          // wire -> [originals], for a message naming all of them

    for (const t of list) {
      const original = t?.name;
      if (typeof original !== "string" || original === "")
        throw new ToolCatalogError("a declared tool has no name", { tools: [] });
      // A duplicate ORIGINAL name is ambiguous before any sanitizing happens, and would make
      // schema lookup depend on declaration order.
      if (reg.byOriginal.has(original))
        throw new ToolCatalogError(
          `tool "${original}" is declared more than once; names must be unique`,
          { tools: [original] });

      const wire = sanitizeToolName(original);
      reg.byOriginal.set(original, { tool: t, wire, schema: t.input_schema });
      if (!seen.has(wire)) seen.set(wire, []);
      seen.get(wire).push(original);
    }

    for (const [wire, originals] of seen) {
      if (originals.length < 2) continue;
      // Name every colliding tool and say WHY they collided, because the two causes need
      // different fixes: shorten the names, or stop using the punctuation.
      const why = originals.some((o) => o.length > 64)
        ? `they share their first 64 characters, which is OpenAI's limit on a tool name`
        : `they differ only in characters OpenAI does not allow in a tool name ` +
          `(only letters, digits, underscore and hyphen survive)`;
      throw new ToolCatalogError(
        `these tools cannot both be sent: ${originals.map((o) => `"${o}"`).join(" and ")} ` +
        `both become "${wire}" on the wire, because ${why}. A tool call could not be attributed ` +
        `to the right tool, so the request is refused rather than guessing.`,
        { tools: originals });
    }

    // Populate the reverse map only once the catalog is known to be unambiguous. Doing it during
    // the first pass is what let an overwrite silently decide which tool a call belonged to.
    for (const [original, e] of reg.byOriginal) reg.byWire.set(e.wire, original);
    return reg;
  }

  get size() { return this.byOriginal.size; }
  all() { return this.tools; }
  has(original) { return this.byOriginal.has(original); }

  // Original -> wire. Falls back to sanitizing an unknown name so a tool_choice naming something
  // undeclared still produces a well-formed request rather than `undefined`.
  wireName(original) {
    return this.byOriginal.get(original)?.wire ?? sanitizeToolName(original);
  }

  // Wire -> original. Unknown wire names come back unchanged: a model can invent a tool name, and
  // that has to reach the client as the name the model actually used, so the client's own
  // "no such tool" error names the right thing.
  originalName(wire) {
    return this.byWire.get(wire) ?? wire;
  }

  schema(original) {
    return this.byOriginal.get(original)?.schema;
  }

  // Present the same lookup the old code did through a Map, so call sites that only need
  // "wire -> original" do not have to care which object they were handed.
  get nameMap() { return this.byWire; }
}
