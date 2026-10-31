# Moje obec 2.0 — produkční obraz. Dvoufázový build: TypeScript se přeloží v první fázi,
# běhový obraz obsahuje jen dist/, produkční závislosti, šablony a statické soubory. Běží jako uživatel `node` (ne root).
FROM node:22-bookworm-slim AS build
# swagger-ui-dist táhne @scarf/scarf (telemetrie při instalaci) — vypnout
ENV SCARF_ANALYTICS=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# verze pro Administrace → Systém → Stav systému: --build-arg GIT_COMMIT=$(git rev-parse --short HEAD)
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
# curl = healthcheck; poppler-utils (pdftotext, pdftoppm, pdfinfo), tesseract-ocr s češtinou a angličtinou a antiword
# = text dokumentů pro vyhledávání (docs/HLEDANI-DOKUMENTY.md); OCR běží lokálně, žádná cloudová služba
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl poppler-utils tesseract-ocr tesseract-ocr-ces tesseract-ocr-eng antiword \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public
# veřejné balíky otázek kvízu (balíky obce se připojují zvenku, viz KVIZ_BALIKY)
COPY --chown=node:node kviz-otazky ./kviz-otazky
COPY --chown=node:node obec.example.yml ./obec.example.yml
COPY --chown=node:node DEVLOG.md ./DEVLOG.md
# data obce (nahrané soubory) — pojmenovaný volume převezme vlastníka této složky
RUN mkdir -p /app/data && chown node:node /app/data && date -u +%Y-%m-%dT%H:%M:%SZ > /app/build-cas.txt
ENV DATA_DIR=/app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/index.js"]
