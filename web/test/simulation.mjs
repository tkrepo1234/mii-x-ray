// The simulation mode of the generator: the default-mode file converted by tools/sim-convert (Roslyn from the .NET
// SDK, built on first use). Generating in simulation mode and converting a default-mode file are the same step, so a
// file X-rayed on MII (default mode) and one generated here give the same simulation code.
//   node web/test/simulation.mjs <in.xray.cs> <out.sim.cs>
import { existsSync, statSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const project = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'sim-convert');
const dotnet = join(process.env.ProgramFiles || 'C:/Program Files', 'dotnet', 'dotnet.exe');
const dll = join(project, 'bin', 'Release', 'net9.0', 'SimConvert.dll');

/** Builds the converter when it is missing or older than its sources. */
export function buildConverter() {
  const sources = readdirSync(project).filter((name) => /\.(cs|txt|csproj)$/.test(name)).map((name) => join(project, name))
    .concat([join(project, '..', '..', 'src', 'Generate', 'RuntimeSource.txt')]);
  const newest = Math.max(...sources.map((file) => statSync(file).mtimeMs));

  if (!existsSync(dll) || statSync(dll).mtimeMs < newest) {
    execFileSync(dotnet, ['build', join(project, 'SimConvert.csproj'), '-c', 'Release', '-nologo', '-v', 'q'], { stdio: 'pipe' });
  }

  return dll;
}

/** Converts default-mode files into the simulation mode: pairs of [input, output] paths. */
export function convertToSimulation(pairs) {
  buildConverter();
  const folder = mkdtempSync(join(tmpdir(), 'xray-sim-'));
  const list = join(folder, 'list.txt');
  writeFileSync(list, pairs.map(([input, output]) => resolve(input) + '|' + resolve(output)).join('\n'));

  try {
    return execFileSync(dotnet, [dll, '--batch', list], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    throw new Error('sim-convert failed:\n' + (error.stdout || '') + (error.stderr || ''));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);

  if (!input || !output) {
    console.error('usage: node web/test/simulation.mjs <in.xray.cs> <out.sim.cs>');
    process.exit(2);
  }

  process.stdout.write(convertToSimulation([[input, output]]));
}
