#!/usr/bin/env bash
# build.sh — Render build script
# Installs Node deps + Java + apktool + AssetStudio CLI

set -e

echo "═══════════════════════════════════════════"
echo "  UnityRip — Render Build Script"
echo "═══════════════════════════════════════════"

# ── 1. Node dependencies ──────────────────────────────────────────────────────
echo ""
echo "▶ Installing Node.js dependencies..."
cd backend
npm install --production
cd ..

# ── 2. Tool directory ─────────────────────────────────────────────────────────
TOOL_DIR="/opt/unityrip"
mkdir -p "$TOOL_DIR"

# ── 3. Java (required for apktool) ────────────────────────────────────────────
echo ""
echo "▶ Checking Java..."
if ! command -v java &>/dev/null; then
  echo "  Installing OpenJDK 17..."
  apt-get update -qq && apt-get install -y -qq default-jre-headless
else
  echo "  Java found: $(java -version 2>&1 | head -1)"
fi

# ── 4. apktool ────────────────────────────────────────────────────────────────
APKTOOL_JAR="$TOOL_DIR/apktool.jar"
APKTOOL_VER="2.9.3"

if [ ! -f "$APKTOOL_JAR" ]; then
  echo ""
  echo "▶ Downloading apktool v${APKTOOL_VER}..."
  curl -fsSL \
    "https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VER}/apktool_${APKTOOL_VER}.jar" \
    -o "$APKTOOL_JAR"
  echo "  apktool downloaded ✓"
else
  echo "▶ apktool already present ✓"
fi

# ── 5. AssetStudio CLI ────────────────────────────────────────────────────────
# AssetStudio GUI is Windows-only. We use the open-source CLI fork:
#   https://github.com/Perfare/AssetStudio (has dotnet CLI mode)
# Alternative: AssetRipper CLI (cross-platform, more maintained)
#   https://github.com/AssetRipper/AssetRipper

ASSETRIP_DIR="$TOOL_DIR/AssetRipper"
ASSETRIP_BIN="$ASSETRIP_DIR/AssetRipper"
ASSETRIP_VER="0.3.4.0"

if [ ! -f "$ASSETRIP_BIN" ]; then
  echo ""
  echo "▶ Downloading AssetRipper CLI v${ASSETRIP_VER}..."

  # Detect architecture
  ARCH=$(uname -m)
  if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    ASSETRIP_ARCHIVE="AssetRipper_linux_arm64.tar.bz2"
  else
    ASSETRIP_ARCHIVE="AssetRipper_linux_x64.tar.bz2"
  fi

  DOWNLOAD_URL="https://github.com/AssetRipper/AssetRipper/releases/download/${ASSETRIP_VER}/${ASSETRIP_ARCHIVE}"

  mkdir -p "$ASSETRIP_DIR"
  curl -fsSL "$DOWNLOAD_URL" -o /tmp/assetrip.tar.bz2

  tar -xjf /tmp/assetrip.tar.bz2 -C "$ASSETRIP_DIR" --strip-components=1
  chmod +x "$ASSETRIP_BIN" 2>/dev/null || true

  rm -f /tmp/assetrip.tar.bz2
  echo "  AssetRipper downloaded ✓"
else
  echo "▶ AssetRipper already present ✓"
fi

# ── 6. Copy frontend into backend/public ─────────────────────────────────────
echo ""
echo "▶ Copying frontend to backend/public..."
mkdir -p backend/public
cp frontend/index.html backend/public/index.html
echo "  Frontend copied ✓"

# ── 7. Set env hints ─────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  Build complete! Set these env vars in Render:"
echo ""
echo "  APKTOOL_PATH      = $APKTOOL_JAR"
echo "  ASSETSTUDIO_PATH  = $ASSETRIP_BIN"
echo "  JAVA_BIN          = java"
echo "  PORT              = 3000 (auto-set by Render)"
echo "  ALLOWED_ORIGIN    = https://your-frontend-domain.com"
echo "═══════════════════════════════════════════"
