#!/usr/bin/env bash
# scripts/build-docker.sh — Build SIDJUA Docker images (platform-specific, loadable)
#
# Usage:
#   ./scripts/build-docker.sh               # builds linux/amd64 + linux/arm64
#   ./scripts/build-docker.sh sidjua:1.2.3  # custom tag base
#   PLATFORMS=linux/amd64 ./scripts/build-docker.sh  # single platform
#
# Output:
#   sidjua-<version>-amd64.tar.gz   — loadable image archive (docker load)
#   sidjua-<version>-amd64.tar.gz.sha256
#   sidjua-<version>-arm64.tar.gz
#   sidjua-<version>-arm64.tar.gz.sha256
#
# See also: scripts/publish-docker.sh — builds and pushes multi-arch to GHCR
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
VCS_REF=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
BUILD_SIGNATURE=$(printf '%s:%s:%s:sidjua' "${BUILD_DATE}" "${VCS_REF}" "${VERSION}" \
  | sha256sum | cut -d' ' -f1)
# CI build counter — set by CI system (GitHub Actions: GITHUB_RUN_NUMBER, Jenkins: BUILD_NUMBER)
BUILD_NUMBER="${BUILD_NUMBER:-${GITHUB_RUN_NUMBER:-${CI_BUILD_NUMBER:-0}}}"

TAG_BASE="${1:-sidjua:${VERSION}}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

echo "Building SIDJUA ${VERSION}  ref=${VCS_REF}  date=${BUILD_DATE}"
echo "  Tag base:   ${TAG_BASE}"
echo "  Platforms:  ${PLATFORMS}"
echo "  Signature:  ${BUILD_SIGNATURE}"
echo ""

# Ensure a buildx builder with multi-arch support is active.
if ! docker buildx inspect multiarch &>/dev/null; then
  docker buildx create --name multiarch --driver docker-container --use
  docker buildx inspect --bootstrap
else
  docker buildx use multiarch
fi

# Common build args passed to every platform build
BUILD_ARGS=(
  --build-arg "BUILD_DATE=${BUILD_DATE}"
  --build-arg "VCS_REF=${VCS_REF}"
  --build-arg "VERSION=${VERSION}"
  --build-arg "BUILD_SIGNATURE=${BUILD_SIGNATURE}"
  --build-arg "BUILD_NUMBER=${BUILD_NUMBER}"
)

ARCHIVES=()

# Build each platform separately with --load so the image lands in the local daemon
IFS=',' read -ra PLATFORM_LIST <<< "${PLATFORMS}"
for PLATFORM in "${PLATFORM_LIST[@]}"; do
  # Normalise: linux/amd64 → amd64, linux/arm64 → arm64
  ARCH="${PLATFORM##*/}"
  ARCH_TAG="${TAG_BASE}-${ARCH}"
  ARCHIVE="sidjua-${VERSION}-${ARCH}.tar.gz"

  echo "→ Building ${PLATFORM} as ${ARCH_TAG} …"
  docker buildx build \
    --platform "${PLATFORM}" \
    "${BUILD_ARGS[@]}" \
    -t "${ARCH_TAG}" \
    --load \
    .

  echo "  Exporting to ${ARCHIVE} …"
  docker save "${ARCH_TAG}" | gzip -9 > "${ARCHIVE}"

  # SHA-256 checksum
  sha256sum "${ARCHIVE}" > "${ARCHIVE}.sha256"
  echo "  Checksum: $(cut -d' ' -f1 < "${ARCHIVE}.sha256")"

  ARCHIVES+=("${ARCHIVE}")
  echo ""
done

echo "Done. Archives:"
for A in "${ARCHIVES[@]}"; do
  echo "  ${A}  ($(du -h "${A}" | cut -f1))"
  echo "  ${A}.sha256"
done

echo ""
echo "Load into Docker:   docker load < sidjua-${VERSION}-amd64.tar.gz"
echo "Run loaded image:   docker run --rm -p 4200:4200 --security-opt no-new-privileges --cap-drop ALL sidjua:${VERSION}-amd64"
