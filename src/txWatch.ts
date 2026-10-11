// How long a console's manual transaction has been open, how many statements it holds, and when that deserves
// attention: the indicator next to Commit/Rollback, the tab's badge, the status bar and the reminder (state.ts) all
// read these. Pure functions (dev/txwatch-check.ts).
import { codeOnly, splitSql } from "./sql.ts";

export type TxLevel = "ok" | "warn" | "alert";

export interface TxThresholds {
  warnSecs: number;
  alertSecs: number;
}

export interface TxSettings {
  txWarnSecs: number;
  txAlertSecs: number;
  txProdWarnSecs: number;
  txProdAlertSecs: number;
}

/** A console's transaction as the tab keeps it. */
export interface TxState {
  inTransaction: boolean;
  /** When it began (the first run that left it open); null when there is none. */
  txStartedAt: number | null;
  /** Statements run inside it. */
  txStatements: number;
  /** Reminders already given for it. */
  txReminders: number;
}

export const NO_TX: Omit<TxState, "inTransaction"> = { txStartedAt: null, txStatements: 0, txReminders: 0 };

/** The thresholds for a connection: the production ones on production (never laxer than the general ones). */
export function txThresholds(settings: TxSettings, production: boolean): TxThresholds {
  const warnSecs = positive(settings.txWarnSecs, 60);
  const alertSecs = Math.max(warnSecs, positive(settings.txAlertSecs, 300));
  if (!production) return { warnSecs, alertSecs };
  const prodWarn = Math.min(warnSecs, positive(settings.txProdWarnSecs, 30));
  return { warnSecs: prodWarn, alertSecs: Math.max(prodWarn, Math.min(alertSecs, positive(settings.txProdAlertSecs, 120))) };
}

const positive = (value: number, fallback: number) => (Number.isFinite(value) && value > 0 ? value : fallback);

/** ok below the first threshold, warn (amber) past it, alert (red) past the second. */
export function txLevel(ms: number, th: TxThresholds): TxLevel {
  if (ms >= th.alertSecs * 1000) return "alert";
  if (ms >= th.warnSecs * 1000) return "warn";
  return "ok";
}

/** "<1 min", "3 min", "1 h 05 min". */
export function txDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** "Transacción abierta · 3 min · 2 sentencias". */
export function txLabel(ms: number, statements: number): string {
  return `Transacción abierta · ${txDuration(ms)} · ${statements} ${statements === 1 ? "sentencia" : "sentencias"}`;
}

/** Statements in what was run (pieces that are only comments do not count); at least one. */
export function countStatements(sql: string, kind?: string): number {
  return Math.max(1, splitSql(sql, kind).filter((part) => codeOnly(part.sql, kind).trim()).length);
}

/**
 * The transaction after a run of `statements` statements that left the session `inTransaction`: it begins with the
 * run that opened it, adds the statements of the following ones and is forgotten once committed or rolled back.
 */
export function txAfterRun(before: TxState, inTransaction: boolean, statements: number, at: number): TxState {
  if (!inTransaction) return { inTransaction, ...NO_TX };
  if (!before.inTransaction || before.txStartedAt === null) return { inTransaction, txStartedAt: at, txStatements: statements, txReminders: 0 };
  return { inTransaction, txStartedAt: before.txStartedAt, txStatements: before.txStatements + statements, txReminders: before.txReminders };
}

/** A reminder is due: once past the red threshold, and again each time that much more goes by. */
export function reminderDue(ms: number, th: TxThresholds, given: number): boolean {
  const alertMs = th.alertSecs * 1000;
  return alertMs > 0 && Math.floor(ms / alertMs) > given;
}

/** The worst of several levels (the status bar's colour). */
export function worstLevel(levels: TxLevel[]): TxLevel {
  return levels.includes("alert") ? "alert" : levels.includes("warn") ? "warn" : "ok";
}
