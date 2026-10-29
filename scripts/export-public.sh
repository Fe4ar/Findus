#!/usr/bin/env bash
# Exports one release of the internal repo into the public repo: one commit and one tag per version,
# no internal history, neutral author. Pushing stays a separate, manual step.
# Usage: scripts/export-public.sh <git-ref> <version> --notes <notes.md> [<public-dir>]
#   notes.md: release notes in Markdown (### Added / ### Changed / ### Fixed), e.g. from findus-changelog.py notes
#   public-dir: default ~/findus-public (created with git init on first use)
set -euo pipefail
die() { echo "export-public: $*" >&2; exit 1; }
ref=${1:?usage: export-public.sh <git-ref> <version> --notes <notes.md> [<public-dir>]}; ver=${2:?version missing}
[[ ${3:-} == --notes && -f ${4:-} ]] || die "--notes <file> missing"
notes=$(realpath "$4"); out=${5:-$HOME/findus-public}
[[ $ver =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "version must be SemVer X.Y.Z[-pre], got $ver"
src=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
git -C "$src" rev-parse --verify -q "$ref^{commit}" >/dev/null || die "unknown ref $ref"

mkdir -p "$out"
[[ -d $out/.git ]] || git -C "$out" init -q -b main
git -C "$out" rev-parse -q --verify "refs/tags/v$ver" >/dev/null && die "v$ver already exists in $out"
[[ -z $(git -C "$out" status --porcelain) ]] || die "$out has uncommitted changes"

# Replace the whole tree with the exported one; CHANGELOG.md lives only in the public repo.
find "$out" -mindepth 1 -maxdepth 1 ! -name .git ! -name CHANGELOG.md -exec rm -rf {} +
git -C "$src" archive "$ref" | tar -x -C "$out"
sed -i -E "0,/\"version\": \"[^\"]*\"/s//\"version\": \"$ver\"/" "$out/frontend/package.json"
# README shows the version between <!--v--> markers
sed -i -E "s|(badge/version-).*(-orange)|\\1${ver//-/--}\\2|" "$out/README.md"  # shields.io escapes - as --
sed -i -E "s|(<!--v-->)[^<]*(<!--/v-->)|\\1$ver\\2|g" "$out/README.md"
log=$out/CHANGELOG.md
[[ -f $log ]] || printf "# Changelog\n\nAll notable changes, newest first. Versions follow [SemVer](https://semver.org).\n" > "$log"
{ sed -n "1,/semver\.org/p" "$log"; printf "\n## [%s] - %s\n\n" "$ver" "$(date +%F)"; cat "$notes"
  sed -n "/semver\.org/,\$p" "$log" | tail -n +2; } > "$log.tmp" && mv "$log.tmp" "$log"

"$src/scripts/check-public.sh" "$out" || die "public check failed, nothing committed (fix and run again after: git -C $out checkout -- . && git -C $out clean -fd)"
git -C "$out" add -A
git -C "$out" -c user.name="${PUBLIC_AUTHOR_NAME:-Findus}" -c user.email="${PUBLIC_AUTHOR_EMAIL:-findus@users.noreply.github.com}" \
  commit -q -m "Findus $ver"
git -C "$out" -c user.name="${PUBLIC_AUTHOR_NAME:-Findus}" -c user.email="${PUBLIC_AUTHOR_EMAIL:-findus@users.noreply.github.com}" \
  tag -a "v$ver" -m "Findus $ver"
echo "v$ver committed and tagged in $out (not pushed). Push: git -C $out push origin main v$ver"
