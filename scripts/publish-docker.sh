#!/usr/bin/env bash
# scripts/publish-docker.sh — Build and push multi-arch SIDJUA image to GHCR
#
# Usage:
#   ./scripts/publish-docker.sh                                           # push as ghcr.io/goetzkohlberg/sidjua:<version>
#   ./scripts/publish-docker.sh ghcr.io/goetzkohlberg/sidjua:1.0.2       # custom full tag
#   REGISTRY=ghcr.io/goetzkohlberg PLATFORMS=linux/amd64 ./scripts/publish-docker.sh  # single platform
#
# Prerequisites:
#   docker login ghcr.io   (or set GITHUB_TOKEN env var)
set -euo pipefail

cd "$(dirname "$0")/.."

REGISTRY="${REGISTRY:-ghcr.io/goetzkohlberg}"
IMAGE_NAME="${IMAGE_NAME:-sidjua}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
VCS_REF=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
BUILD_SIGNATURE=$(printf '%s:%s:%s:sidjua' "${BUILD_DATE}" "${VCS_REF}" "${VERSION}" \
  | sha256sum | cut -d' ' -f1)
BUILD_NUMBER="${BUILD_NUMBER:-${GITHUB_RUN_NUMBER:-${CI_BUILD_NUMBER:-0}}}"

# Allow caller to pass a full tag as first argument (e.g. ghcr.io/goetzkohlberg/sidjua:1.0.2)
if [[ -n "${1:-}" ]]; then
  FULL_TAG="${1}"
  # Extract registry/image from the provided tag if possible
  TAG_REGISTRY="${FULL_TAG%/*}"
  LATEST_TAG="${TAG_REGISTRY}/${IMAGE_NAME}:latest"
else
  FULL_TAG="${REGISTRY}/${IMAGE_NAME}:${VERSION}"
  LATEST_TAG="${REGISTRY}/${IMAGE_NAME}:latest"
fi

echo "Publishing SIDJUA ${VERSION}  ref=${VCS_REF}  date=${BUILD_DATE}"
echo "  Tag:        ${FULL_TAG}"
echo "  Latest:     ${LATEST_TAG}"
echo "  Platforms:  ${PLATFORMS}"
echo "  Signature:  ${BUILD_SIGNATURE}"
echo ""

# ---------------------------------------------------------------------------
# Auth check — fail early with a helpful message
# ---------------------------------------------------------------------------
echo "Checking registry authentication…"
AUTH_CHECK=$(docker buildx imagetools inspect "${REGISTRY}/${IMAGE_NAME}:__auth_check__" 2>&1 || true)
if echo "${AUTH_CHECK}" | grep -qi "unauthorized\|denied\|credential\|login"; then
  echo "ERROR: Not logged in to ${REGISTRY}."
  echo "  Run: docker login ghcr.io"
  echo "  Or set GITHUB_TOKEN and run:"
  echo "    echo \"\${GITHUB_TOKEN}\" | docker login ghcr.io -u \$(git config user.email) --password-stdin"
  exit 1
fi
echo "  Auth OK (or registry not yet populated — proceeding)"
echo ""

# ---------------------------------------------------------------------------
# Ensure a buildx builder with multi-arch support is active
# ---------------------------------------------------------------------------
if ! docker buildx inspect multiarch &>/dev/null; then
  docker buildx create --name multiarch --driver docker-container --use
  docker buildx inspect --bootstrap
else
  docker buildx use multiarch
fi

# ---------------------------------------------------------------------------
# Build and push in a single command — buildx creates an OCI image index
# (manifest list) automatically when --push is combined with multiple platforms
# ---------------------------------------------------------------------------
BUILD_ARGS=(
  --build-arg "BUILD_DATE=${BUILD_DATE}"
  --build-arg "VCS_REF=${VCS_REF}"
  --build-arg "VERSION=${VERSION}"
  --build-arg "BUILD_SIGNATURE=${BUILD_SIGNATURE}"
  --build-arg "BUILD_NUMBER=${BUILD_NUMBER}"
)

echo "Building and pushing multi-arch image…"
docker buildx build \
  --platform "${PLATFORMS}" \
  "${BUILD_ARGS[@]}" \
  -t "${FULL_TAG}" \
  -t "${LATEST_TAG}" \
  --push \
  .

echo ""
echo "Push complete. Verifying manifest…"
echo ""

# ---------------------------------------------------------------------------
# Verify — print the manifest list so both architectures are visible
# ---------------------------------------------------------------------------
MANIFEST=$(docker buildx imagetools inspect "${FULL_TAG}" 2>&1)
echo "${MANIFEST}"
echo ""

MISSING=()
if ! echo "${MANIFEST}" | grep -q "linux/amd64"; then
  MISSING+=("linux/amd64")
fi
if ! echo "${MANIFEST}" | grep -q "linux/arm64"; then
  MISSING+=("linux/arm64")
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "WARNING: The following platform(s) are missing from the manifest: ${MISSING[*]}"
  echo "  Check PLATFORMS env var and builder configuration."
  exit 1
fi

echo "Manifest verified: both linux/amd64 and linux/arm64 present."
echo ""
echo "Summary"
echo "  Tag:       ${FULL_TAG}"
echo "  Latest:    ${LATEST_TAG}"
echo "  Platforms: ${PLATFORMS}"
echo ""
echo "Pull (auto-selects native arch):"
echo "  docker pull ${FULL_TAG}"
