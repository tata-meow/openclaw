#!/usr/bin/env bash
set -e

VERSION="${1:-cojad-$(date +%Y.%-m.%-d)}"

echo "==> Building upstream OpenClaw image..."
docker build \
  -t openclaw:upstream \
  -f Dockerfile .

echo ""
echo "==> Building custom image: openclaw:${VERSION}"
docker build \
  --build-arg UPSTREAM_IMAGE=openclaw:upstream \
  --build-arg OPENCLAW_VERSION="${VERSION}" \
  -t "openclaw:${VERSION}" \
  -f Dockerfile.cojad .

# Also tag as latest cojad
docker tag "openclaw:${VERSION}" "openclaw:cojad"

echo ""
echo "Built successfully:"
echo "   - openclaw:${VERSION}"
echo "   - openclaw:cojad"
echo ""
echo "Environment variables set in image:"
echo "   OPENCLAW_BUNDLED_VERSION=${VERSION}"
