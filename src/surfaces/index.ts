import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Catalog } from "../catalog/index.ts";
import type { Runtime } from "../core/runtime.ts";
import { codeSurface } from "./code.ts";
import { directSurface } from "./direct.ts";

/** The ways the same tools can be shown to a model. Adding one here adds it to the benchmark. */
export const SURFACES = {
  /** Every tool registered on its own, as the vendor ships it. */
  direct: directSurface,
  /** Two tools: search the functions, run code that calls them. */
  code: codeSurface,
} satisfies Record<string, <W>(catalog: Catalog, runtime: Runtime<W>) => Server>;

export type SurfaceName = keyof typeof SURFACES;
