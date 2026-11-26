import { describe, expect, it } from 'vitest';
import {
  ServeStatus,
  isTendbMapping,
  loopbackMappingOn,
  mappingProblem,
  shareRefusal,
} from './serve-mapping';

const FQDN = 'mac.tail1234.ts.net';
const PORT = 4319;
const MAIN = 4318;
const PROXY = `http://127.0.0.1:${String(PORT)}`;
const KEY = `${FQDN}:${String(PORT)}`;

const parse = (value: unknown): ServeStatus => ServeStatus.parse(value);

const tendb = {
  TCP: { [String(PORT)]: { HTTPS: true } },
  Web: { [KEY]: { Handlers: { '/': { Proxy: PROXY } } } },
};

describe('serve mapping', () => {
  const table: {
    name: string;
    serve: unknown;
    own: boolean;
    problem: ReturnType<typeof mappingProblem>;
  }[] = [
    { name: "10db's mapping", serve: tendb, own: true, problem: null },
    {
      name: 'a second handler on the port',
      serve: {
        ...tendb,
        Web: {
          [KEY]: { Handlers: { '/': { Proxy: PROXY }, '/x': { Proxy: 'http://127.0.0.1:1' } } },
        },
      },
      own: false,
      problem: { kind: 'elsewhere', target: `${PROXY}, http://127.0.0.1:1` },
    },
    {
      name: 'the port proxying elsewhere',
      serve: {
        ...tendb,
        Web: { [KEY]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
      },
      own: false,
      problem: { kind: 'elsewhere', target: 'http://127.0.0.1:3000' },
    },
    {
      name: 'Funnel on',
      serve: { ...tendb, AllowFunnel: { [KEY]: true } },
      own: false,
      problem: { kind: 'funnel' },
    },
    {
      name: 'a TCP forward',
      serve: { TCP: { [String(PORT)]: { TCPForward: '127.0.0.1:22' } } },
      own: false,
      problem: { kind: 'tcp' },
    },
    {
      name: 'HTTPS with TerminateTLS',
      serve: { TCP: { [String(PORT)]: { HTTPS: true, TerminateTLS: 'x' } } },
      own: false,
      problem: { kind: 'tcp' },
    },
    {
      name: "another port's mapping",
      serve: {
        TCP: { '8080': { HTTPS: true } },
        Web: { [`${FQDN}:8080`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } },
      },
      own: false,
      problem: null,
    },
    { name: 'empty', serve: {}, own: false, problem: null },
  ];

  it.each(table)('reads $name', ({ serve, own, problem }) => {
    const parsed = parse(serve);
    expect(isTendbMapping(parsed, FQDN, PORT)).toBe(own);
    expect(mappingProblem(parsed, FQDN, PORT)).toEqual(problem);
  });

  it('finds the loopback mapping without a name, and not a foreign one', () => {
    expect(loopbackMappingOn(parse(tendb), PORT)).toBe(true);
    expect(loopbackMappingOn(parse({}), PORT)).toBe(false);
    expect(
      loopbackMappingOn(
        parse({ Web: { [KEY]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }),
        PORT,
      ),
    ).toBe(false);
  });

  it('refuses Funnel ports, privileged ports and the main port', () => {
    for (const port of [443, 8443, 10000, 80, MAIN]) {
      expect(shareRefusal(port, MAIN)).toEqual(expect.any(String));
    }
    expect(shareRefusal(4319, MAIN)).toBeNull();
  });
});
