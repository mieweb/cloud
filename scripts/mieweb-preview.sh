# shellcheck shell=bash
# PREVIEW-ONLY helper: try PR builds of @mieweb/cli (published to GitHub
# Packages by .github/workflows/pr-preview.yml). Works like a Python venv:
# activate changes the current shell (and the project's .npmrc), deactivate
# puts everything back and deletes the temp dir holding your tokens.
# Delete this file once the @mieweb packages are released to npmjs.
#
# Requires: gh (logged in to github.com with read:packages), npx.
#
#   source scripts/mieweb-preview.sh
#   cd my-app                          # a project with mieweb.jsonc
#   mieweb_preview_activate [pr=15] [manager-url=https://manager.os.mieweb.org]
#   npm install && mieweb --target mieweb deploy
#   mieweb_preview_deactivate
#
# What activate sets up:
#   - ~/.npmrc is untouched; npm uses a temp userconfig with your gh token.
#   - NODE_AUTH_TOKEN (your gh token) for the project .npmrc below.
#   - The project's .npmrc gets the two lines npm needs to fetch @mieweb from
#     GitHub Packages, reading the token from ${NODE_AUTH_TOKEN}. The `mieweb`
#     command adds them to whichever project you run it in. Deploy syncs .npmrc
#     into the container, so `npm ci` there uses the same lines.
#   - MIEWEB_OS_SECRET_NODE_AUTH_TOKEN: the token the deployed container uses
#     (prompted). Use a classic PAT with ONLY read:packages, not your gh token:
#     it is stored in the container's environment on the Manager.
#   - MIEWEB_OS_URL / MIEWEB_OS_TOKEN (Manager API key, prompted).

_MWP_NPMRC_LINES='@mieweb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}'

# Add the preview lines to <dir>/.npmrc (dir = nearest mieweb.jsonc above $PWD),
# remembering the original so deactivate can restore it.
_mwp_project_npmrc() {
  local d="$PWD"
  while [ "$d" != / ] && [ ! -f "$d/mieweb.jsonc" ]; do d=$(dirname "$d"); done
  [ -f "$d/mieweb.jsonc" ] || return 0
  local f="$d/.npmrc"
  grep -qF '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' "$f" 2>/dev/null && return 0
  grep -qxF "$f" "$_MWP_DIR/npmrc-files" 2>/dev/null || {
    local n=1; [ -f "$_MWP_DIR/npmrc-files" ] && n=$(( $(wc -l < "$_MWP_DIR/npmrc-files") + 1 ))
    if [ -f "$f" ]; then cp -p -- "$f" "$_MWP_DIR/npmrc-orig.$n"; fi
    echo "$f" >> "$_MWP_DIR/npmrc-files"
  }
  { [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && echo; echo "# added by mieweb_preview_activate; removed on deactivate"; echo "$_MWP_NPMRC_LINES"; } >> "$f"
  echo "mieweb preview: added GitHub Packages lines to $f"
}

mieweb_preview_activate() {
  [ -n "${_MWP_ACTIVE:-}" ] && { echo "already active (pr${_MWP_PR})"; return 0; }
  local pr="${1:-15}" url="${2:-https://manager.os.mieweb.org}" tok
  tok=$(gh auth token -h github.com) || { echo "gh auth token failed"; return 1; }

  # Save previous values so deactivate restores them exactly.
  _MWP_OLD_USERCONFIG="${NPM_CONFIG_USERCONFIG-__unset__}"
  _MWP_OLD_CACHE="${npm_config_cache-__unset__}"
  _MWP_OLD_URL="${MIEWEB_OS_URL-__unset__}"
  _MWP_OLD_NAT="${NODE_AUTH_TOKEN-__unset__}"
  _MWP_OLD_SECRET="${MIEWEB_OS_SECRET_NODE_AUTH_TOKEN-__unset__}"
  _MWP_OLD_TOKEN="${MIEWEB_OS_TOKEN-__unset__}"
  _MWP_OLD_PS1="${PS1-}"

  _MWP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mieweb-preview.XXXXXX") || return 1
  chmod 700 "$_MWP_DIR"
  printf '@mieweb:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$tok" > "$_MWP_DIR/npmrc"
  chmod 600 "$_MWP_DIR/npmrc"

  export NPM_CONFIG_USERCONFIG="$_MWP_DIR/npmrc"
  export npm_config_cache="$_MWP_DIR/npm-cache"   # isolated npx cache, removed on deactivate
  export MIEWEB_OS_URL="$url"
  export NODE_AUTH_TOKEN="$tok"
  if [ -z "${MIEWEB_OS_TOKEN:-}" ]; then
    printf 'Manager API key for %s (blank to skip): ' "$url"
    read -rs MIEWEB_OS_TOKEN; echo
    if [ -n "$MIEWEB_OS_TOKEN" ]; then export MIEWEB_OS_TOKEN; else unset MIEWEB_OS_TOKEN; fi
  fi
  if [ -z "${MIEWEB_OS_SECRET_NODE_AUTH_TOKEN:-}" ]; then
    printf 'GitHub token for the deployed container (classic PAT, read:packages only; blank to skip): '
    read -rs MIEWEB_OS_SECRET_NODE_AUTH_TOKEN; echo
    if [ -n "$MIEWEB_OS_SECRET_NODE_AUTH_TOKEN" ]; then
      export MIEWEB_OS_SECRET_NODE_AUTH_TOKEN
    else
      unset MIEWEB_OS_SECRET_NODE_AUTH_TOKEN
      echo "mieweb preview: no container token; npm ci in the deployed app will get 401 from npm.pkg.github.com"
    fi
  fi

  _MWP_PR="$pr"; _MWP_ACTIVE=1
  _mwp_project_npmrc
  mieweb() { _mwp_project_npmrc; npx -y -p "@mieweb/cli@pr${_MWP_PR}" mieweb "$@"; }
  PS1="(mieweb-pr${pr}) ${PS1-}"
  echo "mieweb preview active: @mieweb/cli@pr${pr} -> ${url}  (mieweb_preview_deactivate to undo)"
}

mieweb_preview_deactivate() {
  [ -z "${_MWP_ACTIVE:-}" ] && { echo "not active"; return 0; }
  _mwp_restore() { if [ "$2" = "__unset__" ]; then unset "$1"; else export "$1=$2"; fi; }
  _mwp_restore NPM_CONFIG_USERCONFIG "$_MWP_OLD_USERCONFIG"
  _mwp_restore npm_config_cache "$_MWP_OLD_CACHE"
  _mwp_restore MIEWEB_OS_URL "$_MWP_OLD_URL"
  _mwp_restore NODE_AUTH_TOKEN "$_MWP_OLD_NAT"
  _mwp_restore MIEWEB_OS_SECRET_NODE_AUTH_TOKEN "$_MWP_OLD_SECRET"
  _mwp_restore MIEWEB_OS_TOKEN "$_MWP_OLD_TOKEN"
  PS1="$_MWP_OLD_PS1"

  # Put project .npmrc files back the way they were.
  local n=0 f
  if [ -f "$_MWP_DIR/npmrc-files" ]; then
    while IFS= read -r f; do
      n=$((n + 1))
      if [ -f "$_MWP_DIR/npmrc-orig.$n" ]; then mv -f -- "$_MWP_DIR/npmrc-orig.$n" "$f"; else rm -f -- "$f"; fi
      echo "mieweb preview: restored $f"
    done < "$_MWP_DIR/npmrc-files"
  fi

  case "$_MWP_DIR" in "${TMPDIR:-/tmp}"/mieweb-preview.*) rm -rf -- "$_MWP_DIR" ;; esac
  unset -f mieweb _mwp_restore
  unset _MWP_ACTIVE _MWP_PR _MWP_DIR _MWP_OLD_USERCONFIG _MWP_OLD_CACHE _MWP_OLD_URL _MWP_OLD_NAT \
    _MWP_OLD_SECRET _MWP_OLD_TOKEN _MWP_OLD_PS1
  echo "mieweb preview deactivated"
}
