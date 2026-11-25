import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
};

const VERSION = requireEnv('VERSION');
const HOMEBREW_TAP_TOKEN = requireEnv('HOMEBREW_TAP_TOKEN');

const labels = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const releasesDir = join(
  import.meta.dir,
  '..',
  'apps',
  'cli',
  'dist',
  'releases',
);

const sha256File = (path: string): string => {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(readFileSync(path));
  return hasher.digest('hex');
};

const shas = Object.fromEntries(
  labels.map((label) => [
    label,
    sha256File(join(releasesDir, `traces-${label}.tar.gz`)),
  ]),
);

const releaseTag = encodeURIComponent(`@traces/cli@${VERSION}`);
const baseUrl = `https://github.com/fdarian/traces/releases/download/${releaseTag}`;

const assetUrl = (label: string): string => `${baseUrl}/traces-${label}.tar.gz`;

const formula = `class Traces < Formula
  desc "Read logs, deployments and traces from Vercel, Railway and Jaeger"
  homepage "https://github.com/fdarian/traces"
  version "${VERSION}"

  on_macos do
    if Hardware::CPU.arm?
      url "${assetUrl('darwin-arm64')}"
      sha256 "${shas['darwin-arm64']}"
    else
      url "${assetUrl('darwin-x64')}"
      sha256 "${shas['darwin-x64']}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${assetUrl('linux-arm64')}"
      sha256 "${shas['linux-arm64']}"
    else
      url "${assetUrl('linux-x64')}"
      sha256 "${shas['linux-x64']}"
    end
  end

  def install
    bin.install "traces"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/traces --version")
  end
end
`;

const tmpDir = join(tmpdir(), `homebrew-tap-${Date.now()}`);

const runGit = (args: string[], cwd?: string): void => {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed with exit code ${result.exitCode}`);
  }
};

try {
  runGit([
    'clone',
    `https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/fdarian/homebrew-tap`,
    tmpDir,
  ]);

  mkdirSync(join(tmpDir, 'Formula'), { recursive: true });
  writeFileSync(join(tmpDir, 'Formula', 'traces.rb'), formula);

  runGit(
    ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'],
    tmpDir,
  );
  runGit(['config', 'user.name', 'github-actions[bot]'], tmpDir);
  runGit(['add', 'Formula/traces.rb'], tmpDir);
  runGit(['commit', '-m', `traces ${VERSION}`], tmpDir);
  runGit(['push'], tmpDir);

  console.log(`Updated homebrew-tap formula to traces ${VERSION}`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
