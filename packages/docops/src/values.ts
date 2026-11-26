import type { Field } from '@lomi/core';
import { normalizeWhitespace } from './text';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function monthIndex(name: string): number {
  const lower = name.toLowerCase().replace(/\.$/, '');
  return MONTHS.findIndex((m) => m === lower || (lower.length >= 3 && m.startsWith(lower.slice(0, 3))));
}

function iso(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** Parse the common US/ISO/long-form date spellings to an ISO date. US order for slashes. */
export function parseDate(input: string): string | null {
  const s = normalizeWhitespace(input);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) return iso(+m[3], +m[1], +m[2]);
  m = s.match(/^([A-Za-z]{3,9}\.?) (\d{1,2}),? (\d{4})$/);
  if (m && monthIndex(m[1]) >= 0) return iso(+m[3], monthIndex(m[1]) + 1, +m[2]);
  m = s.match(/^(\d{1,2}) ([A-Za-z]{3,9}\.?),? (\d{4})$/);
  if (m && monthIndex(m[2]) >= 0) return iso(+m[3], monthIndex(m[2]) + 1, +m[1]);
  return null;
}

const DATE_IN_TEXT =
  /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2} [A-Za-z]{3,9}\.?,? \d{4}/g;

export function datesIn(text: string): string[] {
  return (normalizeWhitespace(text).match(DATE_IN_TEXT) ?? [])
    .map(parseDate)
    .filter((d): d is string => d !== null);
}

/** Parse an amount like "$1,250.00", "1250", "(12.50)" or "USD 3,000". */
export function parseAmount(input: string): number | null {
  const s = normalizeWhitespace(input);
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/^[A-Z$€£\s]+/, ''));
  const digits = s.replace(/[^0-9.]/g, '');
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  if (!/^[(-]?\s*(?:[A-Z]{3}\s*)?[$€£]?\s*-?[\d,]+(\.\d+)?\s*(?:[A-Z]{3})?\)?$/.test(s)) return null;
  const value = Number(digits);
  return negative ? -value : value;
}

/** A plain number such as "24", "(24)" or "1,200". Percent signs and currency symbols are not numbers here. */
export function parseNumber(input: string): number | null {
  const s = normalizeWhitespace(input).replace(/^\((.*)\)$/, '$1').replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

export function amountsIn(text: string): number[] {
  return (text.match(/[$€£]?\s?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((token) => Number(token.replace(/[^0-9.]/g, '')))
    .filter((n) => Number.isFinite(n));
}

export type ValueKind = 'date' | 'amount' | 'number' | 'text';

export function valueKind(field: Pick<Field, 'type' | 'dataType'>): ValueKind {
  if (field.type === 'date' || field.type === 'dob' || field.dataType === 'date') return 'date';
  if (field.type === 'currency' || field.dataType === 'currency') return 'amount';
  if (field.dataType === 'number') return 'number';
  return 'text';
}

/** Canonical form used for comparisons, carry-over and rendering. Null when unparseable. */
export function normalizeValue(field: Pick<Field, 'type' | 'dataType'>, value: string): string | null {
  const kind = valueKind(field);
  if (kind === 'date') return parseDate(value);
  if (kind === 'amount') {
    const amount = parseAmount(value);
    return amount === null ? null : amount.toFixed(2);
  }
  if (kind === 'number') {
    const n = parseNumber(value);
    return n === null ? null : String(n);
  }
  const text = normalizeWhitespace(value);
  return text || null;
}

/**
 * Deterministic check that a value is actually stated by its quote, so a
 * model cannot pair a real quote with an invented value.
 */
export function valueSupportedByQuote(
  field: Pick<Field, 'type' | 'dataType'>,
  value: string,
  quote: string
): boolean {
  const kind = valueKind(field);
  if (kind === 'date') {
    const target = parseDate(value);
    return target !== null && datesIn(quote).includes(target);
  }
  if (kind === 'amount') {
    const target = parseAmount(value);
    return target !== null && amountsIn(quote).some((n) => Math.abs(n - Math.abs(target)) < 0.005);
  }
  if (kind === 'number') {
    const target = parseNumber(value);
    return target !== null && amountsIn(quote).some((n) => n === target);
  }
  return normalizeWhitespace(quote).toLowerCase().includes(normalizeWhitespace(value).toLowerCase());
}
