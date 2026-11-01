# syntax=docker/dockerfile:1
#
# SceneFork images. Build from the repo root (the frontend needs shared/ beside it).
# Two targets, one per half of the app:
#
#   docker build --target backend -t scenefork-backend .
#   docker build --target web     -t scenefork-web .
#
# `docker compose up --build` builds both and runs them (see docker-compose.yml and the README).

ARG NODE_VERSION=22
ARG PNPM_VERSION=12.15.0

# ------------------------------------------------------------------ frontend build
FROM node:${NODE_VERSION}-slim AS web-build
ARG PNPM_VERSION
# Where the browser finds the backend. It is baked into the build, so a different address
# needs a rebuild: docker build --target web --build-arg VITE_BACKEND_URL=https://api.example.com .
ARG VITE_BACKEND_URL=http://localhost:8000
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
COPY shared/ /app/shared/
# Typechecks, then builds the app and the physics and verifier workers.
RUN pnpm build

# ------------------------------------------------------------------ web: the built frontend, served as static files
FROM nginx:1.27-alpine AS web
COPY --from=web-build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q --spider http://127.0.0.1/ || exit 1

# ------------------------------------------------------------------ backend: FastAPI with uv
# This image already has uv and Python 3.12 (the project needs 3.12 or newer).
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS backend
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PATH="/app/backend/.venv/bin:${PATH}"
WORKDIR /app/backend
# Dependencies first, so editing the code does not reinstall them. The backend is an app, not a package.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/app ./app
COPY backend/scripts ./scripts
# The contracts both sides load (presets, schemas, plugin API). The backend finds them at ../shared.
COPY shared /app/shared
# The spend ledger and the response cache live here; compose mounts volumes over them.
RUN useradd --system --create-home --uid 10001 scenefork \
    && mkdir -p .spend .cache \
    && chown -R scenefork:scenefork .spend .cache
USER scenefork
EXPOSE 8000
# The first start imports OpenCV and NumPy cold and can take 30 s on a slow disk.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
# 0.0.0.0, or the published port is unreachable from outside the container.
CMD ["uvicorn", "app.asgi:app", "--host", "0.0.0.0", "--port", "8000"]
