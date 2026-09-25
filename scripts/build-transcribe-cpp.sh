#!/bin/sh
# Explicit local build for OpenCode Voice's preferred transcribe.cpp provider.
# Downloads no models. The CLI binary is installed at ~/.local/bin/transcribe-cli,
# which src/providers/transcribe-cpp.ts discovers automatically.
set -eu

SOURCE_DIR="${OPENCODE_VOICE_TRANSCRIBE_SOURCE_DIR:-$HOME/.local/share/opencode-voice/transcribe.cpp}"
BUILD_DIR="$SOURCE_DIR/build-opencode-voice"
PREFIX="${OPENCODE_VOICE_TRANSCRIBE_PREFIX:-$HOME/.local}"
REPO="https://github.com/handy-computer/transcribe.cpp"

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake is required to build transcribe.cpp" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required to build transcribe.cpp" >&2
  exit 1
fi

if [ ! -d "$SOURCE_DIR/.git" ]; then
  mkdir -p "$(dirname "$SOURCE_DIR")"
  git clone "$REPO" "$SOURCE_DIR"
fi

cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DTRANSCRIBE_METAL=ON \
  -DCMAKE_OSX_ARCHITECTURES=arm64

# Some Homebrew cmake builds on older macOS installations are x86_64-only and
# run under Rosetta. Native make still compiles the requested arm64 target.
if [ "$(uname -m)" = "arm64" ]; then
  (cd "$BUILD_DIR" && arch -arm64 /usr/bin/make transcribe-cli)
else
  cmake --build "$BUILD_DIR" --target transcribe-cli --config Release
fi

mkdir -p "$PREFIX/bin"
install -m 755 "$BUILD_DIR/bin/transcribe-cli" "$PREFIX/bin/transcribe-cli"

echo "Installed $PREFIX/bin/transcribe-cli"
"$PREFIX/bin/transcribe-cli" --list-devices
