import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatClock(ms: number): string {
  const date = new Date(ms);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** Counts from a range that includes sampled intervals are lower bounds. */
export function traceCountLabel(count: number, exact: boolean): string {
  return exact ? count.toString() : `≥${count}`;
}

export const SAMPLED_TITLE = 'includes sampled intervals';
