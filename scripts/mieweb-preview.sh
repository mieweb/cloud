# shellcheck shell=bash
# PREVIEW-ONLY helper: try PR builds of @mieweb/cli (published to GitHub
# Packages by .github/workflows/pr-preview.yml) without touching ~/.npmrc.
# Works like a Python venv: activate sets env in the current shell, deactivate
# restores it and deletes the temp npmrc (holding your GitHub token) + npx cache.
# Delete this file once the @mieweb packages are released to npmjs.
#
# Requires: gh (logged in to github.com with read:packages), npx.
#
#   source scripts/mieweb-preview.sh
#   mieweb_preview_activate [pr=15] [manager-url=https://manager.os.mieweb.org]
#   mieweb --target mieweb whoami      # npx -p @mieweb/cli@pr<N> mieweb ...
#   mieweb_preview_deactivate

mieweb_preview_activate() {
  [ -n "${_MWP_ACTIVE:-}" ] && { echo "already active (pr${_MWP_PR})"; return 0; }
  local pr="${1:-15}" url="${2:-https://manager.os.mieweb.org}" tok
  tok=$(gh auth token -h github.com) || { echo "gh auth token failed"; return 1; }

  # Save previous values so deactivate restores them exactly.
  _MWP_OLD_USERCONFIG="${NPM_CONFIG_USERCONFIG-__unset__}"
  _MWP_OLD_CACHE="${npm_config_cache-__unset__}"
  _MWP_OLD_URL="${MIEWEB_OS_URL-__unset__}"
  _MWP_OLD_TOKEN="${MIEWEB_OS_TOKEN-__unset__}"
  _MWP_OLD_PS1="${PS1-}"

  _MWP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mieweb-preview.XXXXXX") || return 1
  chmod 700 "$_MWP_DIR"
  printf '@mieweb:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$tok" > "$_MWP_DIR/npmrc"
  chmod 600 "$_MWP_DIR/npmrc"

  export NPM_CONFIG_USERCONFIG="$_MWP_DIR/npmrc"
  export npm_config_cache="$_MWP_DIR/npm-cache"   # isolated npx cache, removed on deactivate
  export MIEWEB_OS_URL="$url"
  if [ -z "${MIEWEB_OS_TOKEN:-}" ]; then
    printf 'Manager API key for %s (blank to skip): ' "$url"
    read -rs MIEWEB_OS_TOKEN; echo
    if [ -n "$MIEWEB_OS_TOKEN" ]; then export MIEWEB_OS_TOKEN; else unset MIEWEB_OS_TOKEN; fi
  fi

  _MWP_PR="$pr"; _MWP_ACTIVE=1
  mieweb() { npx -y -p "@mieweb/cli@pr${_MWP_PR}" mieweb "$@"; }
  PS1="(mieweb-pr${pr}) ${PS1-}"
  echo "mieweb preview active: @mieweb/cli@pr${pr} -> ${url}  (mieweb_preview_deactivate to undo)"
}

mieweb_preview_deactivate() {
  [ -z "${_MWP_ACTIVE:-}" ] && { echo "not active"; return 0; }
  _mwp_restore() { if [ "$2" = "__unset__" ]; then unset "$1"; else export "$1=$2"; fi; }
  _mwp_restore NPM_CONFIG_USERCONFIG "$_MWP_OLD_USERCONFIG"
  _mwp_restore npm_config_cache "$_MWP_OLD_CACHE"
  _mwp_restore MIEWEB_OS_URL "$_MWP_OLD_URL"
  _mwp_restore MIEWEB_OS_TOKEN "$_MWP_OLD_TOKEN"
  PS1="$_MWP_OLD_PS1"
  case "$_MWP_DIR" in "${TMPDIR:-/tmp}"/mieweb-preview.*) rm -rf -- "$_MWP_DIR" ;; esac
  unset -f mieweb _mwp_restore
  unset _MWP_ACTIVE _MWP_PR _MWP_DIR _MWP_OLD_USERCONFIG _MWP_OLD_CACHE _MWP_OLD_URL _MWP_OLD_TOKEN _MWP_OLD_PS1
  echo "mieweb preview deactivated"
}
