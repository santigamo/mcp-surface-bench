/** One row of a documented field table: an input parameter or an output field. */
export type FieldRow = {
  /** Dotted path, with `[]` marking array items: `orderItems[].priceBase`. */
  path: string;
  /** The type cell exactly as documented, without backticks: `string or number`, `enum or null`. */
  type: string;
  /** Allowed values when the type is an enum. */
  values?: string[];
  /** Inputs: `Yes` | `No`. Outputs: `Always` | `Can be null` | `Can be absent` | `Null or absent`. */
  flag: string;
  description: string;
};

/** A tool as its documentation page describes it. */
export type ToolDoc = {
  /** Full tool name as the server registers it. */
  name: string;
  /** Human title of the page. */
  title: string;
  kind: "read" | "write";
  /** External systems a write can change. */
  reaches: string[];
  /** The text the server sends to the model as the tool description. */
  description: string;
  inputs: FieldRow[];
  /** One entry per documented result shape; most tools have exactly one. */
  outputs: { label: string; rows: FieldRow[] }[];
};

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
};

/** A tool ready to be registered on an MCP server. */
export type ToolSpec = ToolDoc & {
  /** Input schema including the inputs every tool shares. */
  inputSchema: JsonSchema;
  /** The tool's own inputs only, used to validate a call after the shared inputs are set aside. */
  ownInputSchema: JsonSchema;
  /** Validates a handler's result: one of the documented shapes. */
  outputSchema: JsonSchema;
};

export type Catalog = {
  /** Where the documentation was fetched from. */
  source: string;
  /** Prefix every tool name shares, e.g. `acme-`. */
  prefix: string;
  tools: ToolSpec[];
};
