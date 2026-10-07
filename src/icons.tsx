import { Show, type JSX } from "solid-js";
import { BRAND_PATHS } from "./brandIcons";
import type { DbKind } from "./types";

/** Database object glyphs on a 16 px grid, DataGrip-style and colour-coded by kind. */
const OBJ: Record<string, { color: string; body: () => JSX.Element }> = {
  database: {
    color: "var(--obj-db)",
    body: () => (
      <>
        <ellipse cx="8" cy="3.8" rx="5" ry="1.9" />
        <path d="M3 3.8v8.4c0 1 2.2 1.9 5 1.9s5-.9 5-1.9V3.8" />
        <path d="M3 8c0 1 2.2 1.9 5 1.9s5-.9 5-1.9" />
      </>
    ),
  },
  schema: {
    color: "var(--obj-schema)",
    body: () => (
      <>
        <path d="M2 4.5h4.2l1.3 1.5H14v7.5H2z" />
        <path d="M5 9h6M5 11h4" />
      </>
    ),
  },
  folder: {
    color: "var(--text-faint)",
    body: () => <path d="M1.8 4h4.4l1.4 1.6h6.6v7.6H1.8z" />,
  },
  table: {
    color: "var(--obj-table)",
    body: () => (
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <path d="M2 6.2h12M2 9.8h12M6.4 6.2v7.3" />
        <path d="M2.6 3.1h10.8v3.1H2.6z" fill="currentColor" stroke="none" opacity=".35" />
      </>
    ),
  },
  view: {
    color: "var(--obj-view)",
    body: () => (
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <path d="M2 6.2h12" />
        <path d="M4.2 10c1-1.4 2.3-2.1 3.8-2.1s2.8.7 3.8 2.1c-1 1.4-2.3 2.1-3.8 2.1S5.2 11.4 4.2 10z" />
        <circle cx="8" cy="10" r=".9" fill="currentColor" />
      </>
    ),
  },
  mview: {
    color: "var(--obj-view)",
    body: () => (
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <path d="M2 6.2h12" />
        <path d="M5 12V8.4l3 2 3-2V12" />
      </>
    ),
  },
  column: {
    color: "var(--obj-column)",
    body: () => (
      <>
        <rect x="3" y="6" width="10" height="4" rx="1" />
      </>
    ),
  },
  pkcolumn: {
    color: "var(--obj-key)",
    body: () => (
      <>
        <circle cx="5.3" cy="8" r="2.6" />
        <path d="M7.9 8H14M11.6 8v2.3M13.6 8v1.6" />
      </>
    ),
  },
  key: {
    color: "var(--obj-key)",
    body: () => (
      <>
        <circle cx="5" cy="6" r="2.4" />
        <path d="M7.4 6h6.1M11.2 6v2" />
        <path d="M6 11.5h7M11 9.6l2 1.9-2 1.9" />
      </>
    ),
  },
  index: {
    color: "var(--obj-index)",
    body: () => <path d="M9.2 1.8 3.6 9h4.1l-1 5.2L12.4 7H8.3z" />,
  },
  trigger: {
    color: "var(--obj-trigger)",
    body: () => (
      <>
        <path d="M7 1.8 2.8 7.6h3.1L5.2 12 9.4 6.2H6.3z" />
        <circle cx="11.6" cy="11" r="2.8" />
        <path d="M11.6 9.6V11l.9.7" />
      </>
    ),
  },
  procedure: {
    color: "var(--obj-routine)",
    body: () => (
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="2" />
        <path d="M6.4 5.6v4.8L10.4 8z" fill="currentColor" />
      </>
    ),
  },
  function: {
    color: "var(--obj-routine)",
    body: () => (
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="2" />
        <path d="M9.6 5.2c-1.6-.5-2.4.2-2.6 1.6L6.4 11c-.2 1.3-.9 1.7-2 1.3M5.4 7.8h4" />
      </>
    ),
  },
  sequence: {
    color: "var(--obj-sequence)",
    body: () => (
      <>
        <path d="M3 5.2 4.4 4v8M7.2 5.4c.3-.9 1-1.4 1.9-1.4 1.1 0 1.8.7 1.8 1.6 0 1.8-3.7 3.4-3.7 6.4h3.9" />
        <path d="M12.2 4h1.6l-1 2.3c.9.1 1.4.8 1.4 1.7" opacity=".7" />
      </>
    ),
  },
  synonym: {
    color: "var(--text-muted)",
    body: () => <path d="M3 6h8l-2-2M13 10H5l2 2" />,
  },
  user: {
    color: "var(--text-muted)",
    body: () => (
      <>
        <circle cx="8" cy="5.5" r="2.5" />
        <path d="M3.2 13.5c.6-2.5 2.5-3.8 4.8-3.8s4.2 1.3 4.8 3.8" />
      </>
    ),
  },
  console: {
    color: "var(--accent)",
    body: () => (
      <>
        <rect x="1.8" y="2.5" width="12.4" height="11" rx="2" />
        <path d="m4.6 6.3 2.2 1.9-2.2 1.9M8.4 10.6h3" />
      </>
    ),
  },
  file: {
    color: "var(--text-muted)",
    body: () => (
      <>
        <path d="M3.5 1.8h5.6l3.4 3.4v9H3.5z" />
        <path d="M9 1.8v3.5h3.5M5.6 9h4.8M5.6 11.3h3.4" />
      </>
    ),
  },
};

export function ObjIcon(props: { kind: string; size?: number; class?: string }) {
  const def = () => OBJ[normalize(props.kind)] ?? OBJ.folder;
  const size = () => props.size ?? 16;
  return (
    <svg
      class={`obj-icon ${props.class ?? ""}`}
      width={size()}
      height={size()}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.25"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={{ color: def().color }}
      aria-hidden="true"
    >
      {def().body()}
    </svg>
  );
}

function normalize(kind: string) {
  const k = kind.toLowerCase();
  if (k === "materialized view" || k === "matview" || k === "materialized_view") return "mview";
  if (k === "fk" || k === "foreign key" || k === "constraint") return "key";
  if (k === "routine") return "procedure";
  return k;
}

/**
 * Engine logo. PostgreSQL, MySQL, MariaDB and SQLite use their official marks (Simple Icons, CC0 paths;
 * trademarks of their owners). Microsoft and IBM do not license their logos for this use, so SQL Server,
 * Informix and generic ODBC get a neutral database glyph in the engine's colour.
 * `server` (the server banner) lets a MySQL connection show the MariaDB seal when it talks to MariaDB.
 */
export function EngineIcon(props: { kind: DbKind; size?: number; server?: string }) {
  const size = () => props.size ?? 16;
  const brand = () => {
    if (props.kind === "mysql" && /mariadb/i.test(props.server ?? "")) return "mariadb";
    return props.kind;
  };
  const official = () => BRAND_PATHS[brand()];
  return (
    <Show
      when={official()}
      fallback={
        <svg class="engine-icon neutral" width={size()} height={size()} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ color: `var(--engine-${props.kind}, ${NEUTRAL[props.kind] ?? "#7C8796"})` }}>
          <ellipse cx="8" cy="3.6" rx="5.6" ry="2.1" fill="currentColor" opacity=".9" />
          <path d="M2.4 3.6v8.6c0 1.16 2.5 2.1 5.6 2.1s5.6-.94 5.6-2.1V3.6" stroke="currentColor" stroke-width="1.4" />
          <path d="M2.4 7.9c0 1.16 2.5 2.1 5.6 2.1s5.6-.94 5.6-2.1" stroke="currentColor" stroke-width="1.4" />
          <Show when={props.kind === "odbc"}>
            <path d="M6 8.4h4M8 6.6v3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".8" />
          </Show>
        </svg>
      }
    >
      <svg class="engine-icon" width={size()} height={size()} viewBox={BRAND_VIEW[brand()] ?? "0 0 24 24"} aria-hidden="true" role="img">
        <title>{official()!.title}</title>
        <path
          d={official()!.path}
          fill={`var(--engine-${brand()}, ${official()!.hex})`}
          stroke={BRAND_STROKE[brand()] ? `var(--engine-${brand()}, ${official()!.hex})` : undefined}
          stroke-width={BRAND_STROKE[brand()]}
          stroke-linejoin="round"
        />
      </svg>
    </Show>
  );
}

/** The MySQL mark is a wordmark; at icon size only the dolphin is shown. */
const BRAND_VIEW: Record<string, string> = { mysql: "13.6 1.6 10 10" };
/** Line-art logos get a hairline of their own colour so they survive 14–16 px. */
const BRAND_STROKE: Record<string, number> = { postgres: 0.45, mysql: 0.3 };

const NEUTRAL: Record<string, string> = {
  mssql: "#C8372D",
  informix: "#3F6FB5",
  odbc: "#7C8796",
};
