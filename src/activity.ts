// Server activity: who is connected and what they are running, per engine, with the statements to cancel a
// running query or end a session. Celer reads it on a side session (see components/ActivityView.tsx).
import type { Cell, DbKind, ResultSet } from "./types";

export interface ServerSession {
  id: string;
  user: string;
  database: string;
  app: string;
  client: string;
  /** active / idle / idle in transaction / Sleep / running… as the engine says it. */
  state: string;
  wait: string;
  /** How long the current statement (or the transaction, when idle in one) has been running. */
  durationMs: number | null;
  query: string;
  /** The session blocking this one, when the engine says so. */
  blockedBy: string;
  /** Celer's own monitor session. */
  self: boolean;
}

export interface ActivitySpec {
  list: string;
  /** Statement to cancel the running query of a session (null: the engine cannot, only end the session). */
  cancel: ((id: string) => string) | null;
  kill: ((id: string) => string) | null;
  /** The monitor's own session id. */
  self: string;
}

const int = (id: string) => String(Number.parseInt(id, 10));

export function activitySpec(kind: DbKind | undefined): ActivitySpec | null {
  switch (kind) {
    case "postgres":
      return {
        list: `SELECT pid, usename, datname, application_name, coalesce(client_addr::text, ''), coalesce(state, ''),
          coalesce(wait_event_type || ': ' || wait_event, ''),
          (extract(epoch FROM (clock_timestamp() - coalesce(CASE WHEN state = 'active' THEN query_start END, xact_start))) * 1000)::bigint,
          coalesce(query, ''), coalesce(array_to_string(pg_blocking_pids(pid), ', '), '')
          FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY state = 'active' DESC, query_start`,
        cancel: (id) => `SELECT pg_cancel_backend(${int(id)})`,
        kill: (id) => `SELECT pg_terminate_backend(${int(id)})`,
        self: "SELECT pg_backend_pid()",
      };
    case "mysql":
      return {
        list: "SELECT ID, USER, COALESCE(DB, ''), '', HOST, COMMAND, COALESCE(STATE, ''), TIME * 1000, COALESCE(INFO, ''), '' FROM information_schema.PROCESSLIST ORDER BY COMMAND = 'Sleep', TIME DESC",
        cancel: (id) => `KILL QUERY ${int(id)}`,
        kill: (id) => `KILL ${int(id)}`,
        self: "SELECT CONNECTION_ID()",
      };
    case "mssql":
      return {
        list: `SELECT s.session_id, s.login_name, COALESCE(DB_NAME(COALESCE(r.database_id, s.database_id)), ''), COALESCE(s.program_name, ''),
          COALESCE(s.host_name, ''), COALESCE(r.status, s.status), COALESCE(r.wait_type, ''),
          CASE WHEN r.start_time IS NOT NULL THEN DATEDIFF(ms, r.start_time, GETDATE()) END,
          COALESCE(t.text, ''), COALESCE(CAST(NULLIF(r.blocking_session_id, 0) AS varchar(10)), '')
          FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
          OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
          WHERE s.is_user_process = 1 ORDER BY CASE WHEN r.session_id IS NULL THEN 1 ELSE 0 END, r.start_time`,
        cancel: null,
        kill: (id) => `KILL ${int(id)}`,
        self: "SELECT @@SPID",
      };
    case "informix":
      return {
        list: "SELECT s.sid, s.username, '', '', s.hostname, '', '', NULL::int8, '', '' FROM sysmaster:syssessions s ORDER BY s.sid",
        cancel: null,
        kill: (id) => `EXECUTE FUNCTION sysadmin:task('onmode', 'z', '${int(id)}')`,
        self: "SELECT DBINFO('sessionid') FROM sysmaster:sysdual",
      };
    default:
      return null;
  }
}

const str = (cell: Cell) => (cell === null || cell === undefined ? "" : String(cell));

/** Rows of `activitySpec().list` (always ten columns, in that order) as sessions. */
export function readSessions(result: ResultSet | undefined, self: string): ServerSession[] {
  return (result?.rows ?? []).map((row) => {
    const id = str(row[0]);
    const duration = row[7] === null || row[7] === undefined || row[7] === "" ? null : Number(row[7]);
    return {
      id,
      user: str(row[1]),
      database: str(row[2]),
      app: str(row[3]),
      client: str(row[4]),
      state: str(row[5]),
      wait: str(row[6]),
      durationMs: Number.isFinite(duration) ? duration : null,
      query: describeQuery(str(row[8]).trim()),
      blockedBy: str(row[9]),
      self: id === self,
    };
  });
}

/**
 * Celer reads PostgreSQL results through cursors, so the server shows "FETCH … FROM celer_cur_N" while a
 * console runs (the original text is only visible from that session): say what it is.
 */
function describeQuery(query: string): string {
  const fetch = /^FETCH\s+(?:FORWARD\s+)?(\d+)\s+FROM\s+"?(celer_cur_\d+)"?/i.exec(query);
  return fetch ? `(Celer leyendo resultados: ${query})` : query;
}

/** Sessions doing something right now (not idle, not sleeping). */
export function isBusy(session: ServerSession): boolean {
  const state = session.state.toLowerCase();
  return !(state === "" || state === "idle" || state === "sleep" || state === "sleeping" || state === "dormant");
}
