/** A JSON value; the type of every JSON column that has no narrower shape. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
