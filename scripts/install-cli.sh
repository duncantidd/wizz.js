#!/usr/bin/env bash
# Wizz installer. Installs the wizz command from a release tarball (the
# distribution unit the release workflow attaches to GitHub Releases), from
# an explicit tarball, or — for development installs — from this working
# tree. The installed tree is self-contained: nothing registers with npm.
set -euo pipefail

# Overridable for testing the latest-release failure paths (WIZZ_INSTALL_REPOSITORY).
repository="${WIZZ_INSTALL_REPOSITORY:-duncantidd/wizz.js}"
# The API base is overridable for the same reason: a local test server can
# stand in for api.github.com offline. It doubles as the trust anchor for
# the download checks below — an asset URL may only be plain http:// when it
# points at this very host (mirroring releaseAssets.js validatedDownloadUrl).
api_base="${WIZZ_INSTALL_API_BASE:-https://api.github.com}"
# Host (with port) extracted once — the same-host exception below is
# host:port-exact, matching the URL .host comparison releaseAssets.js makes.
api_host=$(printf '%s' "$api_base" | sed -E 's#^[a-zA-Z]+://([^/?#]+).*#\1#')
# The $0 fallback keeps piped invocations (curl ... | bash) working: stdin
# scripts have no BASH_SOURCE, and under `set -u` referencing it would abort.
# source_directory only matters for --local installs from a working tree.
source_directory=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd) || source_directory=$(pwd)
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
  cp "$source_directory/scripts/cli.js" "$source_directory/scripts/dev.js" \
     "$source_directory/scripts/apiRoutes.js" \
     "$source_directory/scripts/mcp.js" "$source_directory/scripts/mcpProtocol.js" \
     "$source_directory/scripts/mcpTools.js" \
     "$source_directory/scripts/init.js" "$source_directory/scripts/initTemplates.js" \
     "$source_directory/scripts/releaseAssets.js" "$source_directory/scripts/update.js" \
     "$source_directory/scripts/installVscodeExtension.js" \
     "$staging_directory/scripts/"
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
    # curl -f delivers no body on a 4xx, so the lookup failure must be caught
    # here rather than left to crash the JSON parser below.
    if ! api_response=$(curl -fsSL --max-redirs 5 "$api_base/repos/$repository/releases/latest"); then
      printf 'Could not resolve the latest Wizz release from %s/repos/%s.\n' "$api_base" "$repository" >&2
      printf 'The repository may be private or have no published releases yet; pass a release tarball path or URL, or run with --local.\n' >&2
      exit 1
    fi
    # The parser prints two lines: the asset URL and its published sha256
    # digest (empty when the release predates the digest field). Splitting
    # here keeps one Node invocation for both values.
    asset_response=$(printf '%s' "$api_response" | node -e '
      let payload = "";
      process.stdin.on("data", (chunk) => { payload += chunk; });
      process.stdin.on("end", () => {
        let release;
        try {
          release = JSON.parse(payload);
        } catch {
          console.error("The GitHub API returned a response that is not valid JSON.");
          process.exit(1);
        }
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
        console.log(typeof asset.digest === "string" ? asset.digest : "");
      });
    ')
    asset_url=$(printf '%s\n' "$asset_response" | sed -n '1p')
    asset_digest=$(printf '%s\n' "$asset_response" | sed -n '2p')
    # The URL choke point releaseAssets.js enforces on the Node path, mirrored:
    # an asset URL must be https, or plain http on the API host itself (the
    # test seam). A hostile API response can never downgrade the download to
    # http:// on a third-party host.
    case "$asset_url" in
      https://*) ;;
      http://"$api_host"/*) ;;
      *)
        printf 'Refusing to download the release tarball from %s: only https:// URLs are allowed.\n' "$asset_url" >&2
        exit 1
        ;;
    esac
  elif [ "$install_mode" = "url" ]; then
    asset_url="$tarball_source"
    case "$asset_url" in
      https://*) ;;
      http://"$api_host"/*) ;;
      *)
        printf 'Refusing to download a tarball from %s: only https:// URLs are allowed.\n' "$asset_url" >&2
        exit 1
        ;;
    esac
  else
    if [ ! -f "$tarball_source" ]; then
      printf 'Tarball not found: %s\n' "$tarball_source" >&2
      exit 1
    fi
    cp "$tarball_source" "$staging_directory/wizz.tgz"
  fi

  if [ -n "${asset_url:-}" ]; then
    # Transport hardening, mirroring downloadToFile's manual-redirect rules:
    # https-only hops when the asset URL is https (so a redirect can never
    # walk the tarball through an http:// hop), a hard redirect cap, and a
    # final-URL re-check after the transfer (curl's own checks do not cover
    # the URL actually served from).
    download_flags=(-f -s -S --location --max-redirs 5)
    case "$asset_url" in
      https://*) download_flags+=(--proto '=https') ;;
    esac
    if ! effective_url=$(curl "${download_flags[@]}" -w '%{url_effective}' -o "$staging_directory/wizz.tgz" "$asset_url"); then
      printf 'Could not download the release tarball from %s.\n' "$asset_url" >&2
      exit 1
    fi
    case "$effective_url" in
      https://*) ;;
      http://"$api_host"/*) ;;
      *)
        printf 'Refusing to install a tarball served from %s: only https:// URLs are allowed.\n' "$effective_url" >&2
        exit 1
        ;;
    esac

    # Integrity gate, fail closed (the extracted tree is what the wizz
    # launcher executes). The digest comes from the API response, which is
    # reached over TLS, so it anchors the download against tampering,
    # truncation, and hostile redirects; an attacker who controls the API
    # response itself is beyond this check's reach. --latest requires the
    # digest; an explicit URL (no published digest to compare) relies on
    # the transport checks above.
    if [ -n "${asset_digest:-}" ]; then
      if ! printf '%s' "$asset_digest" | grep -Eq '^sha256:[0-9a-fA-F]{64}$'; then
        printf 'Refusing to install: the release publishes an unsupported digest (%s).\n' "$asset_digest" >&2
        exit 1
      fi
      if command -v sha256sum >/dev/null 2>&1; then
        actual_digest="sha256:$(sha256sum "$staging_directory/wizz.tgz" | cut -d ' ' -f 1)"
      elif command -v shasum >/dev/null 2>&1; then
        actual_digest="sha256:$(shasum -a 256 "$staging_directory/wizz.tgz" | cut -d ' ' -f 1)"
      else
        printf 'Verifying the release tarball requires sha256sum or shasum. Install one and run this installer again.\n' >&2
        exit 1
      fi
      if [ "$actual_digest" != "$asset_digest" ]; then
        printf 'The integrity check for the release tarball failed: the downloaded bytes do not match the digest the release published. The download may be tampered with, truncated, or stale; retry or download the release manually.\n' >&2
        exit 1
      fi
    elif [ "$install_mode" = "latest" ]; then
      printf 'The latest release carries no sha256 digest for the tarball; refusing to install unverified code. Download the release manually and pass the tarball path.\n' >&2
      exit 1
    fi
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
