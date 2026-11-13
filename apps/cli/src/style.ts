export type Style = {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly green: (text: string) => string;
  readonly red: (text: string) => string;
  readonly yellow: (text: string) => string;
};

const ESC = '\u001b[';

const paint =
  (open: number, close: number) =>
  (text: string): string =>
    `${ESC}${open}m${text}${ESC}${close}m`;

const identity = (text: string): string => text;

export const makeStyle = (enabled: boolean): Style =>
  enabled
    ? {
        bold: paint(1, 22),
        dim: paint(2, 22),
        green: paint(32, 39),
        red: paint(31, 39),
        yellow: paint(33, 39),
      }
    : {
        bold: identity,
        dim: identity,
        green: identity,
        red: identity,
        yellow: identity,
      };

/** Follows https://no-color.org: any non-empty NO_COLOR turns color off. */
export const stdoutStyle = (): Style =>
  makeStyle(
    process.stdout.isTTY === true &&
      (process.env.NO_COLOR === undefined || process.env.NO_COLOR === ''),
  );
