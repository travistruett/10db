/**
 * Selenized, Jan Warchoł's successor to Solarized: the sRGB values in its `the-values.md`
 * (https://github.com/jan-warchol/selenized). The dark variant themes the dark scheme and the light
 * variant the light one. Each accent has a base and a bright value.
 */

export const SelenizedAccent = {
  Red: 'red',
  Green: 'green',
  Yellow: 'yellow',
  Blue: 'blue',
  Magenta: 'magenta',
  Cyan: 'cyan',
  Orange: 'orange',
  Violet: 'violet',
} as const;
export type SelenizedAccent = (typeof SelenizedAccent)[keyof typeof SelenizedAccent];

export interface SelenizedVariant {
  readonly bg0: string;
  readonly bg1: string;
  readonly bg2: string;
  readonly dim0: string;
  readonly fg0: string;
  readonly fg1: string;
  readonly accents: Readonly<
    Record<SelenizedAccent, { readonly base: string; readonly bright: string }>
  >;
}

export const SelenizedDark: SelenizedVariant = {
  bg0: '#103c48',
  bg1: '#184956',
  bg2: '#2d5b69',
  dim0: '#72898f',
  fg0: '#adbcbc',
  fg1: '#cad8d9',
  accents: {
    red: { base: '#fa5750', bright: '#ff665c' },
    green: { base: '#75b938', bright: '#84c747' },
    yellow: { base: '#dbb32d', bright: '#ebc13d' },
    blue: { base: '#4695f7', bright: '#58a3ff' },
    magenta: { base: '#f275be', bright: '#ff84cd' },
    cyan: { base: '#41c7b9', bright: '#53d6c7' },
    orange: { base: '#ed8649', bright: '#fd9456' },
    violet: { base: '#af88eb', bright: '#bd96fa' },
  },
};

export const SelenizedLight: SelenizedVariant = {
  bg0: '#fbf3db',
  bg1: '#ece3cc',
  bg2: '#d5cdb6',
  dim0: '#909995',
  fg0: '#53676d',
  fg1: '#3a4d53',
  accents: {
    red: { base: '#d2212d', bright: '#cc1729' },
    green: { base: '#489100', bright: '#428b00' },
    yellow: { base: '#ad8900', bright: '#a78300' },
    blue: { base: '#0072d4', bright: '#006dce' },
    magenta: { base: '#ca4898', bright: '#c44392' },
    cyan: { base: '#009c8f', bright: '#00978a' },
    orange: { base: '#c25d1e', bright: '#bc5819' },
    violet: { base: '#8762c6', bright: '#825dc0' },
  },
};
