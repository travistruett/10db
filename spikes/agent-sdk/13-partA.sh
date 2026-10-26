#!/bin/bash
# Spike 13 Part A: does the Seatbelt sandbox stop reads of protected files, however they are spelled?
#
# Everything checked for contents is a canary with a random token made here and removed on exit:
#   ~/.10db-spike13-canary/ (two files), a login-Keychain item "10db-spike13-canary", a temp work dir.
# Real credential paths are probed for size or entry count only; their contents are never printed.
# Commands run under Anthropic's sandbox runtime (srt), the library Claude Code's Bash sandbox is built on,
# with the deny list a lane would get. No model is involved.
#
# Run:  bash spikes/agent-sdk/13-partA.sh   (results go to spikes/agent-sdk/out/13-partA/)
set -u

SRT_VERSION=0.0.81
RES="${SPIKE13_RESULTS:-$(cd "$(dirname "$0")" && pwd)/out/13-partA}"
CANARY_DIR="$HOME/.10db-spike13-canary"
KC_SERVICE=10db-spike13-canary
LC_LABEL=com.10db.spike13
WORK=$(mktemp -d "${TMPDIR:-/tmp}/spike13-work.XXXXXX")
TOOLS=$(mktemp -d "${TMPDIR:-/tmp}/spike13-tools.XXXXXX")
export CANARY_DIR WORK

cleanup() {
  launchctl remove "$LC_LABEL" 2>/dev/null
  rm -rf "$CANARY_DIR" "$WORK" "$TOOLS" "$HOME/.10db-spike13-write-probe"
  security delete-generic-password -s "$KC_SERVICE" >/dev/null 2>&1
  local left=""
  [ -e "$CANARY_DIR" ] && left="$left canary-dir"
  security find-generic-password -s "$KC_SERVICE" >/dev/null 2>&1 && left="$left keychain-item"
  echo "cleanup: ${left:-everything removed}" | tee -a "$RES/summary.txt"
}
trap cleanup EXIT

rm -rf "$RES" && mkdir -p "$RES"
# srt needs ripgrep on PATH. Without a system copy, use the one built into the claude binary.
if ! command -v rg >/dev/null; then
  CLAUDE_BIN=$(readlink -f "$(command -v claude)")
  [ -x "$CLAUDE_BIN" ] || { echo "srt needs ripgrep on PATH: brew install ripgrep"; exit 1; }
  mkdir -p "$TOOLS/bin"
  printf '#!/bin/bash\nexec -a rg "%s" "$@"\n' "$CLAUDE_BIN" > "$TOOLS/bin/rg" && chmod +x "$TOOLS/bin/rg"
  export PATH="$TOOLS/bin:$PATH"
  echo "using claude's built-in ripgrep: $(rg --version | head -1)"
fi

echo "Installing @anthropic-ai/sandbox-runtime@$SRT_VERSION into a temp dir..."
npm install --silent --no-audit --no-fund --prefix "$TOOLS" "@anthropic-ai/sandbox-runtime@$SRT_VERSION" >/dev/null 2>&1 \
  || { echo "npm install failed"; exit 1; }
SRT="$TOOLS/node_modules/.bin/srt"

T1=$(openssl rand -hex 16); T2=$(openssl rand -hex 16); T3=$(openssl rand -hex 16)
mkdir -p "$CANARY_DIR/claude"
printf 'canary %s\n' "$T1" > "$CANARY_DIR/secret.txt"
printf '{"canary":"%s"}\n' "$T2" > "$CANARY_DIR/claude/.claude.json"
security add-generic-password -U -s "$KC_SERVICE" -a spike -w "$T3" >/dev/null

settings() { # $1 file, $2... extra denyRead entries; every file denies the canary dir and writes only to "."
  local deny="\"$CANARY_DIR\""
  shift_file=$1; shift
  for p in "$@"; do deny="$deny, \"$p\""; done
  printf '{"filesystem":{"denyRead":[%s],"allowWrite":["."],"denyWrite":[]},"network":{"allowedDomains":[],"deniedDomains":[]}}\n' \
    "$deny" > "$shift_file"
}
LANE="$HOME/.claude.json\", \"$HOME/.claude\", \"$HOME/Library/Keychains\", \"$HOME/Library/Application Support/10db"
S_LANE="$TOOLS/lane.json";     settings "$S_LANE" "$LANE"
S_NOKC="$TOOLS/no-kc.json";    settings "$S_NOKC" "$HOME/.claude.json" "$HOME/.claude"
S_SECBIN="$TOOLS/sec-bin.json"; settings "$S_SECBIN" "$LANE" /usr/bin/security

leaks() { grep -qF -e "$T1" -e "$T2" -e "$T3" "$1"; }

# check <id> <expect: hold|leak|ok|denied> <settings file or "none"> <command>
check() {
  local id=$1 expect=$2 s=$3 cmd=$4 out="$RES/$1.txt" code verdict
  if [ "$s" = none ]; then (cd "$WORK" && /bin/bash -c "$cmd") >"$out" 2>&1
  else (cd "$WORK" && "$SRT" --settings "$s" -- /bin/bash -c "$cmd") >"$out" 2>&1; fi
  code=$?
  case $expect in
    hold) if leaks "$out"; then verdict="FAIL (canary leaked)"; else verdict="pass (held)"; fi ;;
    leak) if leaks "$out"; then verdict="pass (control: readable)"; else verdict="FAIL (control did not read)"; fi ;;
    ok) if [ $code -eq 0 ]; then verdict="pass (ran)"; else verdict="FAIL (exit $code)"; fi ;;
    denied) if [ $code -ne 0 ]; then verdict="pass (refused, exit $code)"; else verdict="FAIL (allowed)"; fi ;;
  esac
  printf '%-14s %-26s exit=%-3s %s\n' "$id" "$verdict" "$code" "$cmd" | tee -a "$RES/summary.txt"
}

echo "== smoke" | tee "$RES/summary.txt"
check smoke ok "$S_LANE" 'echo srt-ok'
grep -q srt-ok "$RES/smoke.txt" || { echo "srt did not run a command; see $RES/smoke.txt"; exit 1; }

echo "== controls" | tee -a "$RES/summary.txt"
check c-unsandboxed leak none 'cat "$CANARY_DIR/secret.txt"'
check c-direct      hold "$S_LANE" 'cat "$CANARY_DIR/secret.txt"'
check c-write-cwd   ok   "$S_LANE" 'echo x > ./w && cat ./w'
check c-write-home  denied "$S_LANE" 'touch "$HOME/.10db-spike13-write-probe"'

echo "== canary battery (every row must hold)" | tee -a "$RES/summary.txt"
check f-head      hold "$S_LANE" 'head -c 200 "$CANARY_DIR/secret.txt"'
check f-nested    hold "$S_LANE" 'cat "$CANARY_DIR/claude/.claude.json"'
check f-cp-cwd    hold "$S_LANE" 'cp "$CANARY_DIR/secret.txt" ./c1; cat ./c1'
check f-cp-clone  hold "$S_LANE" 'cp -c "$CANARY_DIR/secret.txt" ./c2; cat ./c2'
check f-dd        hold "$S_LANE" 'dd if="$CANARY_DIR/secret.txt" 2>/dev/null'
check f-tar       hold "$S_LANE" 'tar cf - -C "$HOME" .10db-spike13-canary | tar xOf -'
check f-zip       hold "$S_LANE" 'zip -qr ./z.zip "$CANARY_DIR"; unzip -p ./z.zip'
check f-ditto     hold "$S_LANE" 'ditto "$CANARY_DIR" ./d; cat ./d/secret.txt'
check f-rsync     hold "$S_LANE" 'rsync -a "$CANARY_DIR/" ./r/; cat ./r/secret.txt'
check f-subst     hold "$S_LANE" '(cd "$HOME" && echo "$(cat .10db-spike13-canary/secret.txt)")'
check f-glob      hold "$S_LANE" 'cat "$HOME"/.10db-spike13*/secret.txt'
check f-find-exec hold "$S_LANE" 'find "$CANARY_DIR" -type f -exec cat {} +'
check f-grep-r    hold "$S_LANE" 'grep -r . "$CANARY_DIR"'
check f-python    hold "$S_LANE" 'python3 -c "import os;print(open(os.environ[\"CANARY_DIR\"]+\"/secret.txt\").read())"'
check f-node      hold "$S_LANE" 'node -e "console.log(require(\"fs\").readFileSync(process.env.CANARY_DIR+\"/secret.txt\",\"utf8\"))"'
check f-perl      hold "$S_LANE" 'perl -ne print "$CANARY_DIR/secret.txt"'
check f-osascript hold "$S_LANE" 'osascript -e "read POSIX file \"$CANARY_DIR/secret.txt\""'
check f-symlink   hold "$S_LANE" 'ln -s "$CANARY_DIR/secret.txt" ./sl; cat ./sl'
check f-hardlink  hold "$S_LANE" 'ln "$CANARY_DIR/secret.txt" ./hl; cat ./hl'
check f-case      hold "$S_LANE" 'cat "$HOME/.10DB-SPIKE13-CANARY/SECRET.TXT"'
check f-dots      hold "$S_LANE" 'cat "$HOME/./.10db-spike13-canary//secret.txt"'
check f-dotdot    hold "$S_LANE" 'cat "$HOME/../$(basename "$HOME")/.10db-spike13-canary/secret.txt"'
check f-firmlink  hold "$S_LANE" 'cat "/System/Volumes/Data$HOME/.10db-spike13-canary/secret.txt"'
check f-vol       hold "$S_LANE" 'set -- $(stat -f "%d %i" "$CANARY_DIR/secret.txt"); cat "/.vol/$1/$2"'
# A launchd job doesn't inherit the submitter's env, so its paths are expanded here.
check f-launchctl hold "$S_LANE" "launchctl submit -l $LC_LABEL -- /bin/sh -c 'cat \"$CANARY_DIR/secret.txt\" > \"$WORK/lc.txt\"'; sleep 2; cat ./lc.txt"
sleep 1; if [ -f "$WORK/lc.txt" ] && leaks "$WORK/lc.txt"; then
  echo "f-launchctl    FAIL (a launchd job outside the sandbox wrote the canary into the work dir)" | tee -a "$RES/summary.txt"
fi
launchctl remove "$LC_LABEL" 2>/dev/null

echo "== real protected paths (size or count only, never contents)" | tee -a "$RES/summary.txt"
check r-claude-json denied "$S_LANE" 'wc -c < "$HOME/.claude.json"'
check r-claude-dir  denied "$S_LANE" 'ls "$HOME/.claude" | wc -l; exit ${PIPESTATUS[0]}'
check r-keychains   denied "$S_LANE" 'wc -c < "$HOME/Library/Keychains/login.keychain-db"'
check r-10db-data   ok     "$S_LANE" 'ls "$HOME/Library/Application Support/10db" 2>&1 | wc -l'

echo "== keychain" | tee -a "$RES/summary.txt"
check k-unsandboxed  leak none        'security find-generic-password -s 10db-spike13-canary -w'
check k-lane         hold "$S_LANE"   'security find-generic-password -s 10db-spike13-canary -w'
check k-no-kc-deny   hold "$S_NOKC"   'security find-generic-password -s 10db-spike13-canary -w'
check k-deny-binary  hold "$S_SECBIN" 'security find-generic-password -s 10db-spike13-canary -w'
check k-dump-lines   hold "$S_LANE"   'security dump-keychain 2>&1 | wc -l'

echo
echo "Done. Summary: $RES/summary.txt (per-check output beside it). Rows marked FAIL are the findings."
