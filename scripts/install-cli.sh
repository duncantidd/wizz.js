#!/usr/bin/env bash
set -euo pipefail

source_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
data_directory="${XDG_DATA_HOME:-$HOME/.local/share}/wizz"
bin_directory="${XDG_BIN_HOME:-$HOME/.local/bin}"
data_parent=$(dirname "$data_directory")

if ! command -v node >/dev/null 2>&1; then
  printf 'Wizz requires Node.js 18 or newer. Install Node.js and run this installer again.\n' >&2
  exit 1
fi

node_major_version=$(node -p 'process.versions.node.split(".")[0]')
if (( node_major_version < 18 )); then
  printf 'Wizz requires Node.js 18 or newer; found Node.js %s.\n' "$(node --version)" >&2
  exit 1
fi

mkdir -p "$data_parent" "$bin_directory"
staging_directory=$(mktemp -d "$data_parent/.wizz-install.XXXXXX")
trap 'rm -rf "$staging_directory"' EXIT

cp "$source_directory/build.js" "$staging_directory/"
cp -R "$source_directory/src" "$staging_directory/src"
mkdir -p "$staging_directory/scripts"
cp "$source_directory/scripts/cli.js" "$source_directory/scripts/dev.js" "$staging_directory/scripts/"

rm -rf "$data_directory"
mv "$staging_directory" "$data_directory"
trap - EXIT

cat > "$bin_directory/wizz" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "$data_directory/scripts/cli.js" "\$@"
EOF
chmod +x "$bin_directory/wizz"

printf 'Installed Wizz to %s\n' "$data_directory"
printf 'Command launcher: %s\n' "$bin_directory/wizz"
case ":$PATH:" in
  *":$bin_directory:"*) ;;
  *) printf 'Add %s to your PATH to run wizz from any directory.\n' "$bin_directory" ;;
esac