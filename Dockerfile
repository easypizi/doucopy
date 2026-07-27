FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY relay/package.json relay/
COPY daemon/package.json daemon/
COPY cli/package.json cli/
RUN npm ci
COPY tsconfig.base.json ./
COPY relay ./relay
COPY daemon ./daemon
COPY cli ./cli
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "relay/dist/index.js"]
