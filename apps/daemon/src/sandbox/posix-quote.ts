/** `value` in POSIX single quotes, which the shell reads literally; a quote inside is spelled `'\''`. */
export const singleQuoted = (value: string): string => `'${value.split("'").join("'\\''")}'`;
