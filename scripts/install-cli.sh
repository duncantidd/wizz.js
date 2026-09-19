#!/usr/bin/env bash
# Wizz installer. Installs the wizz command from a release tarball (the
# distribution unit the release workflow attaches to GitHub Releases), from
# an explicit tarball, or — for development installs — from this working
# tree. The installed tree is self-contained: nothing registers with npm.
set -euo pipefail

repository="duncantidd/wizz.js"
source_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
data_directory="${XDG_DATA_HOME:-$HOME/.local/share}/wizz"
bin_directory="${XDG_BIN_HOME:-$HOME/.local/bin}"
data_parent=$(dirname "$data_directory")

usage() {
  printf 'Usage:\n'
  printf '  install-cli.sh              Install the latest Wizz release tarball from GitHub.\n'
  printf '  install-cli.sh <path|URL>   Install a specific release tarball (local file or URL).\n'
  printf '  install-cli.sh --local      Install from this working tree (development installs).\n'
}

if ! command -v node >/dev/null 2>&1; then
  printf 'Wizz requires Node.js 18 or newer. Install Node.js and run this installer again.\n' >&2
  exit 1
fi

node_major_version=$(node -p 'process.versions.node.split(".")[0]')
if (( node_major_version < 18 )); then
  printf 'Wizz requires Node.js 18 or newer; found Node.js %s.\n' "$(node --version)" >&2
  exit 1
fi

argument=${1:---latest}
case "$argument" in
  --local)
    install_mode="local"
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  --latest)
    install_mode="latest"
    ;;
  http://* | https://*)
    install_mode="url"
    tarball_source="$argument"
    ;;
  -*)
    usage >&2
    exit 1
    ;;
  *)
    install_mode="tarball"
    tarball_source="$argument"
    ;;
esac

mkdir -p "$data_parent" "$bin_directory"
staging_directory=$(mktemp -d "$data_parent/.wizz-install.XXXXXX")
trap 'rm -rf "$staging_directory"' EXIT

if [ "$install_mode" = "local" ]; then
  cp "$source_directory/build.js" "$staging_directory/"
  cp -R "$source_directory/src" "$staging_directory/src"
  mkdir -p "$staging_directory/scripts"
  cp "$source_directory/scripts/cli.js" "$source_directory/scripts/dev.js" "$staging_directory/scripts/"
else
  if ! command -v curl >/dev/null 2>&1; then
    printf 'Downloading a release tarball requires curl. Install curl, or pass a local tarball path.\n' >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    printf 'Extracting a release tarball requires tar.\n' >&2
    exit 1
  fi

  if [ "$install_mode" = "latest" ]; then
    printf 'Resolving the latest Wizz release from GitHub...\n'
    asset_url=$(curl -fsSL "https://api.github.com/repos/$repository/releases/latest" | node -e '
      let payload = "";
      process.stdin.on("data", (chunk) => { payload += chunk; });
      process.stdin.on("end", () => {
        const release = JSON.parse(payload);
        if (release.message) {
          console.error("GitHub API error: " + release.message);
          process.exit(1);
        }
        const asset = (release.assets || []).find((candidate) => /^wizz-\d+\.\d+\.\d+\.tgz$/.test(candidate.name));
        if (!asset) {
          console.error("The latest release carries no wizz-<version>.tgz asset.");
          process.exit(1);
        }
        console.log(asset.browser_download_url);
      });
    ')
  elif [ "$install_mode" = "url" ]; then
    asset_url="$tarball_source"
  else
    if [ ! -f "$tarball_source" ]; then
      printf 'Tarball not found: %s\n' "$tarball_source" >&2
      exit 1
    fi
    cp "$tarball_source" "$staging_directory/wizz.tgz"
  fi

  if [ -n "${asset_url:-}" ]; then
    curl -fsSL "$asset_url" -o "$staging_directory/wizz.tgz"
  fi

  tar -xzf "$staging_directory/wizz.tgz" -C "$staging_directory"
  # A truncated or foreign tarball must fail loudly, not install garbage.
  if [ ! -f "$staging_directory/package/scripts/cli.js" ]; then
    printf 'The tarball does not contain a Wizz package (missing package/scripts/cli.js).\n' >&2
    exit 1
  fi
  rm -f "$staging_directory/wizz.tgz"
  installed_version=$(node -p "require('$staging_directory/package/package.json').version")
fi

rm -rf "$data_directory"
if [ "$install_mode" = "local" ]; then
  mv "$staging_directory" "$data_directory"
else
  mv "$staging_directory/package" "$data_directory"
fi
trap - EXIT

if [ -z "${installed_version:-}" ]; then
  installed_version=$(node -p "require('$data_directory/src/compiler/version.js').VERSIONS.compiler")
fi

cat > "$bin_directory/wizz" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "$data_directory/scripts/cli.js" "\$@"
EOF
chmod +x "$bin_directory/wizz"

printf 'Installed Wizz %s to %s\n' "$installed_version" "$data_directory"
printf 'Command launcher: %s\n' "$bin_directory/wizz"
case ":$PATH:" in
  *":$bin_directory:"*) ;;
  *) printf 'Add %s to your PATH to run wizz from any directory.\n' "$bin_directory" ;;
esac
