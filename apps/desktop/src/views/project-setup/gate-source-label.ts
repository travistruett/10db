import { GateSource } from '@10db/contracts';

/** Where a candidate gate command came from, as the tooltip on its pill says. */
export const GATE_SOURCE_LABEL: Readonly<Record<GateSource, string>> = {
  [GateSource.Makefile]: 'from Makefile',
  [GateSource.PackageJson]: 'from package.json',
  [GateSource.Cargo]: 'from Cargo.toml',
  [GateSource.Go]: 'from go.mod',
};
