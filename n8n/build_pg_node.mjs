/**
 * Postgres node factory for builder-driven workflows.
 *
 * Replaces the per-builder `sheetsCommon` block that previously generated
 * `n8n-nodes-base.googleSheets` descriptors. All four workflow builders
 * import `pgNode` and reuse a single credential reference,
 * `Postgres - POD Research`.
 *
 * Usage:
 *   import { pgNode, pgCreds, pgSchema, pgTableRl } from "./build_pg_node.mjs";
 *
 *   pgNode({ operation: "insert", table: "raw_signals",
 *            columns: ["signal_id", "term", "date_collected"] });
 *
 *   pgNode({ operation: "upsert", table: "normalized_terms",
 *            columns: ["canonical_id","canonical_term","status","last_scored_at"],
 *            conflictColumns: ["canonical_id"] });
 *
 *   pgNode({ operation: "executeQuery",
 *            query: "SELECT * FROM raw_signals WHERE date_collected::date = $1::date",
 *            parameters: ["={{ $json.today }}"] });
 *
 * Returns the parameter+typeVersion+credentials hunk that callers spread
 * into a node descriptor:
 *   { parameters: { ... }, type: "n8n-nodes-base.postgres",
 *     typeVersion: 2.6, credentials: pgCreds }
 *
 * The caller still provides `id`, `name`, and `position`.
 */

const PG_TYPE = "n8n-nodes-base.postgres";
const PG_TYPE_VERSION = 2.6;
const PG_CRED_NAME = "Postgres - POD Research";
const PG_SCHEMA_DEFAULT = "public";

export const pgCreds = {
  postgres: { name: PG_CRED_NAME },
};

export const pgSchema = (schema = PG_SCHEMA_DEFAULT) => ({
  __rl: true,
  mode: "list",
  value: schema,
});

export const pgTableRl = (table) => ({
  __rl: true,
  mode: "list",
  value: table,
});

function ensureColumnsArray(columns, opName) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error(`pgNode(${opName}): columns must be a non-empty string[]`);
  }
  for (const c of columns) {
    if (typeof c !== "string" || !c.trim()) {
      throw new Error(`pgNode(${opName}): every column must be a non-empty string`);
    }
  }
}

function autoMapColumns(columns, matchingColumns) {
  return {
    mappingMode: "autoMapInputData",
    value: {},
    matchingColumns: matchingColumns ?? [],
    schema: columns.map((c) => ({
      id: c,
      displayName: c,
      required: false,
      defaultMatch: false,
      display: true,
      type: "string",
      canBeUsedToMatch: true,
    })),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  };
}

function defineBelowColumns(columns, matchingColumns, valueOverrides) {
  const value = {};
  for (const c of columns) {
    value[c] = valueOverrides?.[c] ?? `={{ $json.${c} }}`;
  }
  return {
    mappingMode: "defineBelow",
    value,
    matchingColumns: matchingColumns ?? [],
    schema: columns.map((c) => ({
      id: c,
      displayName: c,
      required: false,
      defaultMatch: false,
      display: true,
      type: "string",
      canBeUsedToMatch: true,
    })),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  };
}

/**
 * Build an n8n Postgres node hunk.
 *
 * @param {object} args
 * @param {"insert"|"upsert"|"update"|"delete"|"executeQuery"} args.operation
 * @param {string} [args.table]              required for insert/upsert/update/delete
 * @param {string[]} [args.columns]          column list for insert/upsert/update
 * @param {string[]} [args.conflictColumns]  required for upsert; matchingColumns for update
 * @param {string} [args.query]              required for executeQuery
 * @param {string[]} [args.parameters]       optional $1..$N bindings (executeQuery)
 * @param {string} [args.schema]             defaults to "public"
 * @param {"defineBelow"|"autoMapInputData"} [args.mappingMode]
 *                                             defaults to "autoMapInputData"
 * @param {Record<string,string>} [args.valueOverrides]
 *                                             only used when mappingMode==="defineBelow"
 * @param {object} [args.options]            extra options merged into options bag
 */
export function pgNode(args) {
  const {
    operation,
    table,
    columns,
    conflictColumns,
    query,
    parameters,
    schema = PG_SCHEMA_DEFAULT,
    mappingMode = "autoMapInputData",
    valueOverrides,
    options = {},
  } = args || {};

  if (!operation) throw new Error("pgNode: operation is required");

  const base = {
    type: PG_TYPE,
    typeVersion: PG_TYPE_VERSION,
    credentials: { ...pgCreds },
  };

  if (operation === "executeQuery") {
    if (typeof query !== "string" || !query.trim()) {
      throw new Error("pgNode(executeQuery): query is required");
    }
    const opts = { ...options };
    if (Array.isArray(parameters) && parameters.length) {
      opts.queryReplacement = parameters.join(",");
    }
    return {
      ...base,
      parameters: {
        operation: "executeQuery",
        query,
        options: opts,
      },
    };
  }

  if (!table) throw new Error(`pgNode(${operation}): table is required`);

  if (operation === "insert") {
    ensureColumnsArray(columns, "insert");
    const colsHunk =
      mappingMode === "defineBelow"
        ? defineBelowColumns(columns, [], valueOverrides)
        : autoMapColumns(columns, []);
    return {
      ...base,
      parameters: {
        operation: "insert",
        schema: pgSchema(schema),
        table: pgTableRl(table),
        columns: colsHunk,
        options: { ...options },
      },
    };
  }

  if (operation === "upsert") {
    ensureColumnsArray(columns, "upsert");
    if (!Array.isArray(conflictColumns) || !conflictColumns.length) {
      throw new Error("pgNode(upsert): conflictColumns must be a non-empty string[]");
    }
    const colsHunk =
      mappingMode === "defineBelow"
        ? defineBelowColumns(columns, conflictColumns, valueOverrides)
        : autoMapColumns(columns, conflictColumns);
    return {
      ...base,
      parameters: {
        operation: "upsert",
        schema: pgSchema(schema),
        table: pgTableRl(table),
        columns: colsHunk,
        options: { ...options },
      },
    };
  }

  if (operation === "update") {
    ensureColumnsArray(columns, "update");
    if (!Array.isArray(conflictColumns) || !conflictColumns.length) {
      throw new Error("pgNode(update): conflictColumns (matchingColumns) required");
    }
    const colsHunk =
      mappingMode === "defineBelow"
        ? defineBelowColumns(columns, conflictColumns, valueOverrides)
        : autoMapColumns(columns, conflictColumns);
    return {
      ...base,
      parameters: {
        operation: "update",
        schema: pgSchema(schema),
        table: pgTableRl(table),
        columns: colsHunk,
        options: { ...options },
      },
    };
  }

  if (operation === "delete") {
    if (!Array.isArray(conflictColumns) || !conflictColumns.length) {
      throw new Error("pgNode(delete): conflictColumns (matchingColumns) required");
    }
    return {
      ...base,
      parameters: {
        operation: "delete",
        schema: pgSchema(schema),
        table: pgTableRl(table),
        deleteCommand: "delete",
        whereClauses: {
          values: conflictColumns.map((c) => ({
            column: c,
            condition: "equal",
            value: `={{ $json.${c} }}`,
          })),
        },
        options: { ...options },
      },
    };
  }

  throw new Error(`pgNode: unsupported operation "${operation}"`);
}

export default pgNode;
